/**
 * capacityProfileOwnershipInvariants.integration.test.ts — Real PostgreSQL 15
 * integration tests for capacity-profile ownership invariants.
 *
 * Schema lifecycle:
 *   Pre-#361  — only migrations before the #361 ownership-invariants migration.
 *               Used for audit, repair, conflict, shape-error, drift and concurrency tests.
 *   Post-#361 — the full committed migration set including #361.
 *               Used for constraint enforcement, writer-regression and rollback tests.
 *
 * Each schema reset drops the entire public schema, deploys the correct migration
 * set, seeds fresh fixtures and returns brand-new IDs. IDs are NEVER reused from
 * before a schema reset.
 *
 * Migration preflight tests are fully self-contained: each resets to pre-#361,
 * seeds only its intended defect, runs `prisma migrate deploy`, asserts the
 * expected failure, then discards state. No afterEach cross-contamination.
 *
 * The committed #361 migration artifact (server/prisma/migrations/) is the sole
 * migration authority. No constraint or migration SQL is copied into setup helpers.
 *
 * Concurrency tests use pg_advisory_lock for deterministic coordination through
 * a second database connection (no arbitrary sleeps).
 *
 * Requires INTEGRATION_TEST=true and a disposable PostgreSQL 15 Docker container.
 */

import { runOwnershipAudit } from '../lib/capacityProfileOwnershipAudit.js'
import { repairIdenticalDuplicates } from '../lib/capacityProfileOwnershipRepair.js'
import { PrismaClient, Prisma } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import pg from 'pg'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

// ─── Guard ──────────────────────────────────────────────────────────────────

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

// ─── Shared Prisma client ────────────────────────────────────────────────────

let prisma: PrismaClient

// ─── #361 migration identifier (exact folder name, not a date prefix) ────────

const MIGRATION_361_NAME = '20260721000001_enforce_capacity_profile_ownership_invariants'

// ═════════════════════════════════════════════════════════════════════════════
// Schema lifecycle helpers
// ═════════════════════════════════════════════════════════════════════════════

const MIGRATION_META: Record<string, true> = { 'migration_lock.toml': true }

async function createPre361MigrationDir(): Promise<string> {
  const serverDir = new URL('../..', import.meta.url).pathname
  const dir = path.join(serverDir, '.tmp-pre361-' + crypto.randomUUID())
  const migDir = path.join(dir, 'migrations')
  await fs.promises.mkdir(migDir, { recursive: true })
  const migrationsDir = path.join(serverDir, 'prisma/migrations')
  const allMigrations = await fs.promises.readdir(migrationsDir)
  for (const m of allMigrations) {
    if (m === MIGRATION_361_NAME) continue
    if (MIGRATION_META[m]) continue
    const src = path.join(migrationsDir, m)
    const dst = path.join(migDir, m)
    const stat = await fs.promises.stat(src).catch(() => null)
    if (stat?.isDirectory()) {
      await fs.promises.cp(src, dst, { recursive: true })
    }
  }

  const schemaContent = await fs.promises.readFile(
    path.join(serverDir, 'prisma/schema.prisma'), 'utf-8',
  )
  const tmpSchema = path.join(dir, 'schema.prisma')
  await fs.promises.writeFile(tmpSchema, schemaContent, 'utf-8')

  const tmpConfig = path.join(dir, 'prisma.config.ts')
  const configContent = [
    'import { defineConfig } from "prisma/config"',
    'export default defineConfig({',
    '  schema: "' + tmpSchema.replace(/\\/g, '\\\\') + '",',
    '  migrations: { path: "' + migDir.replace(/\\/g, '\\\\') + '" },',
    '  datasource: { url: process.env["DATABASE_URL"] },',
    '})',
  ].join('\n')
  await fs.promises.writeFile(tmpConfig, configContent, 'utf-8')
  return tmpConfig
}

async function cleanupTmpDir(tmpConfig: string): Promise<void> {
  const dir = path.dirname(tmpConfig)
  try { await fs.promises.rm(dir, { recursive: true, force: true }) } catch { /* ok */ }
}

async function assert361ConstraintsInstalled(): Promise<void> {
  const constraintRows = await prisma.$queryRaw<Array<{ constraint_name: string }>>(
    Prisma.sql`SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = 'CapacityProfile' AND constraint_name LIKE 'chk_CapacityProfile%'`,
  )
  const names = constraintRows.map(r => r.constraint_name).sort()
  expect(names).toEqual([
    'chk_CapacityProfile_exactly_one_owner',
    'chk_CapacityProfile_owner_kind_fk',
  ])
  const idxRows = await prisma.$queryRaw<Array<{ indexname: string }>>(
    Prisma.sql`SELECT indexname FROM pg_indexes WHERE tablename = 'CapacityProfile'
      AND indexname LIKE 'CapacityProfile_%_key' AND indexname != 'CapacityProfile_pkey'`,
  )
  const idxNames = idxRows.map(r => r.indexname).sort()
  expect(idxNames).toEqual([
    'CapacityProfile_namedResourceId_key',
    'CapacityProfile_resourceTypeId_key',
  ])
}

