#!/usr/bin/env node
/**
 * migration-drop-legacy-columns.test.mjs — PR 2 destructive-migration safety
 * tests for issue #418.
 *
 * Proves against disposable PostgreSQL that the single reviewed migration
 * `20260810072212_drop_legacy_capacity_columns` is safe:
 *
 *   A. Clean database — the full migration history applies to an empty
 *      database and the resulting schema lacks exactly the 11 approved
 *      candidate columns while independent metadata remains.
 *   B. Representative pre-PR-2 database — a database at the pre-PR-2
 *      migration state (38 migrations), seeded with representative
 *      ResourceTypes/NamedResources/CapacityProfiles/CapacitySegments,
 *      CURRENT + NEEDS_REPLAN projects, backlog/business rows and a V4
 *      snapshot, with the legacy columns populated at non-default values,
 *      survives the new migration with ONLY those 11 columns removed.
 *   C. Invalid prerequisite state — the existing fail-closed readiness
 *      command (`capacity-profiles:readiness`) refuses a CURRENT project
 *      whose resource types lack canonical profiles; the destructive
 *      migration must not silently proceed from such a state. No new
 *      validity rules are invented.
 *
 * PostgreSQL source (mirrors the lifecycle module):
 *   - default: a disposable `postgres:15` Docker container, force-removed
 *     after the run (scenario databases are created/dropped inside it);
 *   - override: `MONRAD_TEST_DATABASE_URL` (requires
 *     `MONRAD_ALLOW_EXTERNAL_TEST_DATABASE=1`); the external database is
 *     the exact management target — scenario databases are created and
 *     dropped inside it, never the configured database itself.
 *
 * Safe to run via: `npm run test:migration-pr2` (root).
 */

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { renameSync, readdirSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import pg from 'pg'
import { startDockerPostgres, stopDockerPostgres, runCommand, shutdownGuard, redactError } from './local-postgres.mjs'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = join(repositoryRoot, 'server')
const migrationsDir = join(serverDir, 'prisma', 'migrations')
const NEW_MIGRATION = '20260810072212_drop_legacy_capacity_columns'

// The 11 approved candidate columns (ResourceType 4 + NamedResource 7).
const CANDIDATE_COLUMNS = [
  { table: 'ResourceType', column: 'allocationMode' },
  { table: 'ResourceType', column: 'allocationPercent' },
  { table: 'ResourceType', column: 'allocationStartWeek' },
  { table: 'ResourceType', column: 'allocationEndWeek' },
  { table: 'NamedResource', column: 'allocationMode' },
  { table: 'NamedResource', column: 'allocationPercent' },
  { table: 'NamedResource', column: 'allocationPct' },
  { table: 'NamedResource', column: 'allocationStartWeek' },
  { table: 'NamedResource', column: 'allocationEndWeek' },
  { table: 'NamedResource', column: 'startWeek' },
  { table: 'NamedResource', column: 'endWeek' },
]

// Independent metadata that must survive the migration.
const RETAINED_COLUMNS = [
  { table: 'ResourceType', column: 'name' },
  { table: 'ResourceType', column: 'category' },
  { table: 'ResourceType', column: 'count' },
  { table: 'ResourceType', column: 'hoursPerDay' },
  { table: 'ResourceType', column: 'dayRate' },
  { table: 'ResourceType', column: 'projectId' },
  { table: 'NamedResource', column: 'name' },
  { table: 'NamedResource', column: 'resourceTypeId' },
  { table: 'NamedResource', column: 'pricingModel' },
  { table: 'CapacityProfile', column: 'legacy' },
  { table: 'CapacitySegment', column: 'capacityPercent' },
  { table: 'Project', column: 'planningState' },
]

const externalUrl = process.env.MONRAD_TEST_DATABASE_URL
const allowExternal = process.env.MONRAD_ALLOW_EXTERNAL_TEST_DATABASE === '1'
if (externalUrl && !allowExternal) {
  throw new Error('MONRAD_TEST_DATABASE_URL requires MONRAD_ALLOW_EXTERNAL_TEST_DATABASE=1 (mirrors the lifecycle module)')
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const guard = shutdownGuard()

async function query(databaseUrl, text, values) {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    return await client.query(text, values)
  } finally {
    await client.end()
  }
}

/** Apply migrations. When hideNewMigration is set, the new PR 2 migration is
 * moved completely outside the migrations directory so deploy stops at the
 * pre-PR-2 state (38 applied). */
async function deployMigrations(databaseUrl, { hideNewMigration = false } = {}) {
  const originalPath = join(migrationsDir, NEW_MIGRATION)
  const hiddenRoot = join(migrationsDir, '..', '.pr2-hidden-migrations')
  const hiddenPath = hideNewMigration ? join(hiddenRoot, NEW_MIGRATION) : null
  if (hideNewMigration) {
    if (!readdirSync(migrationsDir).includes(NEW_MIGRATION)) {
      throw new Error(`expected migration directory ${NEW_MIGRATION} to exist`)
    }
    mkdirSync(hiddenRoot, { recursive: true })
    renameSync(originalPath, hiddenPath)
  }
  try {
    await runCommand('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      signal: guard.abortSignal,
    })
  } finally {
    if (hideNewMigration) renameSync(hiddenPath, originalPath)
  }
}

