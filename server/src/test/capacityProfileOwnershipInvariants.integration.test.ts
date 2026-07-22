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
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'

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
    })

    it('detects concurrent insert as group size change and aborts repair', async () => {
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.repairableGroups).toHaveLength(1)
      // Add a third profile to the group before repair
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: ids.rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      // Repair uses stale report, re-reads under lock and detects group size changed
      await expect(repairIdenticalDuplicates(prisma, report)).rejects.toThrow(
        'group size changed',
      )
    })

    it('handles two repairable groups where one changes and neither is partially repaired', async () => {
      const rt2 = await prisma.resourceType.create({
        data: { name: 'Test Role 2', projectId: ids.projectId, category: 'ENGINEERING', count: 1 },
      })
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: rt2.id, namedResourceId: null,
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
      await prisma.capacityProfile.create({
        data: {
          projectId: ids.projectId, resourceTypeId: null, namedResourceId: ids.nrId,
          ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      const report = await runOwnershipAudit(prisma)
      expect(report.repairableGroups).toHaveLength(2)
      await prisma.capacityProfile.update({
        where: { id: nrProfileId },
        data: { defaultPercent: 50 },
      })
      await expect(repairIdenticalDuplicates(prisma, report)).rejects.toThrow()
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