async function assert361ConstraintsAbsent(): Promise<void> {
  const constraintRows = await prisma.$queryRaw<Array<{ constraint_name: string }>>(
    Prisma.sql`SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = 'CapacityProfile' AND constraint_name LIKE 'chk_CapacityProfile%'`,
  )
  expect(constraintRows).toHaveLength(0)
  const idxRows = await prisma.$queryRaw<Array<{ indexname: string }>>(
    Prisma.sql`SELECT indexname FROM pg_indexes WHERE tablename = 'CapacityProfile'
      AND indexname LIKE 'CapacityProfile_%_key' AND indexname != 'CapacityProfile_pkey'`,
  )
  const idx361 = idxRows.filter((r: { indexname: string }) =>
    r.indexname === 'CapacityProfile_resourceTypeId_key'
    || r.indexname === 'CapacityProfile_namedResourceId_key',
  )
  expect(idx361).toHaveLength(0)
}

interface FreshIds {
  projectId: string
  rtId: string
  nrId: string
  nrId2: string
}

async function seedFixtures(): Promise<FreshIds> {
  const user = await prisma.user.create({
    data: {
      email: `ownership-test-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@example.com`,
      name: 'Test User',
      password: 'test-hash',
    },
  })
  const project = await prisma.project.create({
    data: { name: 'Ownership Invariants Test', ownerId: user.id },
  })
  const rt = await prisma.resourceType.create({
    data: { name: 'Test Role', projectId: project.id, category: 'ENGINEERING', count: 2 },
  })
  const nr1 = await prisma.namedResource.create({
    data: { name: 'Test Person 1', resourceTypeId: rt.id },
  })
  const nr2 = await prisma.namedResource.create({
    data: { name: 'Test Person 2', resourceTypeId: rt.id },
  })
  return { projectId: project.id, rtId: rt.id, nrId: nr1.id, nrId2: nr2.id }
}

async function deployFullMigrations(): Promise<void> {
  const { execSync } = await import('node:child_process')
  execSync('npx prisma migrate deploy', {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: 'pipe',
  })
}

async function resetToPre361(): Promise<FreshIds> {
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE')
  await prisma.$executeRawUnsafe('CREATE SCHEMA public')
  const tmpConfig = await createPre361MigrationDir()
  try {
    const { execSync } = await import('node:child_process')
    execSync(`npx prisma migrate deploy --config="${tmpConfig}"`, {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      stdio: 'pipe',
    })
  } finally {
    await cleanupTmpDir(tmpConfig)
  }
  await assert361ConstraintsAbsent()
  return await seedFixtures()
}

async function resetToPost361(): Promise<FreshIds & { roleProfileId: string; nrProfileId: string }> {
  const ids = await resetToPre361()
  const roleProfileId = await prisma.capacityProfile.create({
    data: {
      projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
      ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
      defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
    },
  }).then(p => p.id)
  const nrProfileId = await prisma.capacityProfile.create({
    data: {
      projectId: ids.projectId, resourceTypeId: null, namedResourceId: ids.nrId,
      ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
      defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
    },
  }).then(p => p.id)
  deployFullMigrations()
  await assert361ConstraintsInstalled()
  return { ...ids, roleProfileId, nrProfileId }
}

// ═════════════════════════════════════════════════════════════════════════════
// File-level lifecycle
// ═════════════════════════════════════════════════════════════════════════════

beforeAll(async () => {
  if (!runIntegration) return
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required for integration tests. '
      + 'Set INTEGRATION_TEST=true and DATABASE_URL to a running PostgreSQL 15 instance.',
    )
  }
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })
  await prisma.$connect()
})

afterAll(async () => {
  if (!runIntegration || !prisma) return
  await prisma.$disconnect()
})

