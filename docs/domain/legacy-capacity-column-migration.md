# Legacy capacity-column migration (Issue #418 — PR 2)

## Status

- This PR is **development-machine authored** (issue #418 machine boundary).
- This PR does **not** run the migration on the useful production database.
- The live rollout is owned by **#404** and must not be executed from this
  PR or by the development machine.
- This PR contains exactly **one reviewed destructive Prisma migration**:
  `20260810072212_drop_legacy_capacity_columns`.

## Migration content

The single migration drops **exactly the 11 approved candidate columns**:

| Model | Columns dropped |
|---|---|
| `ResourceType` | `allocationMode`, `allocationPercent`, `allocationStartWeek`, `allocationEndWeek` |
| `NamedResource` | `allocationMode`, `allocationPercent`, `allocationPct`, `allocationStartWeek`, `allocationEndWeek`, `startWeek`, `endWeek` |

There is no data backfill, no historical-capacity inference, no default 100%
profile creation, no unrelated table/index/constraint changes and no
`CapacityProfile.legacy` removal (`CapacityProfile.legacy` remains tracked
by #405). Independent resource metadata is untouched:
`ResourceType.count`/`hoursPerDay`/`dayRate`/identity/name/category and
`NamedResource.name`/`resourceTypeId`/`pricingModel`.

The `AllocationMode` PostgreSQL type is deliberately retained: historical
snapshot payload type definitions (`projectSnapshotTypes.ts`) still reference
`$Enums.AllocationMode`, and keeping the type keeps the migration strictly a
column drop.

## Fail-safe prerequisite behaviour

The destructive migration uses the **existing** readiness gate — no new
migration framework is introduced:

- `npm run capacity-profiles:readiness` is the standalone read-only
  fail-closed gate (PR 1, issue #418). It blocks on missing/duplicate/
  malformed/cross-project profile ownership, completeness/shape blockers
  and any pre-V4 or malformed `BacklogSnapshot` row, and it accepts only
  canonical `CURRENT` projects plus explicitly quarantined `NEEDS_REPLAN`
  projects (issue #449).
- The ownership-invariant CHECK constraints and partial unique indexes
  (`20260721000001_enforce_capacity_profile_ownership_invariants`) remain
  authoritative at the database level.
- The migration itself is plain `DROP COLUMN` SQL; #404 must rerun readiness
  immediately before the migration and stop on any non-zero exit
  (scenario C of `scripts/migration-drop-legacy-columns.test.mjs` proves
  this fail-closed behaviour).

## Production deployment procedure (#404)

1. Install the **exact reviewed PR 2 merge commit** on the production
   machine. Do not run `ALTER TABLE` by hand.
2. **Stop the application or enter verified maintenance mode** — application
   writes must be stopped before the migration.
3. **Rerun readiness** against the live database
   (`npm run capacity-profiles:readiness`) and require exit `0`.
4. Create a **fresh final pre-migration PostgreSQL backup**
   (`npm run db:backup`) and retain it; restore-test it into a disposable
   database and verify the expected migration state.
5. Verify the expected application commit, the migration name
   (`20260810072212_drop_legacy_capacity_columns`) and the target database.
6. Run `prisma migrate deploy` from the exact commit (`server/`).
7. Confirm exactly the 11 columns above are gone and every other column and
   table is unchanged.
8. Start the application on the PR 2 commit and run the initial
   post-migration validation (see #404 Phase 5).

### Rollback

Rollback is **PostgreSQL backup restoration** (the retained pre-migration
backup), not a reverse migration. There is no reverse migration that
recreates empty legacy columns.

## Development-machine validation

All migration/integration testing uses disposable PostgreSQL databases on
the development machine:

- `npm run validate` — lint, type-check, build, unit and client tests,
  backup regression and lifecycle tests.
- `npm run test:integration:local` — Docker-first PostgreSQL integration
  suites (snapshot rollback, clone, Squad Planner, named-resource guard,
  optimiser apply, scheduler capacity, ownership invariants, runtime
  cutover, transfer, legacy alias removal, pre-V4 purge, planning reset).
- `npm run test:migration-pr2` — focused destructive-migration safety tests
  against disposable PostgreSQL:
  - **A. Clean database** — full migration history applies to an empty
    database; the result lacks exactly the 11 columns; retained columns and
    the `AllocationMode` type remain.
  - **B. Representative pre-PR-2 database** — a database at the pre-PR-2
    migration state seeded with representative ResourceTypes,
    NamedResources, CapacityProfiles, CapacitySegments, CURRENT and
    NEEDS_REPLAN projects, backlog/business rows and a V4 snapshot (with the
    legacy columns at non-default values) survives the migration with only
    the 11 columns dropped and readiness passing before and after.
  - **C. Invalid prerequisite state** — readiness refuses (non-zero exit) a
    CURRENT project whose roles lack canonical profiles, proving the
    destructive migration cannot silently proceed from invalid state.

## Changes in this PR

- Prisma schema: the 11 candidate fields are removed from
  `ResourceType`/`NamedResource`.
- One migration: `20260810072212_drop_legacy_capacity_columns` (11
  `DROP COLUMN` statements, nothing else).
- Code made invalid by the column removal:
  - the retired #421 remediation tooling
    (`remediateProductionReadiness`, `productionRemediationPlan`,
    `productionRemediationApply`, `generateSnapshotEvidence`,
    `snapshotEvidence` and their tests/commands) is removed — #421 is closed
    as not planned and #404 must not apply it; its inputs (the candidate
    columns and pre-V4 snapshots) no longer exist;
  - routes that consumed raw legacy columns for scheduler/commercial input
    now derive the scheduler DTOs exclusively from
    `resolveSchedulerCapacity` (profile-derived);
  - tests whose fixtures/assertions referenced the removed columns are
    updated to assert authoritative profile state.
- The source guard
  (`server/src/test/legacyCapacityFieldSourceGuard.test.ts`) still proves
  production code cannot access the deleted fields via Prisma
  `resourceType`/`namedResource` queries; its allowlist was trimmed to the
  surviving permitted files.
- `scripts/migration-drop-legacy-columns.test.mjs` — focused migration
  safety tests (wired into the Docker-first CI job).

## Post-merge

- #404 executes the production deployment procedure above.
- PR 3 (temporary-tooling cleanup) remains **blocked** until #404 records a
  successful live migration and initial production validation.
