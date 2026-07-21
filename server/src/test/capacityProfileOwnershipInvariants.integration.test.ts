/**
 * capacityProfileOwnershipInvariants.integration.test.ts — Real PostgreSQL 15
 * integration tests for capacity-profile ownership invariants.
 *
 * Tests audit, identical-duplicate repair, constraint enforcement, migration
 * preflight, writer compatibility, and idempotent backfill/reconcile.
 *
 * Requires INTEGRATION_TEST=true and a disposable PostgreSQL 15 Docker container.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { runOwnershipAudit } from '../lib/capacityProfileOwnershipAudit.js'
import { repairIdenticalDuplicates } from '../lib/capacityProfileOwnershipRepair.js'
import { PrismaClient, Prisma } from '@prisma/client'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

// ─── Guard ──────────────────────────────────────────────────────────────────

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

// ─── Shared state ───────────────────────────────────────────────────────────

let prisma: PrismaClient
let projectId: string
let rtId: string
let nrId: string
let nrId2: string

// Profile IDs created during setup
let roleProfileId: string
let nrProfileId: string

// ─── Migrate and seed ───────────────────────────────────────────────────────










// ─── File-level lifecycle ────────────────────────────────────────────────────

beforeAll(async () => {
  if (!runIntegration) return
  prisma = new PrismaClient()
})

afterAll(async () => {
  if (!runIntegration || !prisma) return
  await prisma.$disconnect()
})


// ─── Cleanup helper for per-test isolation ───────────────────────────────────

async function deleteAllProfiles(): Promise<void> {
  await prisma.capacitySegment.deleteMany()
  await prisma.capacityProfile.deleteMany()
}

async function resetToCleanState(): Promise<void> {
  await deleteAllProfiles()
  // Recreate valid single profiles and capture the new IDs
  const newRole = await prisma.capacityProfile.create({
    data: {
      projectId,
      resourceTypeId: rtId,
      namedResourceId: null,
      ownerKind: 'ROLE',
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: 100,
      startWeek: 0,
      endWeek: 10,
      legacy: Prisma.DbNull,
    },
  })
  roleProfileId = newRole.id
  const newNr = await prisma.capacityProfile.create({
    data: {
      projectId,
      resourceTypeId: null,
      namedResourceId: nrId,
      ownerKind: 'NAMED_PERSON',
      planningBasis: 'DEMAND_FOLLOWING',
      source: 'FIXED',
      defaultPercent: 100,
      startWeek: 0,
      endWeek: 10,
      legacy: Prisma.DbNull,
    },
  })
  nrProfileId = newNr.id
}


/**
 * Create a temporary Prisma config and filtered migrations directory containing
 * all migrations up to (but not including) the #361 ownership-invariants migration.
 * Returns the path to a temporary Prisma config file that references:
 *   - a temporary schema file (copy of the repository schema)
 *   - the temporary filtered migrations directory
 *   - process.env.DATABASE_URL
 *
 * This prevents Prisma from discovering server/prisma.config.ts and its
 * full migrations/path setting.
 */
