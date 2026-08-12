/**
 * capacityProfileProvenanceMigration.integration.test.ts — Real PostgreSQL
 * tests for the issue #405 provenance migration.
 *
 * Scenario A — pre-#405 representative database: applies the full migration
 * history EXCEPT the provenance migration, seeds a representative set of
 * legacy JSON payloads (each recognised behavioural provenance class plus
 * projection-only/unknown/transfer-on-ROLE payloads that must become NULL),
 * then applies the provenance migration and asserts the deterministic
 * backfill plus the resulting schema (provenance column present, no
 * CapacityProfile.legacy column, exactly the four approved enum values).
 *
 * Scenario B — clean database from full migration history: asserts the
 * post-migration schema contract directly.
 *
 * The committed migration artifact (server/prisma/migrations/) is the sole
 * schema authority; no ad-hoc DDL is executed beyond the committed SQL.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

const PROVENANCE_MIGRATION_NAME = '20260811061641_add_capacity_profile_provenance'
const MIGRATION_META: Record<string, true> = { 'migration_lock.toml': true }

let prisma: PrismaClient

const serverDir = new URL('../..', import.meta.url).pathname
const migrationsDir = path.join(serverDir, 'prisma/migrations')

// ─── Temp migration-dir helpers (mirror ownership-invariants pattern) ───────

async function createPre405MigrationDir(): Promise<string> {
  const dir = path.join(serverDir, '.tmp-pre405-' + crypto.randomUUID())
  const migDir = path.join(dir, 'migrations')
  await fs.promises.mkdir(migDir, { recursive: true })
  const allMigrations = await fs.promises.readdir(migrationsDir)
  for (const m of allMigrations) {
    if (m === PROVENANCE_MIGRATION_NAME) continue
    if (MIGRATION_META[m]) continue
    const stat = await fs.promises.stat(path.join(migrationsDir, m)).catch(() => null)
    if (stat?.isDirectory()) {
      await fs.promises.cp(path.join(migrationsDir, m), path.join(migDir, m), { recursive: true })
    }
  }
  const schemaContent = await fs.promises.readFile(
    path.join(serverDir, 'prisma/schema.prisma'), 'utf-8',
  )
  const tmpSchema = path.join(dir, 'schema.prisma')
  await fs.promises.writeFile(tmpSchema, schemaContent, 'utf-8')
  const tmpConfig = path.join(dir, 'prisma.config.ts')
  await fs.promises.writeFile(tmpConfig, [
    'import { defineConfig } from "prisma/config"',
    'export default defineConfig({',
    '  schema: "' + tmpSchema.replace(/\\/g, '\\\\') + '",',
    '  migrations: { path: "' + migDir.replace(/\\/g, '\\\\') + '" },',
    '  datasource: { url: process.env["DATABASE_URL"] }',
    '})',
  ].join('\n'), 'utf-8')
  return tmpConfig
}

async function cleanupTmpDir(tmpConfig: string): Promise<void> {
  const dir = path.dirname(tmpConfig)
  try { await fs.promises.rm(dir, { recursive: true, force: true }) } catch { /* ok */ }
}

function deployWithConfig(tmpConfig: string): void {
  execSync(`npx prisma migrate deploy --config="${tmpConfig}"`, {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: 'pipe',
  })
}

function deployFullMigrations(): void {
  execSync('npx prisma migrate deploy', {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: 'pipe',
  })
}

async function resetSchema(): Promise<void> {
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE')
  await prisma.$executeRawUnsafe('CREATE SCHEMA public')
}

// ─── Pre-#405 fixture seeding (raw SQL: the ORM no longer knows `legacy`) ──

