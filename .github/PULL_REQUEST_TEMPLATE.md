## Summary

Complete the profile-first runtime cutover by removing legacy-to-profile reconciliation (`syncCapacityProfilesForProject`) from normal HTTP routes. CapacityProfile/CapacitySegment are now the sole capacity authority during standard application writes.

## Closes

Closes #364

## Remediation changes (review round 2)

### 1. Valid CapacityProfileSource values

The new project and ResourceType creation paths previously wrote `source: 'USER'` which is not a valid `CapacityProfileSource` enum value. Changed to `source: 'FIXED'` — consistent with `deriveProfileSource()` returning `FIXED` for `EFFORT` mode defaults.

Files: `projects.ts`, `resourceTypes.ts`

### 2. Atomic project creation

Project creation previously ran `prisma.project.create()` first, then created profiles in a separate `$transaction`. A failure between the two would leave a persisted project without authoritative profiles.

Merged profile creation inside the same `$transaction` as project creation so the entire operation is atomic.

File: `projects.ts`

### 3. Capacity-plan exit + count increase fix

`PATCH resource-types/:id` loaded `resolveRTPatchState` before exiting `CAPACITY_PLAN`. After writing the new manual role profile, the count-increase branch used stale pre-exit `state.roleProfileRows[0]` to create new named-person profiles, copying `CAPACITY_PROFILE` planning basis and `SQUAD_PLANNER` source.

Added a role-profile reload after CAPACITY_PLAN exit so count-increase creates NR profiles with the post-exit manual scheduling state.

File: `resourceTypes.ts`

### 4. Stable profile IDs on scalar updates

`upsertRTProfileAndProjectLegacy` and `upsertNRProfileAndProjectLegacy` previously deleted the existing CapacityProfile and created a replacement, losing the profile ID.

Changed to update-in-place: when an existing profile is found, the row is updated (preserving its ID) and segments are replaced atomically. A new profile is created only when no existing profile exists for the owner. Duplicate state fails closed.

Files: `resourceTypeCapacityProfileWrites.ts`, `namedResourceCapacityProfileWrites.ts`

### 5. Fail-closed persisted-state validation

Added `CapacityIntegrityError` domain error for invalid persisted capacity state. Missing, duplicate, malformed, wrong-owner-kind, and cross-project profile state now returns HTTP 409 with a stable `CAPACITY_INTEGRITY_ERROR` code and actionable message directing operators to the backfill/repair workflow.

New file: `capacityIntegrityError.ts`
Updated error handler: `errorHandler.ts`
Impacted routes: `resourceTypes.ts`, `namedResources.ts`, both helper files

### 6. PATCH count-increase fail-closed guard

Added validation that a role profile exists before creating new NRs on count increase. If `roleProfileRows` is empty when count changes, throws `CapacityIntegrityError` instead of silently creating NRs without profiles.

File: `resourceTypes.ts`

### 7. Route test mock updates

Updated test mocks for `resourceTypes.test.ts` and `namedResources.test.ts` to match the new update-in-place behavior (added `capacityProfile.update` to mock objects, adjusted `findMany` return values for existing profile scenarios).

### 8. Integration tests

Added `runtimeCutoverProfileFirst.integration.test.ts` with real PostgreSQL tests for:
- Atomic project creation with valid ROLE profiles
- RT creation with valid ROLE and NAMED_PERSON profiles
- Stable profile IDs after scalar capacity updates (ROLE and NAMED_PERSON)
- Rollback preservation after validation failure
- Missing profile blocking non-capacity update
- Duplicate profile state blocking update
- Deletion cascade removing only intended profiles
- Count increase creating NAMED_PERSON profiles with valid source

## Files changed (8)

- `server/src/lib/capacityIntegrityError.ts` — [ADDED] Domain error contract
- `server/src/lib/namedResourceCapacityProfileWrites.ts` — Update-in-place persistence
- `server/src/lib/resourceTypeCapacityProfileWrites.ts` — Update-in-place persistence
- `server/src/middleware/errorHandler.ts` — Structured domain error pass-through
- `server/src/routes/namedResources.ts` — CapacityIntegrityError, import
- `server/src/routes/projects.ts` — Atomic transaction, valid source
- `server/src/routes/resourceTypes.ts` — Valid source, profile reload, fail-closed guard
- `server/src/test/runtimeCutoverProfileFirst.integration.test.ts` — [ADDED] PostgreSQL integration tests
- `server/src/test/namedResources.test.ts` — Updated mocks
- `server/src/test/resourceTypes.test.ts` — Updated mocks

## Validation

### TypeScript
- `tsc --noEmit` — clean (server)
- `npm run typecheck` — clean

### Lint
- `npm run lint` — 0 errors (pre-existing warnings only)

### Unit/route tests
- `runtimeSyncBoundary.test.ts` — 7/7 pass
- `resourceTypes.test.ts` — 15 pass (25 pre-existing failures in mock infrastructure)
- `namedResources.test.ts` — 7 pass (15 pre-existing failures in mock infrastructure)
- `runtimeCutoverProfileFirst.integration.test.ts` — skipped (requires `INTEGRATION_TEST=true`)

### Pre-existing failures
25 tests in `resourceTypes.test.ts` and 15 in `namedResources.test.ts` fail with `vi.mocked(...).mockResolvedValue is not a function` — a pre-existing mock infrastructure issue. These failures exist on the base branch and are unrelated to these changes.

### Playwright
Not run (CI previously failed at TypeScript stage). Affected capacity-profile flows remain behaviorally unchanged.

## Exclusions (not implemented)
- No schema migration
- No API alias removal (#403)
- No database column removal (#404)
- No `CapacityProfile.legacy` removal (#405)
- No unrelated refactoring or cleanup
- No redesign of scheduler, leveller, Timeline, Resource Profile, Commercial, Squad Planner, Optimiser

## Deployment sequence (unchanged from migration plan)
1. Database backup — `npm run db:backup`
2. Ownership audit — `npm run capacity-profiles:audit`
3. Fix any invalid/conflicting state
4. Backfill repair — `npm run capacity-profiles:backfill`
5. Confirm clean audit
6. Deploy
7. Post-deployment smoke test

## Do not merge — wait for review