async function createScenarioDatabase(maintenanceUrl, name) {
  await query(maintenanceUrl, `CREATE DATABASE ${name}`)
  return maintenanceUrl.replace(/\/[^/]+$/, `/${name}`)
}

async function dropScenarioDatabase(maintenanceUrl, name) {
  await query(maintenanceUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
}

async function runReadiness(databaseUrl) {
  try {
    await runCommand('npx', ['tsx', 'src/scripts/checkProductionMigrationReadiness.ts'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      signal: guard.abortSignal,
    })
    return 0
  } catch (error) {
    return error?.exitCode ?? 1
  }
}

async function migrationNames(databaseUrl) {
  const result = await query(
    databaseUrl,
    'SELECT migration_name FROM _prisma_migrations ORDER BY started_at ASC',
  )
  return result.rows.map(row => row.migration_name)
}

async function columnsFor(databaseUrl, table) {
  const result = await query(
    databaseUrl,
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table],
  )
  return result.rows.map(row => row.column_name)
}

const scenarioName = prefix => `monrad_pr2_${prefix}_${randomBytes(4).toString('hex')}`

// ─── Representative seed (scenario B) ────────────────────────────────────

const SEED_SQL = `
-- User + projects (one CURRENT, one NEEDS_REPLAN)
INSERT INTO "User" (id, email, name, password, role, "createdAt", "updatedAt")
VALUES ('u-1', 'pr2-migration-test@example.com', 'PR2 Tester', 'x', 'USER', now(), now());

INSERT INTO "Project" (id, name, "ownerId", "planningState", "hoursPerDay", "createdAt", "updatedAt")
VALUES ('p-current', 'Current Project', 'u-1', 'CURRENT', 7.6, now(), now()),
       ('p-replan', 'Replan Project', 'u-1', 'NEEDS_REPLAN', 7.6, now(), now());

-- ResourceTypes with non-default legacy candidate values
INSERT INTO "ResourceType" (id, name, category, count, "hoursPerDay", "dayRate",
  "allocationMode", "allocationPercent", "allocationStartWeek", "allocationEndWeek",
  "proposedName", "projectId")
VALUES ('rt-role-1', 'Engineer', 'ENGINEERING', 2, 7.6, 1200,
  'CAPACITY_PLAN', 64, 0, 9, 'Engineer (proposed)', 'p-current'),
       ('rt-replan-1', 'QA', 'ENGINEERING', 1, 7.6, 900,
  'EFFORT', 100, NULL, NULL, NULL, 'p-replan');

-- NamedResources with non-default legacy candidate values
INSERT INTO "NamedResource" (id, "resourceTypeId", name, "startWeek", "endWeek",
  "allocationPct", "allocationMode", "allocationPercent",
  "allocationStartWeek", "allocationEndWeek", "pricingModel", "createdAt", "updatedAt")
VALUES ('nr-person-1', 'rt-role-1', 'Alice', 2, 10,
  70, 'CAPACITY_PLAN', 70, 2, 10, 'ACTUAL_DAYS', now(), now());

-- Capacity profiles + segments (authoritative capacity state)
INSERT INTO "CapacityProfile" (id, "projectId", "resourceTypeId", "namedResourceId",
  "ownerKind", "planningBasis", "source", "defaultPercent", "startWeek", "endWeek",
  legacy, "createdAt", "updatedAt")
VALUES ('cp-role-1', 'p-current', 'rt-role-1', NULL,
  'ROLE', 'CAPACITY_PROFILE', 'MANUAL', 64, 0, 9,
  '{"version":1,"allocationMode":"CAPACITY_PLAN","allocationPercent":64}', now(), now()),
       ('cp-person-1', 'p-current', NULL, 'nr-person-1',
  'NAMED_PERSON', 'CAPACITY_PROFILE', 'MANUAL', 70, 2, 10,
  '{"version":1,"allocationMode":"CAPACITY_PLAN","allocationPercent":70}', now(), now());

INSERT INTO "CapacitySegment" (id, "capacityProfileId", "startWeek", "endWeek",
  "capacityPercent", source, "createdAt", "updatedAt")
VALUES ('seg-1', 'cp-role-1', 0, 4, 100, 'MANUAL', now(), now()),
       ('seg-2', 'cp-role-1', 5, 9, 50, 'MANUAL', now(), now()),
       ('seg-3', 'cp-person-1', 2, 6, 80, 'MANUAL', now(), now()),
       ('seg-4', 'cp-person-1', 7, 10, 50, 'MANUAL', now(), now());

-- Backlog/business rows
INSERT INTO "Epic" (id, name, "projectId", "order", "createdAt", "updatedAt")
VALUES ('e-1', 'Epic 1', 'p-current', 0, now(), now());
INSERT INTO "Feature" (id, name, "epicId", "order", "createdAt", "updatedAt")
VALUES ('f-1', 'Feature 1', 'e-1', 0, now(), now());
INSERT INTO "UserStory" (id, name, "featureId", "order", "createdAt", "updatedAt")
VALUES ('s-1', 'Story 1', 'f-1', 0, now(), now());
INSERT INTO "Task" (id, name, "userStoryId", "order", "hoursEffort", "resourceTypeId", "createdAt", "updatedAt")
VALUES ('t-1', 'Task 1', 's-1', 0, 16, 'rt-role-1', now(), now());
INSERT INTO "StoryTimelineEntry" (id, "storyId", "projectId", "startWeek", "durationWeeks", "isManual", "createdAt", "updatedAt")
VALUES ('ste-1', 's-1', 'p-current', 0, 4, false, now(), now());

-- Commercial/business metadata
INSERT INTO "ProjectOverhead" (id, "projectId", name, type, value, "order", "createdAt", "updatedAt")
VALUES ('oh-1', 'p-current', 'Program management', 'PERCENTAGE', 10, 0, now(), now());
INSERT INTO "ProjectDiscount" (id, "projectId", type, value, label, "order", "createdAt")
VALUES ('pd-1', 'p-current', 'PERCENTAGE', 5, 'Volume discount', 0, now());
`

