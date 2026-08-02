# Capacity-Profile Readiness Remediation (Issue #421)

## Purpose

PR #419 (`chore(#418): retire runtime legacy capacity-column compatibility`)
installed the permanent read-only readiness gate
(`npm run capacity-profiles:readiness`). The production database
substantially predates the profile-first population work, so the gate fails
with deterministic and ambiguous blockers. This document specifies the
reviewed pre-PR-2 remediation command that lets #404:

1. produce an exact read-only remediation plan;
2. distinguish deterministic corrections from decisions that require explicit
   approval;
3. apply only an approved, unchanged plan transactionally;
4. rerun the permanent readiness gate;
5. stop safely on ambiguity or drift.

This PR performs **no production data changes**. Execution is owned by #404.

## Command

One cohesive, explicitly invoked command with two modes:

```bash
# Dry-run (default; zero writes)
npm run capacity-profiles:remediate-readiness -- --dry-run
npm run capacity-profiles:remediate-readiness -- --dry-run --json reviewed-plan.json
npm run capacity-profiles:remediate-readiness -- --dry-run --json reviewed-plan.json --manifest approved-decisions.json

# Apply (writes ONLY the reviewed plan, inside one transaction)
npm run capacity-profiles:remediate-readiness -- --apply --plan reviewed-plan.json
npm run capacity-profiles:remediate-readiness -- --apply --plan reviewed-plan.json --manifest approved-decisions.json
```

Equivalent standalone invocation from `server/`:

```bash
npx tsx src/scripts/remediateProductionReadiness.ts [--dry-run] [--json <path>] [--manifest <path>]
npx tsx src/scripts/remediateProductionReadiness.ts --apply --plan <path> [--manifest <path>]
```

The command never runs at startup, exposes no API/UI, performs no writes in
dry-run mode, and never prints credentials or complete database URLs.

### Exit contract

| Code | Meaning |
|------|---------|
| `0` | Plan is valid and has **no unresolved decisions** (apply mode: every operation applied or already applied, and the post-apply readiness + planner checks are clean). |
| `1` | Operational, structural or drift failure — malformed plan/manifest, unsupported findings, fingerprint mismatch, state changed since dry-run, transaction failure, post-apply regression. In apply mode nothing was written when the failure occurred before commit. |
| `2` | Plan is valid but **explicit decisions remain unresolved** — apply is refused. |

Dry-run exit code reflects the plan's classification only; the permanent
readiness gate (`npm run capacity-profiles:readiness`) is a separate command
and is never weakened.

## Deterministic transformation matrix (live state)

Only transformations whose intended profile state is proven by existing
persisted evidence and established repository rules are deterministic. The
approved `capacityProfileMapping.ts` mapper and the current Squad Planner ROLE
writer (`buildRoleProfileData`) are reused; no new semantics are invented.

### ResourceTypes without any profile (role owners)

| Legacy `allocationMode` | Target profile | Evidence |
|---|---|---|
| `TIMELINE` | `AVAILABILITY_WINDOW` / `AVAILABILITY_WINDOW`, `defaultPercent = allocationPercent ?? null`, window preserved (`allocationStartWeek`/`allocationEndWeek`) | mode + window aliases |
| `EFFORT` / absent | `DEMAND_FOLLOWING` / `FIXED`, `defaultPercent = allocationPercent ?? null`; stale windows discarded | mode |
| `FULL_PROJECT` | `WHOLE_PROJECT_ALLOCATION` / `FIXED`, `defaultPercent = allocationPercent ?? null`; stale windows discarded | mode |
| `CAPACITY_PLAN` **with valid persisted active-plan entries** | `CAPACITY_PROFILE` / `SQUAD_PLANNER` via `buildRoleProfileData` (aggregate weekly-headcount segments, planner provenance preserved) | active-plan periods/entries |
| `CAPACITY_PLAN` without usable window or plan evidence | **decision required** — never guessed | — |

### NamedResources without any profile

Mode is the named resource's OWN `allocationMode` (the legacy scheduler never
inherited the parent role's mode).