async function seedPre405Fixtures(): Promise<void> {
  // Minimal ownership chain
  await prisma.$executeRawUnsafe(
    `INSERT INTO "User" (id, email, name, password, role, "createdAt", "updatedAt")
     VALUES ('u405','provenance-migration-test@example.com','T','x','USER', now(), now())`,
  )
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Project" (id, name, "ownerId", "updatedAt") VALUES ('p405','P','u405', now())`,
  )
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ResourceType" (id, name, category, count, "projectId")
     VALUES ('rt405','Dev','ENGINEERING',2,'p405'), ('rt405b','QA','ENGINEERING',1,'p405')`,
  )
  await prisma.$executeRawUnsafe(
    `INSERT INTO "NamedResource" (id, name, "resourceTypeId", "updatedAt") VALUES
     ('nr405a','A','rt405', now()), ('nr405b','B','rt405', now()),
     ('nr405b2','B2','rt405', now()),
     ('nr405c','C','rt405b', now()), ('nr405d','D','rt405b', now()),
     ('nr405e','E','rt405b', now()), ('nr405f','F','rt405b', now()),
     ('nr405g','G','rt405b', now()), ('nr405h','H','rt405b', now()),
     ('nr405i','I','rt405b', now())`,
  )
  const insertProfile = (id: string, ownerKind: string, rt: string | null, nr: string | null,
    basis: string, source: string, percent: number | null, sw: number | null, ew: number | null,
    legacy: string | null) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "CapacityProfile"
         (id, "projectId", "resourceTypeId", "namedResourceId", "ownerKind",
          "planningBasis", source, "defaultPercent", "startWeek", "endWeek", legacy, "updatedAt")
       VALUES ($1,'p405',$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, now())`,
      id, rt, nr, ownerKind, basis, source, percent, sw, ew, legacy,
    )

  // 1. ROLE_DEFAULT clone
  await insertProfile('cp-role-default', 'NAMED_PERSON', null, 'nr405a',
    'AVAILABILITY_WINDOW', 'DERIVED', 100, null, null,
    '{"version":1,"writer":"ROLE_DEFAULT"}')
  // 2. RESOURCE_OPTIMISER scalar
  await insertProfile('cp-opt', 'NAMED_PERSON', null, 'nr405b',
    'AVAILABILITY_WINDOW', 'DERIVED', 60, 2, 10,
    '{"version":1,"writer":"RESOURCE_OPTIMISER","allocationMode":"TIMELINE"}')
  // 2b. Optimiser-shaped but version is the JSON STRING "1" — the runtime
  // predicate requires the JSON number 1, so this must NOT be promoted.
  await insertProfile('cp-opt-string-version', 'NAMED_PERSON', null, 'nr405b2',
    'AVAILABILITY_WINDOW', 'DERIVED', 60, 2, 10,
    '{"version":"1","writer":"RESOURCE_OPTIMISER","allocationMode":"TIMELINE"}')
  // 3. Transferred planned resource
  await insertProfile('cp-transfer', 'PLANNED_RESOURCE', null, 'nr405c',
    'CAPACITY_PROFILE', 'MANUAL', 100, 0, 10,
    '{"version":1,"writer":"transfer-to-manual","allocationMode":"CAPACITY_PLAN"}')
  // 4. ROLE profile with transfer metadata → must become NULL
  await insertProfile('cp-transfer-role', 'ROLE', 'rt405', null,
    'CAPACITY_PROFILE', 'MANUAL', 100, 0, 10,
    '{"version":1,"writer":"transfer-to-manual","allocationMode":"CAPACITY_PLAN"}')
  // 5. Strict mapper ROLE (TIMELINE pair)
  await insertProfile('cp-mapper-role', 'ROLE', 'rt405b', null,
    'AVAILABILITY_WINDOW', 'AVAILABILITY_WINDOW', 100, 2, 8,
    '{"allocationMode":"TIMELINE","allocationPercent":100,"allocationPct":null,' +
    '"allocationStartWeek":2,"allocationEndWeek":8,"startWeek":null,"endWeek":null}')
  // 6. Strict mapper NAMED (EFFORT pair)
  await insertProfile('cp-mapper-named', 'NAMED_PERSON', null, 'nr405d',
    'DEMAND_FOLLOWING', 'FIXED', 100, null, null,
    '{"allocationMode":"EFFORT","allocationPercent":100,"allocationPct":100,' +
    '"allocationStartWeek":null,"allocationEndWeek":null,"startWeek":null,"endWeek":null}')
  // 7. Manual-editor projection → NULL
  await insertProfile('cp-editor', 'NAMED_PERSON', null, 'nr405e',
    'DEMAND_FOLLOWING', 'MANUAL', 100, null, null,
    '{"version":1,"writer":"manual-editor","allocationMode":"EFFORT","allocationPercent":100,' +
    '"allocationStartWeek":null,"allocationEndWeek":null,"lossy":false,"lossReason":null}')
  // 8. Unknown JSON → NULL
  await insertProfile('cp-unknown', 'NAMED_PERSON', null, 'nr405f',
    'DEMAND_FOLLOWING', 'MANUAL', 80, null, null, '{"foo":"bar","nested":{"value":1}}')
  // 9. JSON null → NULL
  await insertProfile('cp-jsonnull', 'NAMED_PERSON', null, 'nr405g',
    'DEMAND_FOLLOWING', 'MANUAL', 100, null, null, 'null')
  // 10. Mapper-shaped but divergent (defaultPercent mismatch) → NULL
  await insertProfile('cp-divergent', 'NAMED_PERSON', null, 'nr405h',
    'AVAILABILITY_WINDOW', 'AVAILABILITY_WINDOW', 80, 2, 8,
    '{"allocationMode":"TIMELINE","allocationPercent":100,"allocationPct":100,' +
    '"allocationStartWeek":2,"allocationEndWeek":8,"startWeek":2,"endWeek":8}')
  // 11. Independent manual planned resource (no transfer writer) → NULL,
  //     remains scheduler-authoritative.
  await insertProfile('cp-manual-planned', 'PLANNED_RESOURCE', null, 'nr405i',
    'CAPACITY_PROFILE', 'MANUAL', 100, 0, 10, null)
}