/** Build a genuine V4 snapshot through the production snapshot builder
 * (the same code path the application uses) so the readiness snapshot
 * policy classifies it as a valid, restorable V4 snapshot. */
async function buildV4SnapshotPayload(databaseUrl) {
  const snapshotServicePath = join(serverDir, 'src', 'lib', 'projectSnapshotService.js').replace(/\\/g, '/')
  const outputPath = join(serverDir, '.pr2-snapshot-output.json')
  const helperPath = join(serverDir, '.pr2-snapshot-helper.ts')
  writeFileSync(helperPath, `
    import { writeFileSync } from 'node:fs'
    import { PrismaPg } from '@prisma/adapter-pg'
    import { PrismaClient } from '@prisma/client'
    import { buildSnapshot } from '${snapshotServicePath}'
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
    try {
      const snap = await buildSnapshot('p-current', prisma)
      writeFileSync('${outputPath.replace(/\\/g, '/')}', JSON.stringify(snap))
    } finally {
      await prisma.$disconnect()
    }
  `)
  try {
    await runCommand(
      'npx', ['tsx', '.pr2-snapshot-helper.ts'],
      { cwd: serverDir, env: { ...process.env, DATABASE_URL: databaseUrl }, signal: guard.abortSignal },
    )
    return JSON.parse(readFileSync(outputPath, 'utf8'))
  } finally {
    rmSync(helperPath, { force: true })
    rmSync(outputPath, { force: true })
  }
}

