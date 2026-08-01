# Legacy capacity-column runtime cutover (Issue #418 — PR 1)

## Status after PR 1

- The candidate legacy capacity columns **still physically exist** in the
  database. No Prisma field was removed and no migration was added or run.
- The application **no longer reads or writes them during normal runtime**.
  All capacity behaviour (scheduling, Timeline, Resource Profile, Commercial,
  exports, Squad Planner, Resource Optimiser, named-resource lifecycle, count
  changes, clone, imports, snapshots) derives capacity exclusively from
  `CapacityProfile` / `CapacitySegment` state.
- Candidate columns are now **frozen historical data**. They are only
  referenced by:
  1. historical snapshot input types and version translators (v1/v2/v3
     parsing and restore translation);
  2. explicit migration tooling (backfill/reconcile scripts and the
     readiness command);
  3. tests that intentionally construct historical payloads.
- A source guard (`server/src/test/legacyCapacityFieldSourceGuard.test.ts`)
  proves production code never reintroduces candidate-field access through
  Prisma `resourceType` / `namedResource` queries.

### Candidate columns

| Model | Columns |
|---|---|
| `ResourceType` | `allocationMode`, `allocationPercent`, `allocationStartWeek`, `allocationEndWeek` |
| `NamedResource` | `allocationMode`, `allocationPercent`, `allocationPct`, `allocationStartWeek`, `allocationEndWeek`, `startWeek`, `endWeek` |

Independent metadata (`ResourceType.count`, `hoursPerDay`, `dayRate`, names,
categories; `NamedResource.name`, `resourceTypeId`, `pricingModel`) is
untouched. `CapacityProfile.legacy` remains in place (retirement tracked by
#405).

## Runtime authority model

- Every named resource and every role resolves capacity from exactly one
  validated owner profile. Missing, duplicate, conflicting, malformed or
  cross-project profile state **fails closed** with a
  `CapacityIntegrityError` (HTTP 409) — there is no legacy-column fallback.
- The one supported no-ROLE-profile state is an **explicit-only role**: every
  named resource of the role carries a `NAMED_PERSON` profile and no planner
  ownership exists.
- Response DTOs that still expose compatibility fields (`allocationMode`,
  `allocationPercent`, `allocationPct`, `allocationStartWeek`,
  `allocationEndWeek`, `startWeek`, `endWeek`) derive them from authoritative
  profiles via `projectCapacityProfileToLegacyAllocation`. The UI and public
  API were not redesigned.
- Squad Planner → manual transfer (#411) suppression is driven by persisted
  provenance (`CapacityProfile.legacy.writer === 'transfer-to-manual'`) and
  the manual ROLE `CAPACITY_PROFILE` authority — transferred planned
  resources keep identity and profile data but contribute zero capacity.
- Count reduction classifies generated/inherited resources by authoritative
  profile shape plus the persisted `ROLE_DEFAULT` provenance marker, never by
  candidate-column equality. Role edits re-clone system-generated
  `ROLE_DEFAULT` named-person profiles so the supported `1 → 2 → 1` count
  lifecycle is preserved.

## Snapshot version behaviour

- New snapshots are **schemaVersion 4**: `resourceTypes[]` and
  `namedResources[]` omit the candidate columns; capacity is captured entirely
  in `capacityProfiles` / `capacitySegments`.
- Historical snapshots remain restorable:
  - **v1** — epic-tree restore only (unchanged contract).
  - **v2** — full-state restore; the captured legacy capacity values are
    translated into deterministic profiles by `recreateV2CapacityProfiles`.
    The candidate columns are treated as historical input only and are never
    written back during restoration.
  - **v3** — full-state restore with exact profile/segment/plan replacement.
  - **v4** — same exact replacement as v3.
- Restore never recreates or requires the candidate database columns.

## Readiness command

Explicitly invoked, read-only production-readiness check for the later
destructive migration (executed by the production machine under #404).

```bash
npm run capacity-profiles:readiness        # from the repository root
# equivalent: npm run capacity-profiles:readiness --workspace=server
# raw: npx tsx server/src/scripts/checkProductionMigrationReadiness.ts
```

### Behaviour

- **Never** runs during application startup or from an HTTP request; exposes
  no API or UI.
- Connects only through the normal explicitly supplied database configuration
  (`DATABASE_URL`).
- Performs **no writes, repair, reconciliation or cache clearing**.
- Validates, reusing the existing authority functions:
  - ownership audit (`runOwnershipAudit`) — exactly one valid owner FK per
    profile, ownerKind/FK consistency, existing in-project owners, no
    duplicate or cross-project ownership;
  - per-project completeness and shape
    (`validatePersistedCapacityProfiles` + `checkPersistedCompleteness`) —
    every named resource has exactly one valid profile; every role has a ROLE
    profile unless explicit-only; profile/segment shape follows the
    authoritative validation rules;
  - historical snapshot parseability and translatability
    (`parseSnapshotData`, v2 translation validation, `validateSnapshotV3`) —
    every stored `BacklogSnapshot` and `TemplateSnapshot` must parse as
    v1/v2/v3/v4 and carry translatable capacity values.
- Reports project/entity identifiers without credentials or unrelated
  sensitive data.

### Exit contract

- `0` — every section passes; migration readiness is proven.
- `1` — at least one blocker; the destructive migration must not start.

### Evidence Issue #404 must record

For each readiness run, the production machine records:

1. the exact installed commit SHA and `main` migration state;
2. the full command invocation and its output (pass/fail per section);
3. confirmation that the physical candidate columns still exist;
4. a fresh backup path, timestamp, database identity and application commit
   (no credentials), plus the restore-verification result;
5. representative project validation results through project loading,
   Resource Profile, Timeline/scheduling, named-resource lifecycle, manual
   capacity editing, Squad Planner, planner-to-manual transfer, Resource
   Optimiser, Commercial, exports and snapshot creation/restoration.

## Sequencing and rollback

- **PR 2 (destructive Prisma migration) cannot start** until #404 records
  that the readiness command passes against the useful database AND a fresh
  backup has been restore-tested successfully.
- **Rollback remains backup restoration.** There is no reverse migration that
  recreates empty legacy columns.
- **PR 1 performs no production migration.** All database and migration
  testing in PR 1 uses disposable PostgreSQL databases on the development
  machine.