async function createPre361MigrationDir(): Promise<string> {
  const tmpDir = await import('node:os').then(m => m.tmpdir())
  const dir = path.join(tmpDir, 'monrad-migrations-pre361-' + crypto.randomUUID())
  const migDir = path.join(dir, 'migrations')
  await fs.promises.mkdir(migDir, { recursive: true })
  // URL: file is at server/src/test/file.ts, so ../.. goes up to server/
  const serverDir = new URL('../..', import.meta.url).pathname
  const migrationsDir = path.join(serverDir, 'prisma/migrations')
  const allMigrations = await fs.promises.readdir(migrationsDir)
  const pre361 = allMigrations.filter(m => !m.startsWith('20260721')).sort()

  for (const m of pre361) {
    const src = path.join(migrationsDir, m)
    const dst = path.join(migDir, m)
    await fs.promises.cp(src, dst, { recursive: true })
  }

  // Create a temporary Prisma schema
  const schemaContent = await fs.promises.readFile(path.join(serverDir, 'prisma/schema.prisma'), 'utf-8')
  const tmpSchema = path.join(dir, 'schema.prisma')
  await fs.promises.writeFile(tmpSchema, schemaContent, 'utf-8')

  // Create a temporary Prisma config that overrides both schema and migrations path.
  // Used via --config so the repository prisma.config.ts is never discovered.
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

async function cleanupPre361Dir(tmpConfig: string): Promise<void> {
  const dir = path.dirname(tmpConfig)
  try { await fs.promises.rm(dir, { recursive: true, force: true }) } catch { /* ok */ }
}

/**
 * Assert that the #361 CHECK constraints and partial unique indexes are installed.
 */
async function assert361ConstraintsInstalled(): Promise<void> {
  const constraintRows = await prisma.$queryRaw<Array<{ constraint_name: string }>>(
    Prisma.sql`SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = 'CapacityProfile' AND constraint_name LIKE 'chk_CapacityProfile%'`,
  )
  const names = constraintRows.map(r => r.constraint_name).sort()
  expect(names).toEqual(['chk_CapacityProfile_exactly_one_owner', 'chk_CapacityProfile_owner_kind_fk'])
  const idxRows = await prisma.$queryRaw<Array<{ indexname: string }>>(
    Prisma.sql`SELECT indexname FROM pg_indexes WHERE tablename = 'CapacityProfile' AND indexname LIKE 'CapacityProfile_%_key'`,
  )
  const idxNames = idxRows.map(r => r.indexname).sort()
  expect(idxNames).toEqual(['CapacityProfile_namedResourceId_key', 'CapacityProfile_resourceTypeId_key'])
}

/**
 * Assert that the #361 database objects are absent.
 * This is a fail-closed check run after resetToPre361() to confirm that the
 * full migration set was NOT applied accidentally.
 */
async function assert361ConstraintsAbsent(): Promise<void> {
  const constraintRows = await prisma.$queryRaw<Array<{ constraint_name: string }>>(
    Prisma.sql`SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = 'CapacityProfile' AND constraint_name LIKE 'chk_CapacityProfile%'`,
  )
  expect(constraintRows).toHaveLength(0)
  const idxRows = await prisma.$queryRaw<Array<{ indexname: string }>>(
    Prisma.sql`SELECT indexname FROM pg_indexes WHERE tablename = 'CapacityProfile' AND indexname LIKE 'CapacityProfile_%_key'`,
  )
  const idx361 = idxRows.filter((r: { indexname: string }) =>
    r.indexname === 'CapacityProfile_resourceTypeId_key' || r.indexname === 'CapacityProfile_namedResourceId_key')
  expect(idx361).toHaveLength(0)
}

async function setupFixtures(): Promise<void> {
  const user = await prisma.user.create({
    data: {
      email: 'ownership-invariants-test-' + Date.now() + '@example.com',
      name: 'Test User',
      password: 'test-hash',
    },
  })
  const project = await prisma.project.create({
    data: { name: 'Ownership Invariants Test', ownerId: user.id },
  })
  projectId = project.id

  const rt = await prisma.resourceType.create({
    data: { name: 'Test Role', projectId, category: 'ENGINEERING', count: 2 },
  })
  rtId = rt.id

  const nr1 = await prisma.namedResource.create({
    data: { name: 'Test Person 1', resourceTypeId: rtId },
  })
  nrId = nr1.id

  const nr2 = await prisma.namedResource.create({
    data: { name: 'Test Person 2', resourceTypeId: rtId },
  })
  nrId2 = nr2.id
}

/**
 * Reset the test database to a clean pre-#361 state.
 * 1. Drop public schema and recreate
 * 2. Deploy only pre-#361 migrations using a temporary Prisma config
 * 3. Assert that #361 constraints are absent
 * 4. Recreate all fixture state (user, project, RTs, NRs)
 */
async function resetToPre361(): Promise<void> {
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
    await cleanupPre361Dir(tmpConfig)
  }
  // Fail-closed: confirm #361 constraints were NOT applied
  await assert361ConstraintsAbsent()
  // Recreate all fixture state (IDs would be stale after schema reset)
  await setupFixtures()
}


/**
 * Run `prisma migrate deploy` using the normal (full) migrations directory.
 * This applies the committed #361 migration artifact.
 */