// ─── Schema contract assertions ──────────────────────────────────────────────

async function assertPost405Schema(): Promise<void> {
  // provenance column exists with the enum type
  const provenanceCols = await prisma.$queryRaw<Array<{ data_type: string }>>(
    Prisma.sql`SELECT data_type FROM information_schema.columns
      WHERE table_name = 'CapacityProfile' AND column_name = 'provenance'`,
  )
  expect(provenanceCols).toHaveLength(1)
  expect(provenanceCols[0].data_type).toBe('USER-DEFINED')

  const enumRows = await prisma.$queryRaw<Array<{ enumlabel: string }>>(
    Prisma.sql`SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = ${'CapacityProfileProvenance'}
      ORDER BY e.enumsortorder`,
  )
  expect(enumRows.map(r => r.enumlabel)).toEqual([
    'LEGACY_MAPPER',
    'ROLE_DEFAULT',
    'RESOURCE_OPTIMISER',
    'TRANSFERRED_FROM_SQUAD_PLANNER',
  ])

  // no CapacityProfile.legacy column
  const legacyCols = await prisma.$queryRaw<Array<{ column_name: string }>>(
    Prisma.sql`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'CapacityProfile' AND column_name = 'legacy'`,
  )
  expect(legacyCols).toHaveLength(0)
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

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

describeIf('capacity-profile provenance migration (#405)', () => {
  it('clean database from full migration history exposes the post-#405 schema', async () => {
    // The integration lifecycle deploys the full migration history before
    // this suite; verify the resulting contract.
    await assertPost405Schema()
  })

  it('pre-#405 representative database backfills recognised provenance deterministically', async () => {
    await resetSchema()
    const tmpConfig = await createPre405MigrationDir()
    try {
      deployWithConfig(tmpConfig)
    } finally {
      await cleanupTmpDir(tmpConfig)
    }

    // Pre-#405 schema still exposes the legacy column
    const preLegacyCols = await prisma.$queryRaw<Array<{ column_name: string }>>(
      Prisma.sql`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'CapacityProfile' AND column_name = 'legacy'`,
    )
    expect(preLegacyCols).toHaveLength(1)

    await seedPre405Fixtures()

    // Apply the provenance migration (full remaining history)
    deployFullMigrations()

    // Backfill contract
    const rows = await prisma.$queryRaw<Array<{ id: string; provenance: string | null }>>(
      Prisma.sql`SELECT id, provenance FROM "CapacityProfile" ORDER BY id`,
    )
    const byId = new Map(rows.map(r => [r.id, r.provenance]))
    expect(byId.get('cp-role-default')).toBe('ROLE_DEFAULT')
    expect(byId.get('cp-opt')).toBe('RESOURCE_OPTIMISER')
    expect(byId.get('cp-opt-string-version')).toBeNull()
    expect(byId.get('cp-transfer')).toBe('TRANSFERRED_FROM_SQUAD_PLANNER')
    expect(byId.get('cp-mapper-role')).toBe('LEGACY_MAPPER')
    expect(byId.get('cp-mapper-named')).toBe('LEGACY_MAPPER')
    // Not promoted: ROLE transfer metadata, manual-editor projection, unknown
    // JSON, JSON null, divergent mapper-shaped, independent manual planned.
    expect(byId.get('cp-transfer-role')).toBeNull()
    expect(byId.get('cp-editor')).toBeNull()
    expect(byId.get('cp-unknown')).toBeNull()
    expect(byId.get('cp-jsonnull')).toBeNull()
    expect(byId.get('cp-divergent')).toBeNull()
    expect(byId.get('cp-manual-planned')).toBeNull()

    await assertPost405Schema()

    // Restore full schema state for subsequent suites (this test reset it).
    await resetSchema()
    deployFullMigrations()
  })
})