// Invalid-state seed (scenario C): a CURRENT project whose resource type has
// NO persisted capacity profile — the readiness completeness blocker that
// must fail closed before the destructive migration.
const INVALID_SEED_SQL = `
INSERT INTO "User" (id, email, name, password, role, "createdAt", "updatedAt")
VALUES ('u-c', 'pr2-invalid-test@example.com', 'PR2 Invalid', 'x', 'USER', now(), now());

INSERT INTO "Project" (id, name, "ownerId", "planningState", "createdAt", "updatedAt")
VALUES ('p-invalid', 'Invalid Current Project', 'u-c', 'CURRENT', now(), now());

INSERT INTO "ResourceType" (id, name, category, count, "projectId")
VALUES ('rt-invalid-1', 'Unprofiled Role', 'ENGINEERING', 1, 'p-invalid');
`

// ─── PostgreSQL source lifecycle ─────────────────────────────────────────

let maintenanceUrl = externalUrl
let dockerEnvironment = null
let containerName = null

test.before(async () => {
  if (externalUrl) {
    // Externally managed: the URL IS the management target (mirrors the
    // lifecycle module). Scenario databases are created/dropped inside it.
    maintenanceUrl = externalUrl
    return
  }
  const started = await startDockerPostgres({ signal: guard.abortSignal })
  containerName = started.name
  dockerEnvironment = started.dockerEnv
  maintenanceUrl = started.databaseUrl
  // The container may still be initialising; poll until it accepts queries
  // (bounded, so a broken container fails fast instead of racing the suites).
  let lastError
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      await query(maintenanceUrl, 'SELECT 1')
      return
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  throw new Error(`PostgreSQL container did not become ready: ${lastError?.message ?? 'unknown error'}`)
})

test.after(async () => {
  if (dockerEnvironment && containerName) {
    await stopDockerPostgres({ name: containerName, dockerEnv: dockerEnvironment }, { signal: guard.abortSignal })
  }
  guard.dispose()
})

// ─── Scenario A — clean database ─────────────────────────────────────────

test('A. clean database migrates through full history to the new schema', async () => {
  const name = scenarioName('clean')
  let databaseUrl
  try {
    await dropScenarioDatabase(maintenanceUrl, name)
    databaseUrl = await createScenarioDatabase(maintenanceUrl, name)
    await deployMigrations(databaseUrl)

    const applied = await migrationNames(databaseUrl)
    assert.equal(applied.length, 39, 'expected all 39 migrations to apply')
    assert.equal(applied[applied.length - 1], NEW_MIGRATION, 'new migration is last in history')

    const rtColumns = new Set(await columnsFor(databaseUrl, 'ResourceType'))
    const nrColumns = new Set(await columnsFor(databaseUrl, 'NamedResource'))
    for (const { table, column } of CANDIDATE_COLUMNS) {
      const cols = table === 'ResourceType' ? rtColumns : nrColumns
      assert.ok(!cols.has(column), `candidate column ${table}.${column} must be dropped`)
    }
    for (const { table, column } of RETAINED_COLUMNS) {
      const cols = new Set(await columnsFor(databaseUrl, table))
      assert.ok(cols.has(column), `retained column ${table}.${column} must still exist`)
    }
    // AllocationMode type is deliberately retained (historical snapshot
    // payload types still reference it); only the 11 columns are removed.
    const enumRow = await query(databaseUrl, `SELECT 1 FROM pg_type WHERE typname = 'AllocationMode'`)
    assert.equal(enumRow.rowCount, 1, 'AllocationMode type is retained deliberately')
  } finally {
    await dropScenarioDatabase(maintenanceUrl, name)
  }
})