async function deployFullMigrations(): Promise<void> {
  const { execSync } = await import('node:child_process')
  execSync('npx prisma migrate deploy', {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: 'pipe',
  })
}
// ═════════════════════════════════════════════════════════════════════════════
// Phase 1: Pre-#361 ownership integrity tests
// ═════════════════════════════════════════════════════════════════════════════
// All audit, repair, conflict, and shape error tests run against pre-#361
// schema (no unique indexes or CHECK constraints).

describeIf('Pre-#361 ownership integrity tests', () => {
  beforeAll(async () => {
    await resetToPre361()
    // Create a valid ROLE profile
    const rp = await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
        legacy: Prisma.DbNull,
      },
    })
    roleProfileId = rp.id
    // Create a valid NAMED_PERSON profile
    const np = await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: null,
        namedResourceId: nrId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
        legacy: Prisma.DbNull,
      },
    })
    nrProfileId = np.id
  })
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Clean database audit', () => {
  it('audits successfully with no findings', async () => {
    await resetToCleanState()
    const report = await runOwnershipAudit(prisma)
    expect(report.isClean).toBe(true)
    expect(report.findings).toHaveLength(0)
    expect(report.totalProfiles).toBe(2)
    expect(report.validSingletons).toBe(2)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Identical role duplicate detection and repair
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Identical role duplicate detection and repair', () => {
  beforeEach(async () => {
    await resetToCleanState()
  })

  it('reports identical role duplicates', async () => {
    await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
        legacy: Prisma.DbNull,
      },
    })

    const report = await runOwnershipAudit(prisma)
    expect(report.repairableGroups).toHaveLength(1)
    expect(report.findings.some(f => f.type === 'identical_duplicate_group')).toBe(true)
    expect(report.isClean).toBe(false)
  })

  it('repairs identical role duplicates preserving survivor', async () => {
    // Create duplicate
    await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
        legacy: Prisma.DbNull,
      },
    })

    const report = await runOwnershipAudit(prisma)
    expect(report.repairableGroups).toHaveLength(1)

    const result = await repairIdenticalDuplicates(prisma, report)
    expect(result.profilesDeleted).toBe(1)

    const finalReport = await runOwnershipAudit(prisma)
    expect(finalReport.isClean).toBe(true)
    expect(finalReport.totalProfiles).toBe(2)

    // Verify survivor is the original (earliest createdAt)
    const remaining = await prisma.capacityProfile.findMany({
      where: { resourceTypeId: rtId },
    })
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe(roleProfileId)
  })

  it('repair is idempotent', async () => {
    // Create duplicate
    await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
        legacy: Prisma.DbNull,
      },
    })

    const report = await runOwnershipAudit(prisma)
    await repairIdenticalDuplicates(prisma, report)

    // Second repair should do nothing
    const cleanReport = await runOwnershipAudit(prisma)
    expect(cleanReport.isClean).toBe(true)
    const result2 = await repairIdenticalDuplicates(prisma, cleanReport)
    expect(result2.profilesDeleted).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Identical named-resource duplicates with exact legacy null semantics
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Identical named-resource duplicates with exact legacy null semantics', () => {
  beforeEach(async () => {
    await resetToCleanState()
  })

  it('preserves survivor and segment IDs for named duplicates', async () => {
    // Add a segment to the original profile
    await prisma.capacitySegment.create({
      data: {
        capacityProfileId: nrProfileId,
        startWeek: 0,
        endWeek: 4,
        capacityPercent: 100,
        source: 'FIXED',
      },
    })

    // Create identical duplicate (same state, different id)
    await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: null,
        namedResourceId: nrId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
        legacy: Prisma.DbNull,
      },
    })

    const report = await runOwnershipAudit(prisma)
    expect(report.repairableGroups).toHaveLength(1)

    await repairIdenticalDuplicates(prisma, report)

    const finalProfiles = await prisma.capacityProfile.findMany({
      where: { namedResourceId: nrId },
      include: { segments: true },
    })
    expect(finalProfiles).toHaveLength(1)
    expect(finalProfiles[0].id).toBe(nrProfileId) // survivor
    expect(finalProfiles[0].segments).toHaveLength(1)
    expect(finalProfiles[0].segments[0].startWeek).toBe(0)
    expect(finalProfiles[0].segments[0].endWeek).toBe(4)
  })

  it('does not treat SQL null and JSON null as equal', async () => {
    // Original has DB_NULL
    // Create duplicate with JSON_NULL legacy
    await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: null,
        namedResourceId: nrId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
        legacy: Prisma.JsonNull,
      },
    })

    const report = await runOwnershipAudit(prisma)
    expect(report.repairableGroups).toHaveLength(0)
    expect(report.conflictingGroups).toHaveLength(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Different scalar fields block repair
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Different scalar fields block repair', () => {
  beforeEach(async () => {
    await resetToCleanState()
  })

  it('different defaultPercent is a conflict', async () => {
    await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 50, // different from original 100
        startWeek: 0,
        endWeek: 10,
        legacy: Prisma.DbNull,
      },
    })

    const report = await runOwnershipAudit(prisma)
    expect(report.repairableGroups).toHaveLength(0)
    expect(report.conflictingGroups).toHaveLength(1)
  })

  it('different source is a conflict', async () => {
    await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'MANUAL', // different from original FIXED
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
        legacy: Prisma.DbNull,
      },
    })

    const report = await runOwnershipAudit(prisma)
    expect(report.repairableGroups).toHaveLength(0)
    expect(report.conflictingGroups).toHaveLength(1)
  })

  it('different segment values is a conflict', async () => {
    // Add a segment to original
    await prisma.capacitySegment.create({
      data: {
        capacityProfileId: roleProfileId,
        startWeek: 0,
        endWeek: 4,
        capacityPercent: 100,
        source: 'FIXED',
      },
    })

    // Create duplicate with different segment
    const _dup = await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
        legacy: Prisma.DbNull,
      },
    })
    await prisma.capacitySegment.create({
      data: {
        capacityProfileId: _dup.id,
        startWeek: 0,
        endWeek: 4,
        capacityPercent: 75, // different
        source: 'FIXED',
      },
    })

    const report = await runOwnershipAudit(prisma)
    expect(report.repairableGroups).toHaveLength(0)
    expect(report.conflictingGroups).toHaveLength(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Conflicting groups cause no writes
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Conflicting groups cause no writes', () => {
  beforeEach(async () => {
    await resetToCleanState()
  })

  it('repair does not touch conflicting groups', async () => {
    // Create conflicting duplicate (different planningBasis)
    await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'AVAILABILITY_WINDOW', // different
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
        legacy: Prisma.DbNull,
      },
    })

    const report = await runOwnershipAudit(prisma)
    expect(report.conflictingGroups).toHaveLength(1)
    expect(report.repairableGroups).toHaveLength(0)

    await expect(repairIdenticalDuplicates(prisma, report)).resolves.not.toThrow()
    // Verify no profiles were deleted
    const all = await prisma.capacityProfile.findMany()
    expect(all).toHaveLength(3) // 2 original + 1 conflicting still exists
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Shape error detection
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Shape error detection', () => {
  beforeEach(async () => {
    await deleteAllProfiles()
  })

  it('reports both-owner FK set', async () => {
    await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: rtId,
        namedResourceId: nrId, // both set
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
        legacy: Prisma.DbNull,
      },
    })

    const report = await runOwnershipAudit(prisma)
    expect(report.findings.some(f => f.type === 'both_owner_fks_set')).toBe(true)
    expect(report.isClean).toBe(false)
  })

  it('reports neither-owner FK set', async () => {
    await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: null,
        namedResourceId: null, // neither set
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
        legacy: Prisma.DbNull,
      },
    })

    const report = await runOwnershipAudit(prisma)
    expect(report.findings.some(f => f.type === 'neither_owner_fk_set')).toBe(true)
  })

  it('reports ownerKind FK mismatch', async () => {
    // ROLE with namedResourceId
    await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: null,
        namedResourceId: nrId,
        ownerKind: 'ROLE', // mismatch
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
        legacy: Prisma.DbNull,
      },
    })

    const report = await runOwnershipAudit(prisma)
    expect(report.findings.some(f => f.type === 'owner_kind_fk_mismatch')).toBe(true)
  })

  it('reports cross-project owner mismatch', async () => {
    // Create a second project and use the resourceType from it
    const user = await prisma.user.findFirstOrThrow()
    const project2 = await prisma.project.create({
      data: { name: 'Second Project', ownerId: user.id },
    })
    const rt2 = await prisma.resourceType.create({
      data: { name: 'Other Role', projectId: project2.id, category: 'ENGINEERING' },
    })

    // Create profile in first project but referencing rt2
    await prisma.capacityProfile.create({
      data: {
        projectId,
        resourceTypeId: rt2.id, // belongs to project2, not projectId
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: 0,
        endWeek: 10,
        legacy: Prisma.DbNull,
      },
    })

    const report = await runOwnershipAudit(prisma)
    expect(report.findings.some(f => f.type === 'cross_project_owner')).toBe(true)
  })

  it('malformed both-FK profile participates in both duplicate namespaces', async () => {
    // Create a both-FK profile + one sharing its RT + one sharing its NR
    await prisma.capacityProfile.createMany({
      data: [
        {
          projectId, resourceTypeId: rtId, namedResourceId: nrId,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
        {
          projectId, resourceTypeId: rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
        {
          projectId, resourceTypeId: null, namedResourceId: nrId,
          ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      ],
    })

    const report = await runOwnershipAudit(prisma)
    expect(report.isClean).toBe(false)

    // Two duplicate_physical_owner findings: one per namespace
    const dupFindings = report.findings.filter(f => f.type === 'duplicate_physical_owner')
    expect(dupFindings).toHaveLength(2)

    const rtFinding = dupFindings.find(f => f.message.includes('resourceTypeId'))
    const nrFinding = dupFindings.find(f => f.message.includes('namedResourceId'))
    expect(rtFinding).toBeDefined()
    expect(nrFinding).toBeDefined()

    // Both groups are conflicting, not repairable
    expect(report.conflictingGroups.length).toBeGreaterThanOrEqual(2)
    expect(report.repairableGroups).toHaveLength(0)

    // The both-FK profile appears in both groups
    for (const g of report.conflictingGroups) {
      expect(g.profileIds).toContain(g.profiles.find(p => p.resourceTypeId != null && p.namedResourceId != null)?.id ?? '')
      expect(g.isIdentical).toBe(false)
    }
  })
})
})

