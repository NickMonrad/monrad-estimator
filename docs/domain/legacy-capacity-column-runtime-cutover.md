# Legacy capacity-column runtime cutover (Issue #418 — PR 1)

## Sequencing correction after #404 Stage 4 evidence (2026-08-07)

Production evidence from #404 showed that requiring a fresh V4 snapshot for every current project before the pre-V4 purge is not a useful safety gate: the useful database currently has no V4 snapshots and still contains known live CapacityProfile completeness/shape blockers. A V4 snapshot would preserve that current state but would not prove that the state is migration-ready.

This correction supersedes the older sequencing text later in this document under **Fresh V4 safety snapshots**, **Revised #404 production sequence**, and the first bullet under **Sequencing and rollback** wherever those sections require V4 snapshot creation/restoration before the pre-V4 purge.

The corrected production contract is:

1. install the exact reviewed non-destructive release and verify service/database health;
2. run `npm run capacity-profiles:purge-pre-v4-snapshots` in dry-run mode and require malformed/unsupported = 0;
3. enter maintenance mode;
4. create a fresh PostgreSQL backup of the useful database and successfully restore-test it before any purge write; retain this backup through migration acceptance;
5. rerun the purge dry-run and require the pre-V4 counts to reconcile;
6. run `npm run capacity-profiles:purge-pre-v4-snapshots -- --apply`;
7. prove V1 = 0, V2 = 0, V3 = 0, malformed/unsupported = 0, and that current project/backlog/resource/profile/timeline state is unchanged apart from the deliberate `BacklogSnapshot` deletion;
8. restart the application and rerun `npm run capacity-profiles:readiness`;
9. remediate only the remaining current/live CapacityProfile blockers under the reviewed #421 process until readiness passes;
10. create a fresh V4 snapshot on a representative useful project and prove supported V4 restore succeeds with CapacityProfile ownership/integrity still valid;
11. rerun `npm run capacity-profiles:readiness` against the post-restore database state and require exit 0;
12. authorize #418 PR 2 only after that final post-restore readiness pass, the restore-tested backup is retained, pre-V4 snapshot count is zero, and representative V4 create/restore has passed.

The restore-tested PostgreSQL backup is the authoritative pre-purge rollback mechanism because it captures the complete useful database, including the legacy snapshots being deliberately deleted. Do not build or run a bulk 134-project snapshot mechanism solely for this migration gate. The purge command remains unchanged and must never create snapshots itself.

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
- **Issue #444 — V4 is the minimum supported/restorable snapshot format.**
  The product accepts the deliberate loss of pre-V4 rollback history:
  - **v1/v2/v3** — deliberately retired. They are **non-restorable** through
    the shared restorability classifier with one stable reason
    (`historical snapshot is no longer restorable: V4 is the minimum
    supported snapshot version`); listing shows `non-restorable`, rollback is
    refused pre-write before any transaction, and automatic retention never
    deletes them. Stored pre-V4 rows are removed only by the explicit purge
    command (below) before PR 2.
  - **v4** — the only restorable format. Valid V4 payloads restore with exact
    profile/segment/plan replacement; invalid V4 payloads are rejected
    pre-write.
- The historical v1/v2/v3 parsers/translators remain in the repository for
  version identification during the purge; they are no longer a migration
  requirement and no historical translation/restoration is performed.