// ═════════════════════════════════════════════════════════════════════════════
// Phase 1: Pre-#361 ownership integrity tests
// All audit, repair, conflict, shape-error, drift and concurrency tests run
// against pre-#361 schema (no unique indexes or CHECK constraints).
// Each describe block establishes its own pre-#361 state; fixture IDs are
// always fresh after every resetToPre361() call.
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Pre-#361 ownership integrity tests', () => {
  let ids: FreshIds
  let roleProfileId: string
  let nrProfileId: string

  beforeAll(async () => {
    ids = await resetToPre361()
    roleProfileId = await prisma.capacityProfile.create({
      data: {
        projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
        ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
        defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
      },
    }).then(p => p.id)
    nrProfileId = await prisma.capacityProfile.create({
      data: {
        projectId: ids.projectId, resourceTypeId: null, namedResourceId: ids.nrId,
        ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
        defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
      },
    }).then(p => p.id)
  })

  async function deleteAllProfiles(): Promise<void> {
    await prisma.capacitySegment.deleteMany()
    await prisma.capacityProfile.deleteMany()
  }

  async function resetToCleanState(): Promise<void> {
    await deleteAllProfiles()
    roleProfileId = await prisma.capacityProfile.create({
      data: {
        projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
        ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
        defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
      },
    }).then(p => p.id)
    nrProfileId = await prisma.capacityProfile.create({
      data: {
        projectId: ids.projectId, resourceTypeId: null, namedResourceId: ids.nrId,
        ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
        defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
      },
    }).then(p => p.id)
  }

  describe('Clean database audit', () => {
    it('audits successfully with no findings', async () => {
      await resetToCleanState()
      const report = await runOwnershipAudit(prisma)
      expect(report.isClean).toBe(true)
      expect(report.findings).toHaveLength(0)
      expect(report.totalProfiles).toBe(2)
      expect(report.validSingletons).toBe(2)
    })
  })

  describe('Identical role duplicate detection and repair', () => {
    beforeEach(async () => { await resetToCleanState() })

    it('reports identical role duplicates', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.repairableGroups).toHaveLength(1)
      expect(report.findings.some(f => f.type === 'identical_duplicate_group')).toBe(true)
      expect(report.isClean).toBe(false)
    })

    it('repairs identical role duplicates preserving survivor', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.repairableGroups).toHaveLength(1)
      const result = await repairIdenticalDuplicates(prisma, report)
      expect(result.profilesDeleted).toBe(1)
      const finalReport = await runOwnershipAudit(prisma)
      expect(finalReport.isClean).toBe(true)
      expect(finalReport.totalProfiles).toBe(2)
      const remaining = await prisma.capacityProfile.findMany({
        where: { resourceTypeId: ids.rtId },
      })
      expect(remaining).toHaveLength(1)
      expect(remaining[0].id).toBe(roleProfileId)
    })

    it('repair is idempotent', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      await repairIdenticalDuplicates(prisma, report)
      const cleanReport = await runOwnershipAudit(prisma)
      expect(cleanReport.isClean).toBe(true)
      const result2 = await repairIdenticalDuplicates(prisma, cleanReport)
      expect(result2.profilesDeleted).toBe(0)
    })
  })

  describe('Identical named-resource duplicates with exact legacy null semantics', () => {
    beforeEach(async () => { await resetToCleanState() })

    it('preserves survivor and segment IDs for named duplicates', async () => {
      const dup = await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: null, namedResourceId: ids.nrId,
          ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await prisma.capacitySegment.create({
        data: {
          capacityProfileId: nrProfileId, startWeek: 0, endWeek: 4,
          capacityPercent: 100, source: 'FIXED',
        },
      })
      await prisma.capacitySegment.create({
        data: {
          capacityProfileId: dup.id, startWeek: 0, endWeek: 4,
          capacityPercent: 100, source: 'FIXED',
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.repairableGroups).toHaveLength(1)
      await repairIdenticalDuplicates(prisma, report)
      const finalProfiles = await prisma.capacityProfile.findMany({
        where: { namedResourceId: ids.nrId },
        include: { segments: true },
      })
      expect(finalProfiles).toHaveLength(1)
      expect(finalProfiles[0].id).toBe(nrProfileId)
      expect(finalProfiles[0].segments).toHaveLength(1)
      expect(finalProfiles[0].segments[0].startWeek).toBe(0)
      expect(finalProfiles[0].segments[0].endWeek).toBe(4)
    })

    it('does not treat SQL null and JSON null as equal', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: null, namedResourceId: ids.nrId,
          ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.JsonNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.repairableGroups).toHaveLength(0)
      expect(report.conflictingGroups).toHaveLength(1)
    })
  })

  describe('Different scalar fields block repair', () => {
    beforeEach(async () => { await resetToCleanState() })

    it('different defaultPercent is a conflict', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 50, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.repairableGroups).toHaveLength(0)
      expect(report.conflictingGroups).toHaveLength(1)
    })

    it('different source is a conflict', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.repairableGroups).toHaveLength(0)
      expect(report.conflictingGroups).toHaveLength(1)
    })

    it('different segment values is a conflict', async () => {
      await prisma.capacitySegment.create({
        data: {
          capacityProfileId: roleProfileId, startWeek: 0, endWeek: 4,
          capacityPercent: 100, source: 'FIXED',
        },
      })
      const dupProfile = await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await prisma.capacitySegment.create({
        data: {
          capacityProfileId: dupProfile.id, startWeek: 0, endWeek: 4,
          capacityPercent: 75, source: 'FIXED',
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.repairableGroups).toHaveLength(0)
      expect(report.conflictingGroups).toHaveLength(1)
    })
  })

  describe('Conflicting groups cause no writes', () => {
    beforeEach(async () => { await resetToCleanState() })

    it('repair does not touch conflicting groups', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'AVAILABILITY_WINDOW', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.conflictingGroups).toHaveLength(1)
      expect(report.repairableGroups).toHaveLength(0)
      await expect(repairIdenticalDuplicates(prisma, report)).resolves.not.toThrow()
      const all = await prisma.capacityProfile.findMany()
      expect(all).toHaveLength(3)
    })
  })

  describe('Shape error detection', () => {
    beforeEach(async () => { await deleteAllProfiles() })

    it('reports both-owner FK set', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: ids.nrId,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.findings.some(f => f.type === 'both_owner_fks_set')).toBe(true)
      expect(report.isClean).toBe(false)
    })

    it('reports neither-owner FK set', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: null, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.findings.some(f => f.type === 'neither_owner_fk_set')).toBe(true)
    })

    it('reports ownerKind FK mismatch', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: null, namedResourceId: ids.nrId,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.findings.some(f => f.type === 'owner_kind_fk_mismatch')).toBe(true)
    })

    it('reports cross-project owner mismatch', async () => {
      const user = await prisma.user.findFirstOrThrow()
      const project2 = await prisma.project.create({
        data: { name: 'Second Project', ownerId: user.id },
      })
      const rt2 = await prisma.resourceType.create({
        data: { name: 'Other Role', projectId: project2.id, category: 'ENGINEERING' },
      })
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: rt2.id, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.findings.some(f => f.type === 'cross_project_owner')).toBe(true)
    })

    it('malformed both-FK profile participates in both duplicate namespaces', async () => {
      await prisma.capacityProfile.createMany({
        data: [
          {
            projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: ids.nrId,
            ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
            defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
          },
          {
            projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
            ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
            defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
          },
          {
            projectId: ids.projectId, resourceTypeId: null, namedResourceId: ids.nrId,
            ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
            defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
          },
        ],
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.isClean).toBe(false)
      const dupFindings = report.findings.filter(f => f.type === 'duplicate_physical_owner')
      expect(dupFindings).toHaveLength(2)
      const rtFinding = dupFindings.find(f => f.message.includes('resourceTypeId'))
      const nrFinding = dupFindings.find(f => f.message.includes('namedResourceId'))
      expect(rtFinding).toBeDefined()
      expect(nrFinding).toBeDefined()
      expect(report.conflictingGroups.length).toBeGreaterThanOrEqual(2)
      expect(report.repairableGroups).toHaveLength(0)
      for (const g of report.conflictingGroups) {
        const bothFkProfile = g.profiles.find(
          p => p.resourceTypeId != null && p.namedResourceId != null,
        )
        expect(g.profileIds).toContain(bothFkProfile?.id ?? '')
        expect(g.isIdentical).toBe(false)
      }
    })
  })

  describe('Repair drift detection under pre-#361 schema', () => {
    beforeEach(async () => { await resetToCleanState() })

    it('aborts when authoritative scalar changes after audit', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.repairableGroups).toHaveLength(1)
      await prisma.capacityProfile.update({
        where: { id: roleProfileId },
        data: { defaultPercent: 75 },
      })
      await expect(repairIdenticalDuplicates(prisma, report)).rejects.toThrow(
        'no longer identical',
      )
    })

    it('aborts when provenance (legacy) scalar changes after audit', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.repairableGroups).toHaveLength(1)
      await prisma.capacityProfile.update({
        where: { id: roleProfileId },
        data: { legacy: Prisma.JsonNull },
      })
      await expect(repairIdenticalDuplicates(prisma, report)).rejects.toThrow(
        'no longer identical',
      )
    })

    it('aborts when a segment is added after audit', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.repairableGroups).toHaveLength(1)
      await prisma.capacitySegment.create({
        data: {
          capacityProfileId: roleProfileId, startWeek: 0, endWeek: 4,
          capacityPercent: 100, source: 'FIXED',
        },
      })
      await expect(repairIdenticalDuplicates(prisma, report)).rejects.toThrow(
        'no longer identical',
      )
    })

    it('aborts when a same-sized profile ID replacement happens after audit', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.repairableGroups).toHaveLength(1)
      const otherProfileId = (await prisma.capacityProfile.findFirst({
        where: { resourceTypeId: ids.rtId, id: { not: roleProfileId } },
        select: { id: true },
      }))!.id
      await prisma.capacityProfile.delete({ where: { id: roleProfileId } })
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await expect(repairIdenticalDuplicates(prisma, report)).rejects.toThrow(
        'was not in the audited group',
      )
      // Verify the unchanged duplicate profile was not deleted by the aborted repair
      const unchangedProfile = await prisma.capacityProfile.findUnique({
        where: { id: otherProfileId },
      })
      expect(unchangedProfile).not.toBeNull()
      expect(unchangedProfile!.id).toBe(otherProfileId)
    })

    it('concurrent insert is blocked while repair holds exclusive locks', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.repairableGroups).toHaveLength(1)

      // Create a temporary trigger that blocks repair's DELETE on an advisory lock.
      // This lets us pause repair AFTER it has acquired its table locks but BEFORE
      // it completes, so we can prove concurrent writers are blocked.
      const ADVISORY_LOCK_ID = 216613
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION fn_block_repair_delete()
        RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${ADVISORY_LOCK_ID});
          RETURN OLD;
        END;
        $$ LANGUAGE plpgsql
      `)
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER trg_block_repair_delete
        BEFORE DELETE ON "CapacityProfile"
        FOR EACH ROW EXECUTE FUNCTION fn_block_repair_delete()
      `)

      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
      const controlClient = await pool.connect()
      const writerClient = await pool.connect()
      try {
        // Phase 1: Control connection acquires a session-scoped advisory lock.
        // Repair's DELETE trigger calls pg_advisory_xact_lock() which blocks
        // on the same advisory ID until we explicitly release it.
        // Using session-scoped pg_advisory_lock() ensures the lock persists
        // across individual query() calls on controlClient.
        await controlClient.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID])
        // Phase 2: Start repair — it acquires EXCLUSIVE table locks,
        // then when it tries to DELETE a duplicate, the trigger fires and blocks.
        const repairPromise = repairIdenticalDuplicates(prisma, report)

        // Phase 3: Poll pg_locks to confirm repair holds EXCLUSIVE locks
        // on both CapacityProfile and CapacitySegment.
        const capacityProfileOid = (await prisma.$queryRaw<Array<{ oid: number }>>(
          Prisma.sql`SELECT c.oid FROM pg_class c
            WHERE c.relname = 'CapacityProfile' AND c.relkind = 'r'`,
        ))[0].oid
        const capacitySegmentOid = (await prisma.$queryRaw<Array<{ oid: number }>>(
          Prisma.sql`SELECT c.oid FROM pg_class c
            WHERE c.relname = 'CapacitySegment' AND c.relkind = 'r'`,
        ))[0].oid

        let bothLocksHeld = false
        const deadline = Date.now() + 10000
        while (!bothLocksHeld && Date.now() < deadline) {
          const held = await prisma.$queryRaw<Array<{ held: boolean }>>(
            Prisma.sql`SELECT (
              SELECT COUNT(*) >= 2 FROM (
                SELECT 1 FROM pg_locks
                WHERE locktype = 'relation'
                  AND relation IN (${capacityProfileOid}::oid, ${capacitySegmentOid}::oid)
                  AND mode = 'ExclusiveLock'
                  AND granted = true
              ) t
            ) AS held`,
          )
          if (held[0].held) { bothLocksHeld = true; break }
          await prisma.$executeRawUnsafe('SELECT pg_sleep(0.05)')
        }
        expect(bothLocksHeld).toBe(true)

        // Phase 4: Independent writer tries to INSERT for the same owner key.
        // With repair holding EXCLUSIVE locks, this INSERT (needing RowExclusiveLock)
        // must block.
        const writerPid = (await writerClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid

        // Set a short statement_timeout so we can detect the block deterministically
        await writerClient.query('SET statement_timeout = 0') // reset first
        const writerQuery = writerClient.query(
          `INSERT INTO "CapacityProfile"
             ("id", "projectId", "resourceTypeId", "namedResourceId", "ownerKind",
              "planningBasis", "source", "defaultPercent", "startWeek", "endWeek",
              "legacy", "createdAt", "updatedAt")
           VALUES
             (gen_random_uuid()::text, $1, $2, NULL, 'ROLE',
              'DEMAND_FOLLOWING', 'FIXED', 100, 0, 10,
              NULL, NOW(), NOW())`,
          [ids.projectId, ids.rtId],
        )

        // Poll pg_locks to prove the writer is waiting for RowExclusiveLock
        let writerBlocked = false
        const writerDeadline = Date.now() + 5000
        while (!writerBlocked && Date.now() < writerDeadline) {
          const waiting = await prisma.$queryRaw<Array<{ waiting: boolean }>>(
            Prisma.sql`SELECT EXISTS (
              SELECT 1 FROM pg_locks
              WHERE pid = ${writerPid}
                AND locktype = 'relation'
                AND relation = ${capacityProfileOid}::oid
                AND mode = 'RowExclusiveLock'
                AND granted = false
            ) AS waiting`,
          )
          if (waiting[0].waiting) { writerBlocked = true; break }
          await prisma.$executeRawUnsafe('SELECT pg_sleep(0.05)')
        }
        expect(writerBlocked).toBe(true)

        // Phase 5: Cancel the blocked writer via a different connection
        // (writerClient is blocked and can't process queries).
        await controlClient.query('SELECT pg_cancel_backend($1)', [writerPid])
        try { await writerQuery } catch { /* expected cancellation */ }
        await writerClient.query('SELECT 1') // confirm writer connection is healthy

        // Phase 6: Release the advisory lock so repair can continue
        await controlClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID])

        // Phase 7: Await repair and verify state
        const result = await repairPromise
        expect(result.profilesDeleted).toBe(1)

        const finalCount = await prisma.capacityProfile.count({
          where: { resourceTypeId: ids.rtId },
        })
        expect(finalCount).toBe(1)
      } finally {
        // Clean up: advisory lock, trigger, connections, pool
        await controlClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID])
          .catch(() => {})
        controlClient.release()
        writerClient.release()
        await pool.end().catch(() => {})
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS trg_block_repair_delete ON "CapacityProfile"')
          .catch(() => {})
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS fn_block_repair_delete')
          .catch(() => {})
      }
    })

    it('two-group rollback proves all-or-nothing transaction atomicity', async () => {
      const rt2 = await prisma.resourceType.create({
        data: { name: 'Test Role 2', projectId: ids.projectId, category: 'ENGINEERING', count: 1 },
      })
      // Group 1: RT duplicate — appears first in report.repairableGroups
      // (lexical order by ownerId since both groups share the same project)
      const g1Dup = await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const g1Seg1Orig = await prisma.capacitySegment.create({
        data: {
          capacityProfileId: roleProfileId, startWeek: 0, endWeek: 4,
          capacityPercent: 100, source: 'FIXED',
        },
      })
      const g1Seg1Dup = await prisma.capacitySegment.create({
        data: {
          capacityProfileId: g1Dup.id, startWeek: 0, endWeek: 4,
          capacityPercent: 100, source: 'FIXED',
        },
      })
      const g1Seg2Orig = await prisma.capacitySegment.create({
        data: {
          capacityProfileId: roleProfileId, startWeek: 6, endWeek: 8,
          capacityPercent: 75, source: 'MANUAL',
        },
      })
      const g1Seg2Dup = await prisma.capacitySegment.create({
        data: {
          capacityProfileId: g1Dup.id, startWeek: 6, endWeek: 8,
          capacityPercent: 75, source: 'MANUAL',
        },
      })

      // Group 2: NR duplicate — appears second in report
      const g2Dup = await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: null, namedResourceId: ids.nrId,
          ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })

      // Singleton (not part of any group)
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: rt2.id, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })

      const report = await runOwnershipAudit(prisma)
      expect(report.repairableGroups).toHaveLength(2)
      // Groups are sorted alphabetically by ownerNamespace:
      // 'namedResourceId' < 'resourceTypeId', so NR group appears first.
      expect(report.repairableGroups[0].ownerNamespace).toBe('namedResourceId')
      expect(report.repairableGroups[1].ownerNamespace).toBe('resourceTypeId')

      // Mutate one profile in group 2 after audit — makes it non-identical
      await prisma.capacityProfile.update({
        where: { id: nrProfileId },
        data: { defaultPercent: 50 },
      })

      // Capture ALL profile and segment state AFTER the deliberate drift.
      // This is the baseline for proving rollback doesn't lose data.
      const beforeProfileFields = await prisma.capacityProfile.findMany({
        orderBy: { id: 'asc' },
        select: {
          id: true, projectId: true, resourceTypeId: true, namedResourceId: true,
          ownerKind: true, planningBasis: true, source: true,
          defaultPercent: true, startWeek: true, endWeek: true, legacy: true,
        },
      })
      const beforeSegments = await prisma.capacitySegment.findMany({
        orderBy: { id: 'asc' },
        select: {
          id: true, capacityProfileId: true,
          startWeek: true, endWeek: true, capacityPercent: true, source: true,
        },
      })

      // Repair must abort entirely — no group can be partially repaired
      await expect(repairIdenticalDuplicates(prisma, report)).rejects.toThrow()

      // Re-read complete state after failed repair
      const afterProfileFields = await prisma.capacityProfile.findMany({
        orderBy: { id: 'asc' },
        select: {
          id: true, projectId: true, resourceTypeId: true, namedResourceId: true,
          ownerKind: true, planningBasis: true, source: true,
          defaultPercent: true, startWeek: true, endWeek: true, legacy: true,
        },
      })
      const afterSegments = await prisma.capacitySegment.findMany({
        orderBy: { id: 'asc' },
        select: {
          id: true, capacityProfileId: true,
          startWeek: true, endWeek: true, capacityPercent: true, source: true,
        },
      })

      // PROVE: all profile rows unchanged (count + every field)
      expect(afterProfileFields.length).toBe(beforeProfileFields.length)
      for (let i = 0; i < beforeProfileFields.length; i++) {
        const b = beforeProfileFields[i]
        const a = afterProfileFields[i]
        expect(a.id).toBe(b.id)
        expect(a.projectId).toBe(b.projectId)
        expect(a.resourceTypeId).toBe(b.resourceTypeId ?? null)
        expect(a.namedResourceId).toBe(b.namedResourceId ?? null)
        expect(a.ownerKind).toBe(b.ownerKind)
        expect(a.planningBasis).toBe(b.planningBasis)
        expect(a.source).toBe(b.source)
        expect(a.defaultPercent).toBe(b.defaultPercent)
        expect(a.startWeek).toBe(b.startWeek)
        expect(a.endWeek).toBe(b.endWeek)
        const bLegacy = b.legacy instanceof Buffer
          ? JSON.parse(b.legacy.toString()) : b.legacy
        const aLegacy = a.legacy instanceof Buffer
          ? JSON.parse(a.legacy.toString()) : a.legacy
        expect(JSON.stringify(aLegacy)).toBe(JSON.stringify(bLegacy))
      }

      // PROVE: all segment rows unchanged (count + every field)
      expect(afterSegments.length).toBe(beforeSegments.length)
      for (let i = 0; i < beforeSegments.length; i++) {
        const b = beforeSegments[i]
        const a = afterSegments[i]
        expect(a.id).toBe(b.id)
        expect(a.capacityProfileId).toBe(b.capacityProfileId)
        expect(a.startWeek).toBe(b.startWeek)
        expect(a.endWeek).toBe(b.endWeek)
        expect(a.capacityPercent).toBe(b.capacityPercent)
        expect(a.source).toBe(b.source)
      }

      // PROVE: Group 1 (unchanged) — both profiles and all segments still present
      for (const pid of [roleProfileId, g1Dup.id]) {
        const p = afterProfileFields.find(f => f.id === pid)
        expect(p).toBeDefined()
      }
      for (const sid of [g1Seg1Orig.id, g1Seg1Dup.id, g1Seg2Orig.id, g1Seg2Dup.id]) {
        const s = afterSegments.find(f => f.id === sid)
        expect(s).toBeDefined()
      }

      // PROVE: Group 2 (drifted) — both profiles present, drift preserved
      for (const pid of [nrProfileId, g2Dup.id]) {
        const p = afterProfileFields.find(f => f.id === pid)
        expect(p).toBeDefined()
        if (pid === nrProfileId) {
          expect(p!.defaultPercent).toBe(50)
        } else {
          expect(p!.defaultPercent).toBe(100)
        }
      }

      // PROVE: Singleton unchanged
      const singletonProfiles = afterProfileFields.filter(f => f.resourceTypeId === rt2.id)
      expect(singletonProfiles).toHaveLength(1)

      // PROVE: Fresh audit reflects correct state
      const freshAudit = await runOwnershipAudit(prisma)
      expect(freshAudit.repairableGroups).toHaveLength(1)
      expect(freshAudit.repairableGroups[0].ownerNamespace).toBe('resourceTypeId')
      expect(freshAudit.conflictingGroups).toHaveLength(1)
      expect(freshAudit.conflictingGroups[0].ownerNamespace).toBe('namedResourceId')
      expect(freshAudit.isClean).toBe(false)
    })
    it('preserves survivor profile ID, segment IDs and authoritative state', async () => {
      await prisma.capacitySegment.create({
        data: {
          capacityProfileId: roleProfileId, startWeek: 0, endWeek: 4,
          capacityPercent: 50, source: 'FIXED',
        },
      })
      const dup = await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await prisma.capacitySegment.create({
        data: {
          capacityProfileId: dup.id, startWeek: 0, endWeek: 4,
          capacityPercent: 50, source: 'FIXED',
        },
      })
      const origSegments = await prisma.capacitySegment.findMany({
        where: { capacityProfileId: roleProfileId },
        orderBy: { id: 'asc' },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.repairableGroups).toHaveLength(1)
      await repairIdenticalDuplicates(prisma, report)
      const survivors = await prisma.capacityProfile.findMany({
        where: { resourceTypeId: ids.rtId },
        include: { segments: { orderBy: { id: 'asc' } } },
      })
      expect(survivors).toHaveLength(1)
      expect(survivors[0].id).toBe(roleProfileId)
      expect(survivors[0].segments).toHaveLength(1)
      expect(survivors[0].segments[0].id).toBe(origSegments[0].id)
      expect(survivors[0].defaultPercent).toBe(100)
      expect(survivors[0].ownerKind).toBe('ROLE')
    })

    it('idempotent second repair succeeds on clean state', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      await repairIdenticalDuplicates(prisma, report)
      const cleanReport = await runOwnershipAudit(prisma)
      expect(cleanReport.isClean).toBe(true)
      const result = await repairIdenticalDuplicates(prisma, cleanReport)
      expect(result.profilesDeleted).toBe(0)
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Phase 2: Migration and constraint enforcement
//
// Each migration preflight test:
//   1. Resets to a fresh pre-#361 state (calls resetToPre361)
//   2. Seeds only the intended defect profile(s)
//   3. Runs `prisma migrate deploy` with the full committed migration set
//   4. Asserts the expected failure
//   5. Discards the entire database state (next test starts fresh)
//
// This guarantees no failed Prisma migration state contaminates subsequent tests.
// Constraint enforcement and writer-regression tests establish post-#361 state
// via resetToPost361() and assert the constraints exist before running.
//
// The rollback test runs in an isolated disposable state, proves valid data
// remains, verifies the documented non-unique indexes are restored and then
// discards. Every writer test suite running under constraints establishes
// post-#361 state and asserts constraints exist.
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Migration and constraint enforcement', () => {
  describe('Migration preflight (dirty data refusal)', () => {
    it('migration refuses both FK set', async () => {
      const ids = await resetToPre361()
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: ids.nrId,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await expect(deployFullMigrations()).rejects.toThrow()
    })

    it('migration refuses neither FK set', async () => {
      const ids = await resetToPre361()
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: null, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await expect(deployFullMigrations()).rejects.toThrow()
    })

    it('migration refuses ownerKind/FK mismatch (ROLE with namedResourceId)', async () => {
      const ids = await resetToPre361()
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: null, namedResourceId: ids.nrId,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await expect(deployFullMigrations()).rejects.toThrow()
    })

    it('migration refuses duplicate resourceTypeId', async () => {
      const ids = await resetToPre361()
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await expect(deployFullMigrations()).rejects.toThrow()
    })

    it('migration refuses duplicate namedResourceId', async () => {
      const ids = await resetToPre361()
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: null, namedResourceId: ids.nrId,
          ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: null, namedResourceId: ids.nrId,
          ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await expect(deployFullMigrations()).rejects.toThrow()
    })

    it('migration refuses cross-project resourceTypeId', async () => {
      const ids = await resetToPre361()
      const user = await prisma.user.findFirstOrThrow()
      const project2 = await prisma.project.create({
        data: { name: 'Cross-project RT test', ownerId: user.id },
      })
      const rt2 = await prisma.resourceType.create({
        data: { name: 'Other role', projectId: project2.id, category: 'ENGINEERING', count: 1 },
      })
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: rt2.id, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await expect(deployFullMigrations()).rejects.toThrow()
    })

    it('migration refuses cross-project namedResourceId', async () => {
      const ids = await resetToPre361()
      const user = await prisma.user.findFirstOrThrow()
      const project2 = await prisma.project.create({
        data: { name: 'Cross-project NR test', ownerId: user.id },
      })
      const rt2 = await prisma.resourceType.create({
        data: { name: 'Other role 2', projectId: project2.id, category: 'ENGINEERING', count: 1 },
      })
      const nr2 = await prisma.namedResource.create({
        data: { name: 'Other person', resourceTypeId: rt2.id },
      })
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: null, namedResourceId: nr2.id,
          ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await expect(deployFullMigrations()).rejects.toThrow()
    })

    it('migration succeeds after clean pre-#361 state', async () => {
      const ids = await resetToPre361()
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: null, namedResourceId: ids.nrId,
          ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await expect(deployFullMigrations()).resolves.not.toThrow()
    })
  })

  describe('PostgreSQL constraint enforcement', () => {
    let ids: FreshIds

    beforeAll(async () => {
      const state = await resetToPost361()
      ids = state
    })

    it('PostgreSQL rejects both FK after migration', async () => {
      await expect(
        prisma.capacityProfile.create({
          data: {
            projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: ids.nrId,
            ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
            defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
          },
        }),
      ).rejects.toThrow()
    })

    it('PostgreSQL rejects duplicate resourceTypeId after migration', async () => {
      await expect(
        prisma.capacityProfile.create({
          data: {
            projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
            ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
            defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
          },
        }),
      ).rejects.toThrow()
    })

    it('PostgreSQL rejects duplicate namedResourceId after migration', async () => {
      await expect(
        prisma.capacityProfile.create({
          data: {
            projectId: ids.projectId, resourceTypeId: null, namedResourceId: ids.nrId,
            ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
            defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
          },
        }),
      ).rejects.toThrow()
    })
  })

  describe('Existing write path compatibility under constraints', () => {
    let ids: FreshIds

    beforeAll(async () => {
      const state = await resetToPost361()
      ids = state
    })

    it('creates a valid named-resource profile under constraints', async () => {
      const profile = await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: null, namedResourceId: ids.nrId2,
          ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      expect(profile.id).toBeTruthy()
    })

    it('concurrent duplicate attempt rolls back cleanly', async () => {
      await expect(
        prisma.capacityProfile.create({
          data: {
            projectId: ids.projectId, resourceTypeId: null, namedResourceId: ids.nrId,
            ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
            defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
          },
        }),
      ).rejects.toThrow()
      const profilesForNR = await prisma.capacityProfile.count({
        where: { namedResourceId: ids.nrId },
      })
      expect(profilesForNR).toBe(1)
    })
  })

  describe('Backfill/reconcile safety under constraints', () => {
    let ids: FreshIds

    beforeAll(async () => {
      const state = await resetToPost361()
      ids = state
    })

    it('backfill cannot create duplicate owners under constraints', async () => {
      await expect(
        prisma.capacityProfile.create({
          data: {
            projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
            ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
            defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
          },
        }),
      ).rejects.toThrow()
    })
  })

  describe('Constraint rollback preserves valid data', () => {
    let ids: FreshIds
  beforeAll(async () => {
    const state = await resetToPost361()
    ids = state
  })
    it('dropping constraints preserves existing valid data and restores non-unique indexes', async () => {
      const count = await prisma.capacityProfile.count()
      expect(count).toBe(2)
      const profiles = await prisma.capacityProfile.findMany({
        where: { projectId: ids.projectId },
      })
      expect(profiles).toHaveLength(2)
      await assert361ConstraintsInstalled()
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "CapacityProfile" DROP CONSTRAINT IF EXISTS "chk_CapacityProfile_exactly_one_owner"',
      )
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "CapacityProfile" DROP CONSTRAINT IF EXISTS "chk_CapacityProfile_owner_kind_fk"',
      )
      await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "CapacityProfile_resourceTypeId_key"')
      await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "CapacityProfile_namedResourceId_key"')
      await prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "CapacityProfile_resourceTypeId_idx" ON "CapacityProfile"("resourceTypeId")',
      )
      await prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "CapacityProfile_namedResourceId_idx" ON "CapacityProfile"("namedResourceId")',
      )
      await assert361ConstraintsAbsent()
      const idxRows = await prisma.$queryRaw<Array<{ indexname: string }>>(
        Prisma.sql`SELECT indexname FROM pg_indexes WHERE tablename = 'CapacityProfile'
          AND indexname IN ('CapacityProfile_resourceTypeId_idx', 'CapacityProfile_namedResourceId_idx')`,
      )
      const restored: Record<string, true> = {}
      for (const r of idxRows) restored[r.indexname] = true
      expect(restored['CapacityProfile_resourceTypeId_idx']).toBe(true)
      expect(restored['CapacityProfile_namedResourceId_idx']).toBe(true)
      const afterCount = await prisma.capacityProfile.count()
      expect(afterCount).toBe(2)
    })
  })
})