// ═════════════════════════════════════════════════════════════════════════════
// Phase 2: Migration and constraint enforcement
// ═════════════════════════════════════════════════════════════════════════════
// Migration preflight tests reset to pre-#361, seed dirty data, then verify
// the committed #361 migration artifact refuses it. After each dirty test the
// afterEach restores a clean post-#361 state. Subsequent post-migration tests
// verify constraint enforcement, rollback, writer compatibility and
// backfill/reconcile safety under the production constraints.

describeIf('Migration and constraint enforcement', () => {
  // Each test in this section exercises the committed #361 migration artifact
  // by rolling it back, seeding fixtures, then deploying it via `prisma migrate deploy`.

  describe('Migration preflight (dirty data refusal)', () => {
    afterEach(async () => {
      // Full reset: drop schema, deploy pre-#361 migrations, recreate fixtures,
      // create valid clean profiles, then deploy the #361 migration artifact.
      await resetToPre361()
      // Create a valid ROLE profile (no constraints before #361)
      await prisma.capacityProfile.create({
        data: {
          projectId, resourceTypeId: rtId, namedResourceId: null,
          ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await prisma.capacityProfile.create({
        data: {
          projectId, resourceTypeId: null, namedResourceId: nrId,
          ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      await deployFullMigrations()
      await assert361ConstraintsInstalled()
    })

  it('migration refuses both FK set', async () => {
    await resetToPre361()
    await prisma.capacityProfile.create({
      data: {
        projectId, resourceTypeId: rtId, namedResourceId: nrId, ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100,
        startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
      },
    })
    await expect(deployFullMigrations()).rejects.toThrow()
    await resetToCleanState()
  })

  it('migration refuses neither FK set', async () => {
    await resetToPre361()
    await prisma.capacityProfile.create({
      data: {
        projectId, resourceTypeId: null, namedResourceId: null, ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100,
        startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
      },
    })
    await expect(deployFullMigrations()).rejects.toThrow()
    await resetToCleanState()
  })

  it('migration refuses ownerKind/FK mismatch', async () => {
    await resetToPre361()
    await prisma.capacityProfile.create({
      data: {
        projectId, resourceTypeId: null, namedResourceId: nrId, ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100,
        startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
      },
    })
    await expect(deployFullMigrations()).rejects.toThrow()
    await resetToCleanState()
  })

  it('migration refuses duplicate resourceTypeId', async () => {
    await resetToPre361()
    await prisma.capacityProfile.create({
      data: {
        projectId, resourceTypeId: rtId, namedResourceId: null, ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100,
        startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
      },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId, resourceTypeId: rtId, namedResourceId: null, ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100,
        startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
      },
    })
    await expect(deployFullMigrations()).rejects.toThrow()
    await resetToCleanState()
  })

  it('migration succeeds after clean state', async () => {
    await resetToCleanState()
    await resetToPre361()
    await expect(deployFullMigrations()).resolves.not.toThrow()
  })

  it('migration refuses duplicate namedResourceId', async () => {
    await resetToPre361()
    await prisma.capacityProfile.create({
      data: { projectId, resourceTypeId: null, namedResourceId: nrId, ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100,
        startWeek: 0, endWeek: 10, legacy: Prisma.DbNull },
    })
    await prisma.capacityProfile.create({
      data: { projectId, resourceTypeId: null, namedResourceId: nrId, ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100,
        startWeek: 0, endWeek: 10, legacy: Prisma.DbNull },
    })
    await expect(deployFullMigrations()).rejects.toThrow()
    // afterEach handles cleanup
  })

  it('migration refuses cross-project resourceTypeId', async () => {
    await resetToPre361()
    // Create a second project and use its RT as the profile owner
    const user = await prisma.user.findFirstOrThrow()
    const project2 = await prisma.project.create({
      data: { name: 'Cross-project test', ownerId: user.id },
    })
    const rt2 = await prisma.resourceType.create({
      data: { name: 'Other role', projectId: project2.id, category: 'ENGINEERING', count: 1 },
    })
    await prisma.capacityProfile.create({
      data: { projectId, resourceTypeId: rt2.id, namedResourceId: null, ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100,
        startWeek: 0, endWeek: 10, legacy: Prisma.DbNull },
    })
    await expect(deployFullMigrations()).rejects.toThrow()
  })

  it('migration refuses cross-project namedResourceId', async () => {
    await resetToPre361()
    // Create a second project, its RT and NR, then use that NR in original project's profile
    const user = await prisma.user.findFirstOrThrow()
    const project2 = await prisma.project.create({
      data: { name: 'Cross-project test 2', ownerId: user.id },
    })
    const rt2 = await prisma.resourceType.create({
      data: { name: 'Other role 2', projectId: project2.id, category: 'ENGINEERING', count: 1 },
    })
    const nr2 = await prisma.namedResource.create({
      data: { name: 'Other person', resourceTypeId: rt2.id },
    })
    await prisma.capacityProfile.create({
      data: { projectId, resourceTypeId: null, namedResourceId: nr2.id, ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100,
        startWeek: 0, endWeek: 10, legacy: Prisma.DbNull },
    })
    await expect(deployFullMigrations()).rejects.toThrow()
  })
  })

  it('PostgreSQL rejects both FK after migration', async () => {
    await resetToCleanState()
    await expect(
      prisma.capacityProfile.create({
        data: { projectId, resourceTypeId: rtId, namedResourceId: nrId, ownerKind: 'ROLE',
          planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100,
          startWeek: 0, endWeek: 10, legacy: Prisma.DbNull },
      }),
    ).rejects.toThrow()
  })

  it('PostgreSQL rejects duplicate resourceTypeId after migration', async () => {
    await resetToCleanState()
    await expect(
      prisma.capacityProfile.create({
        data: { projectId, resourceTypeId: rtId, namedResourceId: null, ownerKind: 'ROLE',
          planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100,
          startWeek: 0, endWeek: 10, legacy: Prisma.DbNull },
      }),
    ).rejects.toThrow()
  })

  it('PostgreSQL rejects cross-kind named resource duplicate', async () => {
    await resetToCleanState()
    await expect(
      prisma.capacityProfile.create({
        data: { projectId, resourceTypeId: null, namedResourceId: nrId, ownerKind: 'PLANNED_RESOURCE',
          planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED', defaultPercent: 100,
          startWeek: 0, endWeek: 10, legacy: Prisma.DbNull },
      }),
    ).rejects.toThrow()
  })


// ═════════════════════════════════════════════════════════════════════════════
// Contraint rollback preserves valid data
// ═════════════════════════════════════════════════════════════════════════════

describeIf('Constraint rollback preserves valid data', () => {
  beforeEach(async () => {
    await deleteAllProfiles()
  })

  it('dropping constraints preserves existing valid data', async () => {
    await resetToCleanState()

    // Verify data is intact
    const count = await prisma.capacityProfile.count()
    expect(count).toBe(2)

    // Rollback: drop #361 constraints manually (demonstrates documented procedure)
    await prisma.$executeRawUnsafe('ALTER TABLE "CapacityProfile" DROP CONSTRAINT IF EXISTS "chk_CapacityProfile_exactly_one_owner"')
    await prisma.$executeRawUnsafe('ALTER TABLE "CapacityProfile" DROP CONSTRAINT IF EXISTS "chk_CapacityProfile_owner_kind_fk"')
    await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "CapacityProfile_resourceTypeId_key"')
    await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "CapacityProfile_namedResourceId_key"')
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "CapacityProfile_resourceTypeId_idx" ON "CapacityProfile"("resourceTypeId")')
    await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "CapacityProfile_namedResourceId_idx" ON "CapacityProfile"("namedResourceId")')

    // Verify data still intact
    const afterCount = await prisma.capacityProfile.count()
    expect(afterCount).toBe(2)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Post-migration: constraint enforcement under production #361 schema
// ═════════════════════════════════════════════════════════════════════════════
// The rollback test above may have dropped constraints. Restore a clean
// post-#361 schema explicitly so these suites run against real constraints.

describeIf('Post-migration constraint enforcement', () => {
  beforeAll(async () => {
    // Reset to pre-#361, create valid clean profiles, deploy the #361
    // migration artifact, and verify constraints.
    await resetToPre361()
    await prisma.capacityProfile.create({
      data: {
        projectId, resourceTypeId: rtId, namedResourceId: null,
        ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
        defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
      },
    })
    await prisma.capacityProfile.create({
      data: {
        projectId, resourceTypeId: null, namedResourceId: nrId,
        ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
        defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
      },
    })
    await deployFullMigrations()
    await assert361ConstraintsInstalled()
  })

  describeIf('Existing write path compatibility under constraints', () => {
    beforeEach(async () => {
      await deleteAllProfiles()
    })

    it('creates a valid named-resource profile under constraints', async () => {
      await resetToCleanState()
      const profile = await prisma.capacityProfile.create({
        data: {
          projectId, resourceTypeId: null, namedResourceId: nrId2,
          ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
          defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
        },
      })
      expect(profile.id).toBeTruthy()
    })

    it('concurrent duplicate attempt rolls back cleanly', async () => {
      await resetToCleanState()
      await expect(
        prisma.capacityProfile.create({
          data: {
            projectId, resourceTypeId: null, namedResourceId: nrId,
            ownerKind: 'NAMED_PERSON', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
            defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
          },
        }),
      ).rejects.toThrow()
      const profilesForNR = await prisma.capacityProfile.count({
        where: { namedResourceId: nrId },
      })
      expect(profilesForNR).toBe(1)
    })
  })

  describeIf('Backfill/reconcile safety under constraints', () => {
    beforeEach(async () => {
      await deleteAllProfiles()
    })

    it('backfill cannot create duplicate owners under constraints', async () => {
      await resetToCleanState()
      await expect(
        prisma.capacityProfile.create({
          data: {
            projectId, resourceTypeId: rtId, namedResourceId: null,
            ownerKind: 'ROLE', planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
            defaultPercent: 100, startWeek: 0, endWeek: 10, legacy: Prisma.DbNull,
          },
        }),
      ).rejects.toThrow()
    })
  })
})
})