- **Rollback ownership contract (v4):** the transaction leaves every
  surviving `ResourceType` and `NamedResource` with valid authoritative
  ownership. Captured owners are exactly replaced from the snapshot;
  post-snapshot named resources are pruned; post-snapshot resource types are
  retained by identity **and** keep their validated ROLE profile (and its
  segments) atomically, with exact IDs. A surviving post-snapshot role whose
  ownership is missing, duplicated or structurally invalid fails the rollback
  before any destructive write.
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
  - snapshot version policy (issue #444) — every stored project
    `BacklogSnapshot` is classified by schema version only (V4 is the
    minimum supported format). Any pre-V4 (v1/v2/v3) row is a blocker with
    an aggregate count (`pre-V4 BacklogSnapshots remain: N`) because it must
    be purged before PR 2; malformed/unsupported payloads block
    (`malformed/unsupported BacklogSnapshots: N`); structurally invalid V4
    payloads block (`invalid V4 BacklogSnapshots: N`); valid V4 snapshots
    pass. No historical translation, quarantine or decision analysis runs.
    `TemplateSnapshot` rows are deliberately **not** inspected: they store
    `FeatureTemplate` objects (raw template state), not project snapshots.
- Reports aggregate counts only for the snapshot section; live-state
  blockers identify the project/entity. Credentials or unrelated sensitive
  data are never printed.

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

## Pre-V4 snapshot purge (Issue #444)

One standalone, explicitly-invoked maintenance command deliberately removes
every stored pre-V4 (`v1`/`v2`/`v3`) `BacklogSnapshot` row before the
destructive column migration. It operates ONLY on `BacklogSnapshot` rows.

```bash
npm run capacity-profiles:purge-pre-v4-snapshots            # DRY RUN (default)
npm run capacity-profiles:purge-pre-v4-snapshots -- --apply  # destructive apply
# raw: npx tsx server/src/scripts/purgePreV4Snapshots.ts [--apply]
```

### Behaviour and safety contract

- **Never** runs during application startup or from an HTTP request; exposes
  no API or UI; is not invoked by readiness or any other command.
- Classifies every stored `BacklogSnapshot` payload by schema version only
  (`parseSnapshotData` + the existing version guards — no second parser):
  V1, V2, V3, V4, or malformed/unsupported.
- **DRY RUN (default):** reports sanitized aggregate counts
  (V1/V2/V3/V4/malformed) and performs **zero writes**.
- **APPLY (`--apply`):** deletes **only** rows positively classified
  V1/V2/V3. V4 snapshots can never be deleted by this command. If ANY
  malformed/unsupported snapshot exists, the whole apply aborts before any
  deletion with an aggregate reason and a non-zero exit — unexpected data is
  never worked around.
- Never touches project/backlog/resource/profile/timeline tables and never
  synthesises snapshots.
- Output is aggregate-only: no project names/IDs, snapshot IDs, payloads,
  user data, database URLs or credentials.
- The production maintenance window under #404 is responsible for preventing
  concurrent writes; the tool builds no locking or orchestration.

### Fresh V4 safety snapshots (operational gate, not part of the tool)

Before any purge apply, #404 must, for every current useful project in
migration scope:

1. create/verify at least one valid V4 snapshot through the normal snapshot
   flow (the purge command never creates snapshots);
2. create a fresh PostgreSQL backup and restore-test it successfully — the
   backup is the disaster-recovery record of the deleted legacy snapshot
   rows and must be retained through migration acceptance.

## Revised #404 production sequence (after this release is merged)

1. install the exact reviewed release containing this policy/tooling;
2. verify service/database health;
3. run the purge command in **dry-run** mode and record the sanitized
   aggregate pre-V4/V4 counts;
4. create/verify fresh V4 snapshot(s) for every useful current project;
5. create a fresh PostgreSQL backup;
6. restore-test that backup successfully;
7. enter maintenance mode;
8. run the purge **apply**;
9. verify: V1 = 0, V2 = 0, V3 = 0, V4 snapshots remain,
   malformed/unsupported = 0;
10. verify a representative V4 restore succeeds;
11. rerun the readiness command;
12. continue remediation **only** for remaining **live-state** blockers
    (the historical snapshot sections of the remediation plan are
    superseded by the purge);
13. authorize #418 PR 2 **only** when readiness passes AND the fresh backup
    has been restore-tested. The purge itself does NOT authorize PR 2.

## Sequencing and rollback

- **PR 2 (destructive Prisma migration) cannot start** until #404 records
  that the readiness command passes against the useful database (with
  pre-V4 snapshot count zero and representative V4 restore verified) AND a
  fresh backup has been restore-tested successfully.
- Representative V1/V2/V3 restoration is **no longer required** — the
  product accepts the loss of pre-V4 rollback history (issue #444).
- **Rollback remains backup restoration.** There is no reverse migration that
  recreates empty legacy columns.
- **PR 1 performs no production migration.** All database and migration
  testing in PR 1 uses disposable PostgreSQL databases on the development
  machine.

## Pre-PR-2 remediation (Issue #421)

The first production readiness run failed with deterministic and ambiguous
blockers (missing profiles, malformed persisted profiles, untranslatable
historical v2 snapshots). The reviewed remediation command
(`npm run capacity-profiles:remediate-readiness`, explicit dry-run/apply
modes) is specified in
[`docs/domain/capacity-profile-readiness-remediation.md`](capacity-profile-readiness-remediation.md),
including the deterministic transformation matrix, the decision manifest
contract, and the ownership-invariant migration sequencing. Issue #444
supersedes the historical v2 snapshot policy sections of that document:
pre-V4 snapshots are deliberately purged (see above) instead of being
remediated, rewritten or translated. PR 2 remains blocked until #404
executes the revised procedure and records both gates.

> **Superseded by PR 2 (issue #418):** issue #421 was closed as not planned
> and the #449 planning reset/replan workflow replaced preservation
> remediation. PR 2 (`20260810072212_drop_legacy_capacity_columns`) removes
> the remediation tooling together with the candidate columns; see
> [`docs/domain/legacy-capacity-column-migration.md`](legacy-capacity-column-migration.md).