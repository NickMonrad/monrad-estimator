# Capacity Profile — Source-of-Truth Migration Plan

**Epic:** #340  
**Status:** Phase 1 (Read-side contracts) ✅ (PR #356 merged)  
**PR:** #344 (plan document), #356 (read adoption; merged)

## Overview

Issues #326, #336, #337, #338, #339, and issue #341 define the `CapacityProfile`/`CapacitySegment` adoption plan.

PR #336 introduced the persisted-read endpoint (`GET /capacity-profiles`) with a
reconciliation gate — persisted profiles were used only when they matched
legacy-derived expectations.

PR #356 (profile-first read adoption, merged) removed that lossy reconciliation
gate for Resource Profile and exports. PR #359 completes the boundary for the
Squad Planner apply path: a structurally valid persisted profile set is
authoritative for capacity availability; fallback is used only when persisted
data is missing, structurally invalid, or contains duplicate physical owner IDs
(same `namedResourceId` across `NAMED_PERSON`/`PLANNED_RESOURCE`). Fallback is
**all-or-nothing** — the entire persisted set must pass structural validation,
or the complete legacy projection is used; per-owner persisted/legacy merging
would silently drop or corrupt incomplete data. When valid, persisted profiles
preserve stable IDs, segment boundaries, and capacity trajectories with no
lossy truncation. Owner-aware validation: `ROLE` percent fields are unbounded
(multi-person aggregate); `NAMED_PERSON` and `PLANNED_RESOURCE` are bounded to
[0,100]. `projectCapacityProfileToLegacyAllocation` supplies display-field
projection without changing calculation inputs.

CapacityProfile/CapacitySegment own capacity availability. Timeline/Planning owns
assignment windows, scheduled demand, and the weekly demand cache. Commercial owns
pricing, billing basis, and billable calculations. `ResourceType.count` remains
role metadata for phantom staffing slots, not a capacity-profile field.
ResourceType and NamedResource legacy allocation fields remain compatibility
projections for unmigrated consumers. They are no longer a competing authority
for profile-backed availability.

## Principles

1. **Read adoption before write migration.** Read paths were migrated first (#336), then
   profile-first writes and Resource Profile/export reads adopted persisted capacity data
   (#355, #356).
2. **Persisted profiles are authoritative when structurally valid.** Do not use a
   lossy compare gate; fall back only for missing or structurally invalid persisted data.
3. **Keep legacy fields as compatibility projections** until all consumers have migrated.
   Do not remove them until #342.
4. **Separate availability, assignment, and billing.** CapacityProfile owns availability;
   Timeline/Planning owns assignments and weekly demand; Commercial owns billing.
5. **Make planner writes atomic and undoable.** Plan, profile, legacy projection,
   timeline, and weekly-cache writes commit together; the pre-apply snapshot remains
   available when the domain transaction rolls back.
6. **Keep deterministic identity.** Role and named-resource matching uses stable IDs and
   names; explicit/manual resources are never silently overwritten or deleted.
7. **All-or-nothing persistence authority.** The entire persisted profile set
   must pass structural validation, or the complete legacy projection is used.
   Per-owner persisted/legacy merging is never performed — it would silently
   drop or corrupt incomplete data.
8. **Owner-aware validation boundaries.** ROLE-kind percent fields
   (`defaultPercent`, segment `capacityPercent`) may exceed 100, representing
   multi-person aggregate capacity. NAMED_PERSON and PLANNED_RESOURCE percents
   are bounded to [0,100]. Duplicate physical owner keys (same FK namespace +
   ID, e.g. the same `namedResourceId` across owner kinds) are structurally
   invalid.

## Audit

### Field classification

#### Future CapacityProfile source-of-truth fields

| Table | Field | Maps to |
|-------|-------|---------|
| `ResourceType` | `allocationMode` | `CapacityProfile.planningBasis` (role level) |
| `ResourceType` | `allocationPercent` | default segment `capacityPercent` or role fixed FTE |
| `ResourceType` | `allocationStartWeek` | role availability-window segment start |
| `ResourceType` | `allocationEndWeek` | role availability-window segment end |
| `NamedResource` | `allocationMode` | `CapacityProfile.planningBasis` (per-named-resource) |
| `NamedResource` | `allocationPercent` / `allocationPct` | default segment `capacityPercent` (field precedence: `allocationPercent > allocationPct`) |
| `CapacityPlan` | all periods/entries | Squad Planner generated profiles |

#### Legacy compatibility projections

For the ResourceType and NamedResource write paths migrated by PR #355, these fields
are profile → legacy compatibility projections. Unmigrated consumers still read the
legacy fields directly, so removal remains deferred.

Additional NamedResource fields that serve as legacy availability-window compatibility fields:

| Table | Field | Role |
|-------|-------|------|
| `NamedResource` | `allocationStartWeek` | explicit legacy availability-window compatibility field |
| `NamedResource` | `allocationEndWeek` | explicit legacy availability-window compatibility field |
| `NamedResource` | `startWeek` / `endWeek` | legacy fallback availability-window fields used by older paths; not actual scheduled assignment source of truth |

> **Capacity vs assignment separation:** `CapacityProfile` / `CapacitySegment` describe **availability/capacity over time**. Actual assignment windows, weeks, and segments produced by the scheduler/planning model are not CapacityProfile-owned. The profile describes what *could* be assigned; the scheduler decides what *is* assigned. Commercial billing basis is independent metadata owned by the Commercial domain.

This means:
- Capacity profile = what capacity exists (W1–W4: 50%, W5–W8: 100%)
- Assigned work = what the scheduler allocated (actual demand consumed)
- Billing basis = what Commercial charges for (bill planned allocation, bill actual scheduled days, etc.)

#### Independent metadata (not capacity-profile-owned)

| Table | Field | Reason |
|-------|-------|--------|
| `ResourceType` | `count` | Role metadata. Affects phantom slot count (`count - namedResources.length`) in scheduler. Stays role-level metadata. |
| `NamedResource` (runtime) | `synthetic` | Runtime-computed property (not a Prisma column) flagging planned resource vs named person. Maps to `ownerKind` in capacity profile. Independent identity metadata derived from NR generation context. |

### Key risks

1. **Multi-segment → single start/end projection is inherently lossy.** A profile with segments `{W1-W4: 50%, W5-W10: 100%, W11-W14: 25%}` cannot be represented in a single `(startWeek, endWeek)` pair without losing information. Compatibility projections will need a strategy for truncation or the first/last segment.
2. **Planned-resource identity instability.** Preview paths generate IDs like `capacity-plan-${rt.id}-${idx}`. Actual persisted NRs get stable IDs from the DB, but fallback paths from the adapter use IDs like `synthetic-{rt.id}-{N}`. Stable identity is a prerequisite for `PLANNED_RESOURCE` becoming authoritative.
3. **`allocationPct` vs `allocationPercent` duality.** `NamedResource` has both. The model uses `allocationPercent` over `allocationPct` when both are set (`resourceProfile.ts` line ~196 and `mappers.ts`). Migration must preserve this precedence and consider dropping one.
4. **`CAPACITY_PLAN` mode is a special case.** When `allocationMode === 'CAPACITY_PLAN'`, allocation fields are meaningless — capacity is derived from the active `CapacityPlan`. The mapping function (`capacityProfileMapping.ts`) already handles this by constructing segments from plan entries. Source-of-truth migration must preserve this derivation or make it explicit.
5. **Squad Planner generates non-deterministic preview IDs.** Preview resources (`capacity-plan-*`) are not stable across sessions. Stable identity requires writing actual DB rows during planning, not just in "apply".
6. **`shouldFallbackToActiveCapacityPlan` logic is scattered.** The function lives in `mappers.ts` but similar fallback logic exists in `resourceProfile.ts`, `timeline.ts`, and `projectPlanningModel.ts`. These must converge before or during migration.
7. **`phantomSlots` in scheduler.** `scheduler.ts` computes `phantomSlots = resourceType.count - namedResources.length`, implicitly depending on `ResourceType.count`. This ties role-level count to scheduling behaviour independently of capacity profiles.

**Server lib:**
- `server/src/lib/capacityProfileMapping.ts` — core mapper: `mapProjectToCapacityProfiles` derives profiles from legacy fields
- `server/src/lib/syncCapacityProfiles.ts` — `syncCapacityProfilesForProject` upserts/deletes segments to match mapped profiles
- `server/src/lib/reconcileCapacityProfiles.ts` — `compareCapacityProfiles` compares mapped vs persisted
- `server/src/lib/backfillCapacityProfiles.ts` — iterates projects calling sync
- `server/src/lib/capacityProfileResourceAdapter.ts` — #341 adapter with profile-first precedence; `buildResourceCapacityProfileMap` returns map keyed by owner id with `resolutionSource`
- `server/src/lib/capacityProfileLegacyProjection.ts` — #341 helper: `projectCapacityProfileToLegacyAllocation` projects profile data into legacy display field shape
- `server/src/lib/projectPlanningModel.ts` — reads RT/NR allocation fields for resource-demand calculation
- `server/src/lib/namedResourceAssignments.ts` — reads NR allocation fields for assignment logic

### Phase 2b — Snapshot v3 capacity-profile preservation ✅ (PR #367 merged)

PR #367 (merged, branch `feature/snapshot-v3-capacity-profiles`) extended the
BacklogSnapshot schema to version 3 so that rollback preserves capacity profile data.
Snapshot v3 is the first-class representation for capacity profiles; v2 and v1 snapshots
are still accepted on restore, but v1 is epic-only (profiles untouched) and v2 is
best-effort compatibility reconstruction (no segments or planned-resource ownership restored).

#### Schema versions

| Version | Identifier | Content |
|---------|-----------|---------|
| **V1** | No `schemaVersion` field (bare epic array or `{ epics: … }` without `schemaVersion`) | Epic tree only. No resource types, named resources, timeline entries, dependencies, overheads, capacity profiles, or capacity-plan history. |
| **V2** | `schemaVersion: 2` | Epic tree + project fields + resource types + named resources + timeline entries + story timeline entries + dependencies + overhead items. No first-class capacity profiles or capacity-plan history. |
| **V3** | `schemaVersion: 3` | All V2 fields plus `capacityProfiles`, exact `capacityPlans` history, and the optional `weeklyDemandCache`. |

#### V3 snapshot content

`buildSnapshot` (in `projectSnapshotService.ts`) returns `schemaVersion: 3` for all new
application snapshots (manual, `csv_import`, `template_apply`, `optimiser_apply`, and
`pre_rollback` triggers). The v3 payload includes:

- **CapacityProfile**: `id`, `ownerKind` (`ROLE`/`NAMED_PERSON`/`PLANNED_RESOURCE`),
  `resourceTypeId` or `namedResourceId` (owner identity), `planningBasis`, `source`,
  `defaultPercent` (nullable), `startWeek`/`endWeek` (nullable profile window),
  `legacy` (original legacy JSON, which may be `null`), and `segments`.
- **CapacitySegment** (per profile): `id`, `startWeek`, `endWeek`, `capacityPercent`,
  `source`.
- **CapacityPlan history**: exact plan, period, and entry IDs and values, including
  activation, summary fields, and timestamps. Restore replaces the project's plan
  history rather than interpolating from legacy fields.
- **Weekly demand cache**: the optional `weeklyDemandCache` map is validated as finite
  numeric values and restored with the project state.
- Profiles, plans, periods, and entries are ordered deterministically by stable IDs.

#### Pre-rollback capture

Before any destructive rollback write, the current project state is captured as a v3
snapshot (`trigger: 'pre_rollback'`) inside the same transaction that applies the
rollback. This makes rollback itself reversible. Squad Planner apply uses the same
snapshot builder immediately before its domain transaction; that snapshot is deliberately
outside the transaction so it remains available when an apply fails and rolls back.
Retention of the pre-rollback snapshot is subject to the same `pruneSnapshots` (keep 20
most-recent) policy as all other snapshots.

#### V3 validation

Before any destructive write begins, the target snapshot is validated structurally:

- Profile `id` and segment `id`: non-empty, globally unique within the snapshot.
- `ownerKind`: member of `[ROLE, NAMED_PERSON, PLANNED_RESOURCE]`.
- Owner-kind shape rules: `ROLE` requires non-empty `resourceTypeId` and null `namedResourceId`;
  `NAMED_PERSON`/`PLANNED_RESOURCE` require non-empty `namedResourceId` and null `resourceTypeId`.
- Owner reference integrity: `resourceTypeId` exists in the snapshot's `resourceTypes` list;
  `namedResourceId` exists in `namedResources`; the named resource's own `resourceTypeId` also exists.
- Every `NamedResource.resourceTypeId` and every non-null `overheadItems.resourceTypeId` exists in the snapshot's `resourceTypes` list.
- `planningBasis` and `source` belong to the supported Prisma enum sets.
- `defaultPercent`: null or finite ≥ 0.
- Profile `startWeek`/`endWeek`: null or finite number with end ≥ start.
- Segment `startWeek`/`endWeek`: finite numbers with end ≥ start.
- Segment `capacityPercent`: finite ≥ 0.
- Segment `source`: supported enum value.
- The `legacy` field is captured as-is (`unknown`); its content is not validated.

What is **not** rejected:
- Duplicate owner keys (same `resourceTypeId`/`namedResourceId` across multiple profiles) —
  preserved for #361 (consolidation).
- Role-level aggregate > 100% — valid for multi-resource roles.
- Overlapping or discontinuous segments — the profile shape is preserved exactly.

Additionally, a cross-project relation preflight verifies that all snapshot
`resourceTypes`, `namedResources`, and resource-type FKs on overhead items do not
belong to another project in the current DB state, preventing orphaned
cross-project references before any write begins.

#### V3 restore (exact replacement)

V3 restore runs in the same atomic `$transaction` as the full project state restore:

1. Pre-rollback v3 snapshot of current project state.
2. Common v2 restoration: upsert ResourceTypes, upsert NamedResources, delete-and-recreate
   epics (with cascade), update project fields, delete-and-recreate timeline entries,
   story timeline entries, dependencies, and overhead items.
3. **Capacity profile replacement**: delete ALL existing `CapacityProfile` and
   `CapacitySegment` rows for the project, then recreate every profile with its exact
   snapshot IDs, `projectId` forced to the route project, owner IDs, enum values, nulls,
   and `legacy`. Every segment is recreated with exact `id`, profile FK, values, and `source`.
4. `pruneSnapshots` (retention policy) inside the same transaction.

All writes share one transaction — any failure before commit rolls back every change
including the pre-rollback capture. The restore is an exact replacement: no broad legacy
sync or CapacityPlan interpolation follows.

#### V1 restore (epic-only)

V1 snapshots contain only an epic tree (no resource types, named resources, capacity
profiles, segments, timeline entries, or capacity plan data). Restoring a V1 snapshot:

- Deletes only epics (cascade) and recreates the tree from snapshot JSON.
- Leaves ResourceType, NamedResource, CapacityProfile, CapacitySegment, and capacity
  plan data entirely untouched.
- Resource types are still re-matched by name for task FKs (same as always).
- Timeline entries are **not** restored (same as always — Gantt regenerates).

#### V2 restore (full state + best-effort legacy profile reconstruction)

V2 snapshots capture the full project state but have no first-class `capacityProfiles`
array. During V2 restore:
1. Full common state is restored (RTs, NRs, epics, timeline, dependencies, overheads).

2. `recreateV2CapacityProfiles` runs: all existing project profiles and segments are
   **deleted**, then best-effort legacy profiles are created:
   - **Role profiles** for every snapshot `ResourceType` — each role gets a ROLE-kind
     profile with synthetic ID `snapshot-v2-role-{rtId}`.
   - **Named-person profiles** for every snapshot `NamedResource` — each named resource
     gets a NAMED_PERSON-kind profile with synthetic ID `snapshot-v2-named-{nrId}`.
   - `planningBasis` and `source` mapped from the legacy `allocationMode` field
     (`TIMELINE → AVAILABILITY_WINDOW`, `FULL_PROJECT → WHOLE_PROJECT_ALLOCATION`,
     `CAPACITY_PLAN → CAPACITY_PROFILE`, `EFFORT`/others → `DEMAND_FOLLOWING`).
   - Effective availability window resolved from `allocationPercent`/`allocationPct`
     and `allocationStartWeek`/`allocationEndWeek`/`startWeek`/`endWeek` precedence.
   - All profiles capture the original V2 field values in their `legacy` JSON.
3. **No segments are created** — V2 snapshots do not carry segment data, so profile
   availability is represented only at the profile level (no per-segment breakdown).
4. **No active Capacity Plan materialisation** — the V2 restore helper never reads
   the active `CapacityPlan`. Planned-resource ownership and manual segment fidelity
   are not claimed for V2-restored profiles.
5. The delete-and-recreate is inside the same transaction as the full state restore.

#### No Prisma schema migration in #367

PR #367 introduced no Prisma schema migration. The `capacityProfiles` field is stored
inside the existing `BacklogSnapshot.snapshot` JSON column. The new TypeScript types,
validation, and capacity helpers are pure runtime additions.

#### Capacity Plan history and v3 compatibility

PR #359 extends v3 rollback coverage to `CapacityPlan`, `CapacityPlanPeriod`, and
`CapacityPlanEntry` rows plus the project's weekly demand cache. V3 snapshots that omit
the optional `capacityPlans` or `weeklyDemandCache` fields remain backward-compatible:
restore leaves that dimension untouched. V2 and V1 behaviour is unchanged.

### Null-state discrimination & PostgreSQL rollback CI ✅ (PR #367 merged)

PR #367 (merged) introduced the
`LegacyFieldDiscriminator` type that disambiguates three distinct null-states for the
`CapacityProfile.legacy` JSON field and added parameterised null-state detection that
fails closed. The PR also added a real PostgreSQL rollback integration suite as a
required blocking CI step.

#### Legacy discriminator: DB_NULL / JSON_NULL / VALUE

The `legacy` field in `SnapshotCapacityProfile` stores the original per-profile JSON
state captured at snapshot time. When reading this field back, there are three
semantically distinct states:

| Discriminator | DB representation | Meaning |
|---------------|-------------------|---------|
| **DB_NULL** | The `legacy` column is `NULL` in the database (or absent from the JSON payload) | No legacy data was ever captured — the profile was created directly from profile-first paths, not derived from legacy fields. |
| **JSON_NULL** | The `legacy` column stores the JSON literal `null` (`… "legacy": null …` in the snapshot JSON) | Legacy data was intentionally captured as absent at snapshot time — the profile was snapshot-aware but had no legacy state to preserve. |
| **VALUE** | The `legacy` column stores a non-null JSON value (object, array, string, number, boolean) | Legacy data was captured and is available. VALUE excludes the top-level JSON `null` literal but **allows `null` nested inside the value** (e.g., `{"allocationPercent": null, "allocationMode": "TIMELINE"}`). |

The discriminator is resolved by checking the Postgres column null (`DB_NULL`) first,
then parsing the JSON to distinguish `JSON_NULL` from `VALUE`. This tri-state exists
because the `BacklogSnapshot.snapshot` column is a JSON column that roundtrips through
Prisma's JSON type; a SQL `NULL` in the column and a JSON `null` value inside the
JSON document are distinct in Postgres but collapse to the same `null` at the
application level without explicit discrimination.

#### Parameterised null-state detection

The null-state detection function `resolveLegacyFieldState` is parameterised by a
`lookup` callback so that callers can provide different query strategies (direct DB
read, snapshot JSON parse, or cached lookup) without duplicating logic:

```typescript
function resolveLegacyFieldState(
  projectId: string,
  lookup: (projectId: string) => Promise<unknown | null>,
): Promise<LegacyFieldDiscriminator>
```

**Fail-closed contract:** If the `lookup` callback rejects (query error) or returns
`undefined`/`null` for the whole row (missing snapshot), the function returns
`JSON_NULL` (the safest default — the caller must not assume VALUE data exists).
It **never** returns `VALUE` on error, never throws, and never produces a false
positive that would cause callers to interpret absent data as present.

```typescript
// Behaviour table
// lookup result              → discriminator
// Error/throw                → JSON_NULL (fail closed)
// null | undefined (no row)  → JSON_NULL (fail closed)
// DB NULL column             → DB_NULL
// JSON null value            → JSON_NULL
// Non-null JSON value        → VALUE
```

#### Real PostgreSQL rollback integration suite

PR #367 introduced a dedicated rollback integration test suite that exercises the
full snapshot → restore roundtrip against a **real PostgreSQL instance** (not
mocked/SQLite). This suite:

- Is defined in `server/src/test/rollback-pg/` and uses the same `testcontainers`
  pattern (or direct Docker PostgreSQL) as the existing PostgreSQL integration tests.
- Creates a fresh test project with ResourceTypes, NamedResources, epics, tasks,
  capacity profiles and segments (V3 snapshot target).
- Takes a V3 snapshot, mutates the project state (delete profiles, change fields),
  then restores from the snapshot and asserts exact equality.
- Exercises the `DB_NULL`, `JSON_NULL`, and `VALUE` discriminator paths with
  dedicated test cases.
- Asserts transaction atomicity: a mid-rollback failure leaves no partial state.

**CI integration:** The PostgreSQL rollback suite is configured in `.github/workflows/`
as a **required distinct CI step** that runs after the Prisma `migrations` +
`generate` step and before any seed or application-start step. This ensures:

1. Schema migrations are confirmed compatible with the target PostgreSQL version.
2. The Prisma client is generated from the just-migrated schema.
3. Rollback correctness is verified on a real PostgreSQL database **before** any
   seed data or app containers start.
4. A rollback regression blocks CI immediately — it is **not** configured with
   `continue-on-error` or `skip`, and a failure fails the workflow.

The step definition in CI:

```yaml
# PostgreSQL rollback integration (required, blocking)
# Runs after migrations+generate, before seed/start
```

#### PR #367 status

PR #367 is **merged**. V3 snapshot capacity profiles, null-state discrimination,
and the required PostgreSQL rollback CI step are all live in `main`.

**Client:**
- `client/src/components/resource-profile/ResourceProfileTab.tsx` — displays resource rows, reads `capacityProfile` if present, shows profile source tag and segments when authoritative
- `client/src/components/resource-profile/CommercialTab.tsx` — billing UI, consumes `pricingModel`, `allocationPercent`, etc.
- `client/src/hooks/useResourceProfileExport.ts` — CSV export, consumes `capacityProfile`, legacy fields; includes Planning basis, Profile source, Default capacity %, Profile start/end columns
- `client/src/pages/TimelinePage.tsx` — timeline UI, reads allocation fields via DTO
- `client/src/types/backlog.ts` — `ResourceProfileRow.capacityProfile` now has `defaultPercent`, `startWeek`, `endWeek`, `resolutionSource`

## Phase plan

### Phase 0 — Audit and decision record ✅ (this document)

The audit above classifies all fields. Remaining decisions:

| Decision | Options | Recommendation |
|----------|---------|----------------|
| `pricingModel` ownership | (a) stays Commercial metadata; (b) moves into CapacityProfile | **(a)** — Commercial field, not capacity data |
| `ResourceType.count` relation to profile | (a) stays role metadata; (b) becomes capacity-profile property | **(a)** — `count` is headcount target, not per-person capacity |
| Planned-resource identity | (a) stable IDs from DB on apply; (b) UUID-based stable IDs that survive preview | **(a)** simplest; preview never needs stable identity |
| Multi-segment backward projection | (a) truncate to first/last segment start/end; (b) leave empty; (c) emit contiguous merged range | **(c)** — merged range is safest for backward compat but semantically lossy — document limitation |
| `allocationPct` removal | (a) keep both forever; (b) normalise to `allocationPercent` only in migration | **(b)** — source-of-truth migration is the right moment |

### Phase 1 — Harden read-side contracts ✅ (PR #356 merged)

PR #356 (merged) implemented profile-first read adoption in the Resource
Profile route and export hook. The adapter (`capacityProfileResourceAdapter.ts`) uses
profile-first precedence (no reconciliation gate), adds `resolutionSource`,
`defaultPercent`, `startWeek`, `endWeek` to the output, and the legacy projection
helper (`capacityProfileLegacyProjection.ts`) projects profile data into display fields.

**Evidence from PR #356 (merged):**

- **Resource Profile** reads capacity-profile DTOs safely via `buildResourceCapacityProfileMap`
  (tested: `capacityProfileResourceAdapter.test.ts` — 7 tests covering profile-first,
  legacy fallback, multi-segment, planned resource).
- **Exports** keep capacity profile, assigned work, and billing basis separate
  (tested: `useResourceProfile.test.ts`).
- **One named person with multiple segments** remains one row (tested: adapter tests).
- **One planned resource with multiple segments** remains one row (tested: adapter tests).
- **Commercial totals** remain unchanged.
- **Legacy fallback** works when no persisted profile exists for an owner
  (tested: `capacityProfilePersistedDtoIntegration.test.ts`).

**Gap:** No test explicitly verifies that multi-segment profiles roundtrip through
export CSV → parsed spreadsheet columns. Consider adding if CSV parser roundtrip
is a requirement.

> **Note:** These changes merged via PR #356 to `main`.

>
> **Adoption invariants maintained by PR #356:**
>
> - **Fallback precedence:** Persisted owner-specific profile → active Capacity Plan
>   materialisation (only when `shouldFallbackToActiveCapacityPlan` requires it) →
>   pure owner-specific legacy compatibility state. `LEGACY` is never produced from
>   active capacity plan data — the `ACTIVE_CAPACITY_PLAN` resolution source is a
>   separate tier checked before LEGACY.
> - **Role aggregate vs per-resource profiles:** Role-level (ResourceType) profiles
>   represent aggregate capacity across all resources of that type, while each
>   named-resource profile is specific to one resource slot. These use different
>   owner kinds and independent key namespaces.
> - **Independent key spaces:** Role profiles are keyed by `resourceTypeId`;
>   named-resource profiles by `namedResourceId`. The two key spaces never collide.
> - **Duplicate owner keys fall through:** If a duplicate owner key appears in the
>   profile map (defensive guard), the adapter treats it as absent and falls through
>   to the next precedence tier rather than throwing or blocking.
> - **Physical-owner duplicate rejection (structural validator):** The GET
>   `/capacity-profiles` route's `validatePersistedCapacityProfiles` detects
>   duplicate physical owners by FK namespace + ID (e.g. the same
>   `namedResourceId` cannot appear as both `NAMED_PERSON` and
>   `PLANNED_RESOURCE`). This is distinct from the adapter's defensive map-merge
>   fall-through — the validator rejects structurally, while the adapter degrades
>   gracefully under map collision.
> - **Owner-aware percentage bounds:** ROLE-kind `defaultPercent` and segment
>   `capacityPercent` may exceed 100 (aggregate capacity for multiple people);
>   NAMED_PERSON/PLANNED_RESOURCE percents are bounded to [0,100]. The validator
>   enforces this; the adapter passes values through unchanged.
> - **All-or-nothing persistence authority:** The GET route validates the full
>   persisted set. Every profile must pass structural checks, or the entire set
>   is discarded and the complete legacy projection is served — no per-owner
>   partial merge.
> - **Persisted profile adoption scope:** The adapter's profile-first resolution
>   (`PROFILE`) enriches Resource Profile display and export. Separately, the
>   pre-existing active Capacity Plan fallback (`ACTIVE_CAPACITY_PLAN`) uses
>   segment-aware trajectory capacity for named-resource assignment and
>   planned-capacity totals in `namedResourceAssignments.ts` and
>   `projectPlanningModel.ts` — these paths are independent of PR #356's adapter.
> - **Algorithms unchanged:** Scheduler and leveller algorithms are not redesigned
>   by PR #356; the capacity plan materialisation that feeds assignment trajectories
>   pre-existed this change. Scheduler, leveller, Timeline, and Squad Planner
>   calculations continue reading legacy allocation fields directly via their
>   existing paths. Commercial billing formulas, billable days, discounts, tax,
>   and totals remain unaffected.
>
### Phase 2 — Compatibility projection helpers ✅ (PR #356 merged)

`projectCapacityProfileToLegacyAllocation` in `capacityProfileLegacyProjection.ts` was
introduced by PR #356 (merged). It is a pure, lossy-aware projection helper that
converts a `CapacityProfile` back into legacy allocation field shapes (`allocationMode`,
`allocationPercent`, `allocationStartWeek`, `allocationEndWeek`) without writing
to the database. After PR #356 merged, the Resource Profile route uses it to project profile
data into display fields when a resolved profile exists.

**Write state:** PR #355 already performs profile-first writes and compatibility
projections for the migrated ResourceType and NamedResource paths. Other consumers
remain legacy-compatible until they are migrated independently.

**Lossy cases (documented in helper):**

| Profile shape | Legacy projection |
|---|---|
| Fixed FTE (single percent, no segments) | `allocationPercent = percent`, `startWeek/endWeek = null` |
| Availability window (single segment) | `allocationPercent = seg.capacityPercent`, `startWeek = seg.startWeek`, `endWeek = seg.endWeek` |
| Multi-segment | Cannot be losslessly represented. Project as merged range `(min(startWeek), max(endWeek))` with duration-weighted average percent. **lossy: true** |
| CAPACITY_PLAN derived | Remains special: legacy fields stay as-is (or become explicit profile ref) |

The helper returns `lossy: true` for multi-segment profiles, with a `lossReason`
string describing the limitation.

### Phase 3 — Profile-first ResourceType and NamedResource write paths ✅ (PR #355 merged)

PR #355 migrated the supported ResourceType and NamedResource allocation write paths
to update `CapacityProfile` / `CapacitySegment` authoritatively and write legacy
compatibility projections in the same transaction. The public request/response shape
remains compatible while client callers still submit legacy-shaped allocation values.

Remaining write-path work must be identified consumer by consumer; it must not be
inferred from this completed migration slice.

#### Transaction boundaries

```
$transaction([
  // 1. Authoritative profile write
  prisma.capacityProfile.upsert({ ... }),
  prisma.capacitySegment.deleteMany({ where: { profileId } }),
  prisma.capacitySegment.createMany({ data: newSegments }),
  // 2. Legacy compatibility projection
  prisma.namedResource.update({ data: { allocationMode, allocationPercent, allocationStartWeek, allocationEndWeek } }),
])
```

#### Rollback safety

- Legacy compatibility fields are written in the same transaction. If the transaction fails, nothing changes.
- If only profile is correct and legacy projection is wrong (bug in helper), the mismatch is detected by the existing reconciliation report. Read paths are unaffected because the adapter uses profile data directly (`resolutionSource: 'PROFILE'`), not the legacy projection.
- `capacityProfileResourceAdapter.ts` uses profile-first precedence: it reads persisted profile data directly without comparing against legacy-derived expectations. A buggy legacy projection is therefore invisible to the adapter — it always prefers the source-of-truth profile.

#### Non-goal

Do not change the request/response shape of `PUT /named-resources/:id` in this phase. The client still sends legacy fields; the server projects them into profile as source of truth. The client can be migrated in a follow-up.

### Phase 4 — Remaining write and consumer migrations

PR #355 already covers the migrated role-level / ResourceType and NamedResource
allocation write paths. Remaining work is to migrate consumers deliberately, not to
change scheduler behavior under cleanup:

1. Scheduler, leveller, Timeline, and Squad Planner continue using their current
   legacy-compatible calculations until separately migrated and proven.
2. Live named resources without explicit profiles may use the role/default
   presentation where their compatibility state matches it; explicit profiles remain
   owner-specific.
3. New named resources created by migrated paths receive the role default through
   the established write-side rules.

### Phase 5 — Squad Planner apply ✅ (PR #359)

Squad Planner apply now persists stable named-resource identities and authoritative
role/planned-resource profiles in one domain transaction. The transaction also covers
legacy compatibility projections, Timeline rows, and `weeklyDemandCache`.

#### Current flow

```
1. Squad Planner generates a plan from the request and current project data.
2. Apply creates/reuses named resources with deterministic `(createdAt, id)` ordering.
3. Apply writes CapacityProfile/CapacitySegment rows as the authority.
4. Apply projects compatibility fields for legacy consumers.
5. Apply clears omitted/surplus planner capacity while preserving explicit/manual data.
6. Apply persists Timeline assignments and weekly demand cache in the same transaction.
7. A pre-apply v3 snapshot is written outside the domain transaction so failed applies
   retain a usable undo point.
8. Before any apply mutation, the transaction revalidates planner ownership. A committed
   explicit-owner race aborts with HTTP 409; only the new pre-apply snapshot is removed,
   while older snapshots and the concurrent explicit profile remain intact.
9. The domain transaction runs at PostgreSQL `Serializable` isolation. A
   serialization failure (`P2034`) aborts all domain writes, removes only the new
   pre-apply snapshot, and returns a retryable HTTP 409 response.
10. Omitted-role cleanup is evidence-backed: planner-owned `ROLE` profiles,
    legacy planner `NAMED_PERSON` profiles, or entries in the prior active
    `CapacityPlan` establish ownership. A bare `CAPACITY_PLAN` row with no
    profile and no prior active-plan entry is not adopted.
11. Malformed owner shapes, invalid planner provenance, and duplicate physical
    owners fail closed with HTTP 409. Apply does not repair or implicitly adopt
    ambiguous state.

Commercial remains outside this migration boundary. Squad Planner changes capacity
availability and compatibility projections; it does not change `pricingModel`,
billing basis, pricing formulas, discounts, tax, or commercial totals. The real
PostgreSQL clone integration executes production `computeCommercialData` against
source and clone DTOs and verifies exact parity after ID normalisation for the
supported `ACTUAL_DAYS` and `PRO_RATA` billing models.

### Phase 6 — Reverse reconciliation direction

Once writes are profile-first:

- `syncCapacityProfilesForProject` no longer means "derive profiles from legacy fields". It becomes a **compatibility projection** function that writes legacy fields from profile state.
- Rename or restructure to reflect new direction: `projectLegacyFromProfiles` or similar.
- `reconcileCapacityProfiles` should compare profile source of truth to legacy projections, not the reverse.
- The `compareCapacityProfiles` helper may need a mode flag until both directions are proven.

### Phase 7 — Legacy cleanup (#342)

Tracked separately by #342.

#### Preconditions

1. All read paths consume profile DTO directly (not legacy fields).
2. All write paths produce profile as source of truth.
3. Compatibility projections run and reconcile cleanly in production.
4. No consumer depends on legacy `allocationMode`, `allocationPercent`, `allocationStartWeek`, `allocationEndWeek` fields for correctness.
5. Backfill/reconcile evidence is clean for at least one release cycle.

#### Cleanup steps

1. Remove `allocationPct` (normalise to `allocationPercent`).
2. Make `allocationMode`, `allocationPercent`, `allocationStartWeek`, `allocationEndWeek` computed/generated columns or remove them from the Prisma schema.
3. Update all read paths to use profile DTO only.
4. Remove `syncCapacityProfilesForProject` — no longer needed when profiles are always source-of-truth.
5. Remove `capacityProfileResourceAdapter.ts` fallback — no longer needed.
6. Remove `mapProjectToCapacityProfiles` — no longer needed.
7. Archive `capacityProfileMapping.ts`.
#### Non-goals for cleanup

- Do not remove `ResourceType.count` — role metadata, not profile data.
- Do not remove the runtime `synthetic` property — maps to `ownerKind`, independent identity metadata derived from NR generation context. It is not a Prisma schema column.
- Do not remove `NamedResource.pricingModel` — Commercial metadata, not profile data.

## Regression matrix

### Commercial

| Test | What to assert |
|------|----------------|
| Billing basis unchanged | `pricingModel` values preserved through migration |
| Billable days unchanged | Total billable days same before/after profile write |
| Discounts/tax/totals unchanged | Commercial aggregate calculations preserved |
| PRO_RATA → "Bill planned allocation" export | CSV export text stable |

### Resource Profile / Export

| Test | What to assert |
|------|----------------|
| One person with multiple segments remains one row | NR row not duplicated per segment |
| One planned resource with multiple segments remains one row | Planned resource not duplicated per segment |
| Capacity profile, assigned work, billing basis are separate columns | CSV column independence |
| Legacy fallback works | Mapper is used only when profiles are missing or structurally invalid |
| CSV roundtrip | Multi-segment profiles survive export → parse → compare |

### Scheduler / Leveller / Timeline

| Test | What to assert |
|------|----------------|
| Effective capacity unchanged for legacy-equivalent projects | Same schedule output when profiles match legacy fields |
| Segmented capacity affects schedule only where intended | Multi-segment profiles produce correct per-week availability |
| Resource levelling respects segmented capacity | Leveller reads per-week availability from profiles |
| Phantom slots unaffected | `count - namedResources.length` stays same when count unchanged |

### Squad Planner

| Test | What to assert |
|------|----------------|
| Deterministic generated profiles | Same inputs → same profile output |
| Stable planned-resource identity | NR IDs stable across repeated applies |
| Repeated apply behaviour defined | Second apply does not duplicate or corrupt |
| Preview (non-apply) unchanged | Preview does not write to DB, uses temporary IDs |
| Evidence-backed omitted-role cleanup | Planner-owned profiles and prior active-plan evidence clear; unrelated bare `CAPACITY_PLAN` state remains untouched |
| Bare `CAPACITY_PLAN` adoption guard | No-profile rows are adopted only when a prior active `CapacityPlan` entry proves planner ownership |
| Malformed owner/provenance rejection | Invalid owner shapes, planner provenance, and duplicate physical owners return HTTP 409 without repair |
| Serializable concurrent apply | Real concurrent valid applies produce only committed 201 or retryable 409 responses and leave one active plan |

### Operational

| Test | What to assert |
|------|----------------|
| Backfill passes | `npm run capacity-profiles:backfill` exits 0 |
| Reconciliation passes | `npm run capacity-profiles:reconcile` exits 0 |
| Source-of-truth writes are transactional | Partial write failure rolls back both profile and legacy fields |
| Stale profile deletion is safe | Deleting a capacity profile with no legacy counterpart does nothing harmful |

## Open questions

1. **Should capacity profiles always affect scheduling, or only when selected as the capacity source?** The answer changes how `scheduler.ts` and `leveller.ts` consume profiles. Current: only via `shouldFallbackToActiveCapacityPlan` logic. Target: always, once profiles are source of truth.
2. **Should role-level capacity profiles be allowed without planned resources?** Yes — a role with `count: 3` but no named resources still has role-level capacity (phantom slots). The profile should represent that.
3. **Should Squad Planner generate role-level profiles first, then let users map them to planned resources?** Possibly a future UX improvement, but the data model should support it.
4. **Should billing basis be editable only in Commercial?** Yes — Commercial is the billing owner. The profile describes availability, not billing.
5. **Do we need a legacy resource-profile export during transition?** Yes — the current export already works with profile DTO as additive enrichment. No separate legacy export needed.
6. **How should NamedResource.allocationMode === 'CAPACITY_PLAN' be handled in source-of-truth mode?** Options: (a) reject editing allocation fields when mode is CAPACITY_PLAN, (b) treat CAPACITY_PLAN as "profile is derived from capacity plan" flag, (c) convert CAPACITY_PLAN into an explicit profile on first edit. Recommend (b) — the mode flag remains the indicator that profile comes from Squad Planner, and direct edits convert to an explicit profile.

## Follow-up issues to consider

| Issue | Description |
|-------|-------------|
| Normalise `allocationPct` → `allocationPercent` | Remove the dual field before or during legacy cleanup |
| CSV roundtrip test | Test multi-segment profile → CSV → parse → compare |
| Remove obsolete fallback helpers | Converge remaining legacy consumer fallback logic after all consumers migrate |

## Project Clone: capacity profile handling

> Issue #358 defines project clone with respect to capacity profile state.

Clone is a direct copy of persisted authoritative `CapacityProfile` and
`CapacitySegment` rows, not a profile-regeneration or compatibility-sync
operation. This section documents how clone interacts with the source-of-truth
migration.

### Clone behaviour

- **Direct copy.** Every `CapacityProfile` and `CapacitySegment` row is copied
  from the source project and recreated with new, clone-owned IDs.
- **Owner remapping.** Owner references are strictly remapped to the clone's
  own `ResourceType` and `NamedResource` rows.
- **PLANNED_RESOURCE identity preserved.** Planned resources keep their
  `ownerKind: PLANNED_RESOURCE` status; the clone does not promote them.
- **Legacy null-state preserved.** `DB_NULL` and `JSON_NULL` legacy values
  round-trip through their exact Prisma sentinels.
- **No compatibility sync invoked.** `syncCapacityProfilesForProject` is not
  called. The copied profiles are the clone's authoritative state.
- **Duplicate owners preserved 1:1.** Duplicate owner keys (permitted)
  are copied without consolidation or repair. Issue #361 remains responsible
  for duplicate-owner consolidation.

### Migration status

| Concern | Status |
|---------|--------|
| Profile rows directly copied | ✅ Implemented (direct Prisma copy) |
| New IDs assigned | ✅ Clone-owned IDs |
| Owner remapping to clone entities | ✅ Strict per-kind remapping |
| PLANNED_RESOURCE identity | ✅ Preserved |
| DB NULL / JSON null fidelity | ✅ Via Prisma sentinels |
| No sync/regeneration | ✅ Compatibility helpers not invoked |
| Duplicate owners unmodified | ✅ 1:1 copy; #361 deferred |
| Schema migration required | No — pure data-layer operation |
| Billing models preserved | ✅ ACTUAL_DAYS and PRO_RATA; FIXED_PRICE is not supported |
| Zero-capacity segments preserved | ✅ `capacityPercent: 0` segments cloned verbatim |
| Rollback transaction atomicity | ✅ Mid-transaction failure reverts all clone writes |
| Endpoint parity (resource-profile) | ✅ GET source/clone DTOs match after ID normalisation |
| CSV export parity (buildProfileCsv) | ✅ Required real PostgreSQL clone integration (`projects.clone.integration.test.ts`) executes production `buildProfileCsv` against source/clone HTTP DTOs; exact CSV output matches after expected ID/name normalisation |
| Commercial calculator parity | ✅ Required real PostgreSQL clone integration (`projects.clone.integration.test.ts`) executes production `computeCommercialData` against source/clone HTTP DTOs; commercial subtotal, after-discounts, and grand total match completely |

### Supported billing model

Clone preserves the `pricingModel` value verbatim. The production Commercial
calculator (`computeCommercialData` in `financialCalculations.ts`) supports
**ACTUAL_DAYS** (Bill actual scheduled days) and **PRO_RATA** (Bill planned
allocation). Any unrecognised value falls through to ACTUAL_DAYS. **FIXED_PRICE**
is not a supported billing branch and must not appear in clone fixtures or
evidence — the integration test exercises both ACTUAL_DAYS and PRO_RATA paths.

### Zero-capacity segments

Segments with `capacityPercent: 0` are valid and are copied identically during
clone. The clone route does not filter, merge, or normalise zero-capacity
entries — they remain in the profile with their original start week, end week,
and source. CSV output via `buildProfileCsv` includes the zero segment without
alteration.

### Rollback transaction evidence

The clone integration suite (`projects.clone.integration.test.ts`) includes a
guarded real-PostgreSQL scenario that proves atomic rollback after write begins:
a source project is set up with all clone data, but one capacity profile
references an unmappable ResourceType/NamedResource. The clone endpoint is called,
the project and child rows are written, then the route fails on the invalid
reference. The test asserts the transaction rolled back every row — project
metadata, resource types, named resources, profiles, segments, epics, features,
stories, tasks, timeline entries — leaving zero residual state.

### Endpoint, CSV, and Commercial parity

Three independent parity checks establish source-vs-clone identity at the
endpoint, CSV, and commercial-calculator layers:

1. **Endpoint parity (server integration tests).** Production
   `GET /api/projects/:id/resource-profile` is called on both source and clone.
   After normalising clone-owned IDs and generated names, row count, multiplicity,
   profile fields (`planningBasis`, `source`, `defaultPercent`, `startWeek`,
   `endWeek`, segments), billable days, overhead rows, subtotals, grand totals,
   discounts, and tax fields are asserted equal.

2. **CSV export and commercial parity (client functions against endpoint DTOs).** `projects.clone.integration.test.ts` fetches the real source and clone HTTP `GET /api/projects/:id/resource-profile` DTOs, then executes production `buildProfileCsv` and `computeCommercialData` against those DTOs. After expected ID/name normalisation, exact CSV output (planning basis, profile source, windows, segments, planned-resource identity, billing basis, and row multiplicity) and commercial subtotal, after-discounts, and grand total all match.

The focused client test (`clone-commercial-parity.test.ts`) is separate: it is a utility regression over ID-remapped, DTO-shaped fixtures, not real endpoint evidence. CI runs that client Vitest step separately from the required/blocking server command `npm run test:clone-integration` (working directory `server`). The clone integration step runs after Prisma migrations and client generation and blocks CI on failure.

## Remaining work for #342 — Legacy-field consumers

The following consumers still read legacy allocation fields (`allocationMode`,
`allocationPercent`, `allocationStartWeek`, `allocationEndWeek`) directly.
They must be migrated to consume profile DTO data before legacy fields can be
removed or made computed/generated columns.

### scheduler.ts

**Uses:** `ResourceType.count` for `phantomSlots = count - namedResources.length`
(line ~180). Also reads NR allocation fields for scheduling effective capacity.

**Status:** Legacy — `phantomSlots` depends on `count` (role metadata, not profile data).
Allocation fields for scheduling are read from `ResourceType`/`NamedResource` directly,
not from the profile DTO. Profile-capacity segments are not yet consumed for
per-week capacity constraints.

### timeline.ts

**Uses:** Reads `ResourceType`/`NamedResource` allocation fields for scheduling and
week-based capacity assignment. Consumes `shouldFallbackToActiveCapacityPlan` logic.

**Status:** Legacy — allocation mode, percent, and window fields read from route-level
DTO fields, not from profile segments. The route has not been migrated to profile-first
read adoption.

### projectPlanningModel.ts

**Uses:** Reads `ResourceType.allocationMode`, `allocationPercent`,
`allocationStartWeek`, `allocationEndWeek` for capacity-demand calculation
(`buildFallbackWeeklyDemand`). Similar fallback logic to `shouldFallbackToActiveCapacityPlan`.

**Status:** Legacy — demand calculation uses legacy fields directly. Must be updated
to consume profile DTO when available for accurate per-week capacity.

### leveller.ts

**Uses:** Reads resource availability for resource-levelling calculations. Consumes
allocation fields and capacity constraints from `ResourceType`/`NamedResource` data.

**Status:** Legacy — reads resource availability via legacy fields, not from profile
segments. Multi-segment profiles are not yet consumed for per-week capacity constraints.

### Summary

| Consumer | Legacy fields read | Profile DTO ready? | Blocked on |
|---|---|---|---|
| `scheduler.ts` | `count`, NR allocation fields | No | Profile DTO migration needed |
| `timeline.ts` | RT/NR allocation fields | No | Profile DTO migration needed |
| `projectPlanningModel.ts` | RT allocation fields | No | Profile DTO migration needed |
| `leveller.ts` | RT/NR capacity constraints | No | Profile DTO migration needed |
| `resourceProfile.ts` | RT/NR allocation fields (display) | Yes (PR #356) | Already projects from profile when available |
| `useResourceProfileExport.ts` | NR legacy fields (backup) | Yes (PR #356) | Already prefers profile columns |

> **Important:** #342 is a field-cleanup chore, not a behavioural-change issue. It does
> not authorise scheduler, leveller, Timeline, or Squad Planner algorithm changes. It
> may remove legacy fields only after every consumer listed above has been migrated to
> consume profile DTO data and compatibility has been proven in production for at least
> one release cycle. Scheduler, leveller, Timeline, Squad Planner, and Commercial
> calculations remain unchanged throughout the #340/#342 migration.

**Next step for #342:** Migrate each consumer above to read profile DTO data when
available, starting with those that already have profile-aware infrastructure
(the route and export hook in `resourceProfile.ts` and `useResourceProfileExport.ts`
are already done from PR #356 — focus on `scheduler.ts`, `timeline.ts`,
`projectPlanningModel.ts`, and `leveller.ts`).