| Legacy `allocationMode` | Target profile | Evidence |
|---|---|---|
| `TIMELINE` | `AVAILABILITY_WINDOW` / `AVAILABILITY_WINDOW`, `defaultPercent = allocationPercent ?? allocationPct ?? 100`, window preserved (precedence `allocationStartWeek ?? startWeek`) | mode + window aliases |
| `FULL_PROJECT` | `WHOLE_PROJECT_ALLOCATION` / `FIXED`, same percent; stale windows discarded | mode |
| `EFFORT` / absent | `DEMAND_FOLLOWING` / `FIXED`, same percent; stale windows discarded (same stale-alias policy as v2 translation) | mode |
| `CAPACITY_PLAN` **with captured window** | `AVAILABILITY_WINDOW` / `LEGACY`, same percent, window preserved — the exact v2 snapshot translation policy | mode + window |
| `CAPACITY_PLAN` without captured window | **decision required** | — |
| never-active window (`(-1,-1)` pair or inverted `start > end`) | `AVAILABILITY_WINDOW` at `defaultPercent 0`, null window | policy below |

### Persisted profile shape defects

| Defect | Correction | Classification |
|---|---|---|
| `DEMAND_FOLLOWING` / `WHOLE_PROJECT_ALLOCATION` with `startWeek`/`endWeek` set | clear the window fields (basis forbids them; the legacy mode never used them) | deterministic |
| overlapping segments on a `CAPACITY_PROFILE` | exact sum-preserving non-overlapping decomposition; existing segment IDs preserved; surplus intervals get deterministic IDs and inherit the covering segment's provenance | deterministic |
| segmentless non-canonical `CAPACITY_PROFILE` (e.g. 13 legacy ROLE rows with `defaultPercent 100`, no segments, windowless `CAPACITY_PLAN` legacy JSON) | **decision required** (owner intent; no capacity can be proven) | decision |
| `AVAILABILITY_WINDOW` with invalid/inverted week fields | **decision required** | decision |
| anything else (both/neither owner FK, bad enums, negative segment weeks, …) | **unsupported** — dry-run exits `1`, apply refuses | unsupported |

### Preservation guarantees

- Effective weekly capacity is preserved exactly (proposed profile ↔ mapper /
  planner-writer derived DTO equality is asserted per operation; the runtime
  scheduler resolver consumes only profile state after apply).
- Project and owner identity preserved; pricing and independent metadata never
  touched (candidate ResourceType/NamedResource columns are read-only here).
- Existing valid profile IDs and segment IDs preserved where no replacement is
  required; created profiles use deterministic IDs
  (`remediation-role-<ownerId>` / `remediation-named-<ownerId>`) and
  mapper-shaped `legacy` JSON capturing the original values.
- Squad Planner / optimiser / transfer provenance preserved (updates never
  rewrite `CapacityProfile.legacy`; the deterministic planner reconstruction
  writes `SQUAD_PLANNER` provenance via the current planner writer).
- No blanket default is applied to zero-profile projects; windowless
  `CAPACITY_PLAN` owners stay untouched until an explicit decision exists.

## Cases requiring explicit decisions

Unless a reviewed manifest decision resolves them:

- ResourceTypes with `CAPACITY_PLAN` state but no usable window/plan evidence
  (production: 104 of the 106 — the 2 planner-owned Supply Chain roles are
  proven deterministic by their persisted active-plan entries and 4/4
  profile-backed named resources);
- NamedResources with `CAPACITY_PLAN` state but no captured window (9);
- the 13 segmentless legacy ROLE `CAPACITY_PROFILE` rows;
- v2 snapshot entries with `CAPACITY_PLAN` and no captured window (933);
- v2 snapshot entries with a single `-1` edge (no established meaning);
- any owner whose kind, source, percentage, window, segments or provenance
  cannot be determined exactly.

## Historical v2 snapshot policy

Readiness and rollback share the same translation helper
(`translateV2SnapshotProfiles`), so the policy below applies to both, and the
remediation planner classifies every v2 entry with the same rules.

### `-1` sentinel windows

**Proven meaning: "never active" (zero capacity).** Evidence:

- The legacy Squad Planner apply path wrote
  `{ startWeek: -1, endWeek: -1, allocationPercent: 100 }` as the fallback for
  named resources without an assigned slot window
  (`server/src/routes/squadPlan.ts`, pre-#359, `slotWindows[idx] ?? {…-1…}`).
- The legacy scheduler window gate (`week >= start && week <= end`, with
  `start = nr.startWeek ?? 0`, `end = nr.endWeek ?? Infinity`) never matches
  for `(-1, -1)`, so the entry contributed zero capacity.
- `server/src/test/scheduler.test.ts` codifies this:
  "slot never active → endWeek=-1 → does not contribute capacity".
- `null` (not `-1`) was the "unbounded" representation (`endWeek ?? Infinity`).

Deterministic normalization: a `(-1, -1)` captured window pair translates to a
zero-capacity profile (`defaultPercent 0`, null window) — the exact historical
effective capacity, never a guess. A single `-1` edge has no established
meaning and requires an explicit `snapshot-window-interpretation` decision.

### Inverted windows (`start > end`)

The legacy scheduler tolerated inverted windows without clamping; no week can
match `week >= start && week <= end`, so the entry contributed zero capacity.
Deterministic normalization: same zero-capacity representation as `(-1, -1)`.

### `CAPACITY_PLAN` entries without captured windows

Never translated to full-project or unbounded capacity. If the entry's
captured payload cannot prove the exact window, an explicit
`snapshot-window-interpretation` decision is required. Decisions are applied
as minimal snapshot rewrites: only `allocationStartWeek`/`allocationEndWeek`
are written (negative fallback aliases cleared), all unrelated snapshot
content and metadata are preserved, and the complete resulting snapshot is
re-validated through the shared translation before writing. Reruns are no-ops.

Malformed snapshots are never deleted to pass readiness — they are reported as
unsupported and block apply.

## Plan and manifest format

The dry-run emits a versioned JSON plan (`formatVersion: 1`) containing every
finding (classified `deterministic` / `decisionRequired` / `unsupported` /
`alreadyValid`), concrete operations, unresolved decision entries with their
allowed resolution shapes, and the current-state evidence hash per entry.

Fingerprint contract:

- `plan.fingerprint` = SHA-256 over the canonical JSON (sorted keys) of the
  plan's actionable content (summary, findings, operations, decisions).
  `generatedAt` is excluded so repeated dry-runs on unchanged state produce
  identical fingerprints.
- `manifest.planFingerprint` must equal the referenced plan's fingerprint;
  any alteration of reviewed plan content invalidates the fingerprint and
  apply refuses.
- Every operation/decision carries `evidenceHash` = SHA-256 of the canonical
  current-state evidence used at plan time. Apply re-reads every affected row
  and refuses execution when the hash differs or the proposed state is not
  already persisted.

Manifest (`formatVersion: 1`): per-decision entries referencing plan decision
ids with an explicit reviewed resolution. Supported resolution shapes (only
those required by #421):

- `scalar-profile` (`DEMAND_FOLLOWING` / `WHOLE_PROJECT_ALLOCATION` + percent);
- `availability-window` (percent + window);
- `segmented-capacity-profile` (percent + explicit segments);
- `owner-kind-decision` (`NAMED_PERSON` / `PLANNED_RESOURCE` + capacity shape);
- `snapshot-window-interpretation` (window for windowless / single-`-1`
  snapshot entries).

Unresolved decisions prevent apply; malformed or disallowed resolutions are
rejected; no generic migration DSL is introduced. Production-specific
decisions are never embedded in repository source or tests.

## Transaction and drift strategy

Apply runs inside **one PostgreSQL transaction** for the bounded production
data size (a few thousand rows):

1. plan + manifest validation (fingerprint, formats, resolution shapes);
2. refusal when any decision is unresolved or any unsupported finding exists;
3. inside the transaction: re-read every affected owner/profile/snapshot,
   verify evidence hashes (or that the proposed state is already persisted →
   no-op), validate every proposed profile against the authoritative
   structural rules, write, then re-verify every write;
4. any failure rolls back everything — no partially repaired project is ever
   reported as successful;
5. after commit: re-run the planner and the permanent readiness gate; exit `1`
   with a full report if any non-policy blocker remains.

No distributed or resumable migration infrastructure is introduced. The
command is idempotent: applying the same reviewed plan twice is a no-op.

## Ownership-invariant migration sequencing

`20260721000001_enforce_capacity_profile_ownership_invariants` is a
constraint/index-only migration (CHECK constraints + partial unique indexes)
with its own SQL preflight checks. Production currently has 36 applied
migrations; this migration is pending and **must remain unapplied until the
database passes the profile ownership/completeness preconditions** (the
readiness gate).

**Recommended sequencing (primary):** after #421 remediation is installed and
the live readiness gate passes, and after the fresh backup + restore
verification of #404 Phase 2 is recorded, apply this migration as **its own
controlled step** with the application in maintenance mode:

```bash
npx prisma migrate deploy   # from the reviewed commit; applies only 20260721000001
```

Applying it separately keeps the later PR 2 deploy a single-migration deploy
(the drop-column migration), so constraint-enforcement failures can never be
entangled with the destructive step. Prisma applies pending migrations in
directory order, so if it is left pending it WILL be applied together with the
PR 2 migration during the Phase 4 `prisma migrate deploy` — acceptable but
couples the steps; the separate step is preferred. This PR does not modify,
apply or fold in that migration.

## #404 Production handoff procedure

The production machine must execute exactly these steps; stop on any failure
or drift. No step asks the production agent to invent data values.

1. **Install the reviewed #421 commit.** Check out the exact reviewed commit
   on `main`; confirm `git status --short` is clean and `git rev-parse HEAD`
   matches the recorded commit.
2. **Confirm the physical candidate columns still exist** (they do — no
   schema change is part of this release).
3. **Create a fresh backup before any remediation write**
   (`npm run db:backup`); record path, timestamp and database identity.
4. **Run dry-run against production:**

   ```bash
   npm run capacity-profiles:remediate-readiness -- --dry-run --json /tmp/plan.json
   ```

   Expect exit `2` (decisions remain) with the deterministic and
   decision-required counts matching the reviewed expectations.
5. **Save the plan outside the repository** (`/tmp/plan.json` above) — never
   commit plan or manifest files.
6. **Compare plan counts and fingerprint with the reviewed expectations.**
   Any mismatch stops the process.
7. **Obtain explicit decisions for every unresolved entry.** Each decision
   must be reviewed and recorded in the manifest format
   (`formatVersion: 1`, `planFingerprint` = plan fingerprint). The production
   agent must not edit JSON values on its own judgement.
8. **Rerun dry-run with the approved manifest:**

   ```bash
   npm run capacity-profiles:remediate-readiness -- --dry-run --json /tmp/plan-resolved.json --manifest /tmp/decisions.json
   ```

   Expect exit `0` and zero unresolved decisions.
9. **Apply the exact unchanged plan:**

   ```bash
   npm run capacity-profiles:remediate-readiness -- --apply --plan /tmp/plan-resolved.json
   ```

   (or `--apply --plan /tmp/plan.json --manifest /tmp/decisions.json`). Expect
   exit `0` with a complete applied/skipped report.
10. **Rerun the permanent readiness gate and the audit:**

    ```bash
    npm run capacity-profiles:readiness
    npm run capacity-profiles:audit
    ```

    Both must pass. Stop on any failure or drift.
11. **Create and restore-test a fresh post-remediation backup** (#404 Phase 2):
    backup, restore into a disposable database, run readiness + audit + the
    representative project checks on the restored copy, remove the disposable
    database and leave no `monrad_pg_` resources.
12. **Apply the ownership-invariant migration as its own controlled step**
    (see sequencing above) once the Phase 2 evidence is recorded.
13. **Authorize #418 PR 2 only after #404 records both successful gates**
    (readiness passing on the exact reviewed commit AND a restore-tested
    fresh backup).

Stop conditions: any non-zero exit, fingerprint/count mismatch, unexpected
drift, readiness failure, audit failure, backup/restore failure, or any
remaining ambiguous owner. **PR 2 remains blocked** until the gates pass.

## Tests

- `server/src/test/productionRemediationPlan.test.ts` — pure planner unit
  tests (classification matrix, never-active policy, overlap decomposition,
  fingerprint stability/tamper detection, manifest merge/refusals, exit
  classification).
- `server/src/test/productionRemediation.integration.test.ts` — Linux
  PostgreSQL suite covering dry-run (zero writes, stable fingerprints,
  credentials absent, production-scale counts), deterministic apply (all
  matrix rows, capacity/identity preservation, candidate columns frozen,
  runtime resolver profile-first), manifest decisions (unresolved/malformed/
  fingerprint/drift refusals, exact resolution, rerun no-op), transaction
  safety (mid-transaction rollback, no partial success), historical snapshots
  (all policy cases, minimal rewrites, readiness/rollback agreement, malformed
  refusal) and the end-to-end blocker-class database (readiness fails →
  dry-run → approved apply → audit + readiness pass → runtime loads →
  representative rollback → candidate columns remain).

Run via the Docker-backed local runner (`npm run test:integration:local`) or
directly with `INTEGRATION_TEST=true` against a disposable PostgreSQL 15.