// ─── Scenario B — representative pre-PR-2 database ───────────────────────

test('B. representative pre-PR-2 database survives with only the 11 columns dropped', async () => {
  const name = scenarioName('rep')
  let databaseUrl
  try {
    await dropScenarioDatabase(maintenanceUrl, name)
    databaseUrl = await createScenarioDatabase(maintenanceUrl, name)

    // 1. Migrate to the pre-PR-2 state (38 migrations; new migration hidden).
    await deployMigrations(databaseUrl, { hideNewMigration: true })
    let applied = await migrationNames(databaseUrl)
    assert.equal(applied.length, 38, 'expected 38 pre-PR-2 migrations')
    assert.ok(!applied.includes(NEW_MIGRATION))

    // 2. Seed representative state with legacy columns at non-default values,
    //    then capture a genuine V4 snapshot through the production builder.
    await query(databaseUrl, SEED_SQL)
    const snapshotPayload = await buildV4SnapshotPayload(databaseUrl)
    await query(
      databaseUrl,
      `INSERT INTO "BacklogSnapshot" (id, "projectId", label, trigger, snapshot, "createdAt", "createdById")
       VALUES ('snap-1', 'p-current', 'PR2 representative V4', 'manual', $1::jsonb, now(), 'u-1')`,
      [JSON.stringify(snapshotPayload)],
    )

    // Pre-migration sanity: the candidate columns physically exist.
    for (const { table, column } of CANDIDATE_COLUMNS) {
      const cols = new Set(await columnsFor(databaseUrl, table))
      assert.ok(cols.has(column), `pre-migration ${table}.${column} must exist`)
    }

    // 3. The documented fail-closed prerequisite (readiness) accepts this
    //    representative state before the migration (CURRENT canonical,
    //    NEEDS_REPLAN quarantined, V4 snapshot only).
    assert.equal(await runReadiness(databaseUrl), 0, 'readiness passes on representative pre-PR-2 state')

    // 4. Apply the new migration — only it is applied.
    await deployMigrations(databaseUrl)
    applied = await migrationNames(databaseUrl)
    assert.equal(applied.length, 39, 'exactly one new migration applied')
    assert.equal(applied[applied.length - 1], NEW_MIGRATION)

    // 5. Only the 11 candidate columns disappear.
    for (const { table, column } of CANDIDATE_COLUMNS) {
      const cols = new Set(await columnsFor(databaseUrl, table))
      assert.ok(!cols.has(column), `candidate column ${table}.${column} must be dropped`)
    }

    // 6. Projects/backlog/resource identities/count/hours/day/rates/pricing
    //    metadata, profiles, segments, planning state, V4 snapshot and
    //    commercial/business rows all remain.
    const rt = await query(databaseUrl, `SELECT * FROM "ResourceType" WHERE id = 'rt-role-1'`)
    assert.equal(rt.rows.length, 1)
    assert.equal(rt.rows[0].name, 'Engineer')
    assert.equal(rt.rows[0].count, 2)
    assert.equal(Number(rt.rows[0].hoursPerDay), 7.6)
    assert.equal(Number(rt.rows[0].dayRate), 1200)
    assert.equal(rt.rows[0].category, 'ENGINEERING')
    assert.equal(rt.rows[0].proposedName, 'Engineer (proposed)')

    const nr = await query(databaseUrl, `SELECT * FROM "NamedResource" WHERE id = 'nr-person-1'`)
    assert.equal(nr.rows.length, 1)
    assert.equal(nr.rows[0].name, 'Alice')
    assert.equal(nr.rows[0].resourceTypeId, 'rt-role-1')
    assert.equal(nr.rows[0].pricingModel, 'ACTUAL_DAYS')

    const profileCount = await query(databaseUrl, `SELECT COUNT(*)::int AS c FROM "CapacityProfile"`)
    assert.equal(profileCount.rows[0].c, 2, 'capacity profiles remain')
    const segmentCount = await query(databaseUrl, `SELECT COUNT(*)::int AS c FROM "CapacitySegment"`)
    assert.equal(segmentCount.rows[0].c, 4, 'capacity segments remain')
    const seg = await query(databaseUrl, `SELECT * FROM "CapacitySegment" WHERE id = 'seg-2'`)
    assert.equal(Number(seg.rows[0].capacityPercent), 50)
    const profileLegacy = await query(databaseUrl, `SELECT legacy FROM "CapacityProfile" WHERE id = 'cp-role-1'`)
    assert.ok(profileLegacy.rows[0].legacy, 'CapacityProfile.legacy remains')

    const planning = await query(
      databaseUrl,
      `SELECT "planningState" FROM "Project" WHERE id IN ('p-current','p-replan') ORDER BY id`,
    )
    assert.deepEqual(planning.rows.map(r => r.planningState), ['CURRENT', 'NEEDS_REPLAN'])

    const counts = await query(
      databaseUrl,
      `SELECT
         (SELECT COUNT(*)::int FROM "Epic") AS epics,
         (SELECT COUNT(*)::int FROM "Feature") AS features,
         (SELECT COUNT(*)::int FROM "UserStory") AS stories,
         (SELECT COUNT(*)::int FROM "Task") AS tasks,
         (SELECT COUNT(*)::int FROM "StoryTimelineEntry") AS story_entries,
         (SELECT COUNT(*)::int FROM "ProjectOverhead") AS overheads,
         (SELECT COUNT(*)::int FROM "ProjectDiscount") AS discounts,
         (SELECT COUNT(*)::int FROM "BacklogSnapshot") AS snapshots`,
    )
    assert.deepEqual(counts.rows[0], {
      epics: 1, features: 1, stories: 1, tasks: 1, story_entries: 1,
      overheads: 1, discounts: 1, snapshots: 1,
    })

    const snapshot = await query(databaseUrl, `SELECT snapshot FROM "BacklogSnapshot" WHERE id = 'snap-1'`)
    assert.equal(snapshot.rows[0].snapshot.schemaVersion, 4, 'V4 snapshot remains intact')

    // 7. Readiness still passes on the migrated representative state.
    assert.equal(await runReadiness(databaseUrl), 0, 'readiness passes on migrated representative state')
  } finally {
    await dropScenarioDatabase(maintenanceUrl, name)
  }
})

// ─── Scenario C — invalid prerequisite state fails closed ────────────────

test('C. readiness refuses an invalid prerequisite state (fail-closed)', async () => {
  const name = scenarioName('invalid')
  let databaseUrl
  try {
    await dropScenarioDatabase(maintenanceUrl, name)
    databaseUrl = await createScenarioDatabase(maintenanceUrl, name)
    await deployMigrations(databaseUrl, { hideNewMigration: true })

    // A CURRENT project whose resource type has no persisted ROLE profile:
    // the readiness completeness blocker that must stop the migration.
    await query(databaseUrl, INVALID_SEED_SQL)

    const exitCode = await runReadiness(databaseUrl)
    assert.notEqual(exitCode, 0, 'readiness must fail closed on invalid prerequisite state')

    // Readiness is read-only: no migration was applied, nothing changed.
    const applied = await migrationNames(databaseUrl)
    assert.equal(applied.length, 38, 'readiness must not apply migrations')
    const rtColumns = new Set(await columnsFor(databaseUrl, 'ResourceType'))
    assert.ok(rtColumns.has('allocationMode'), 'invalid state did not drop columns')
  } finally {
    await dropScenarioDatabase(maintenanceUrl, name)
  }
})
