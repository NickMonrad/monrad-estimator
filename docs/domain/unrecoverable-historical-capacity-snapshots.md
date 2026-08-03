# Unrecoverable Historical Capacity Snapshots — Policy (Issue #426)

Status: **design only** — approved for review, not for implementation. This
document defines product and technical policy; it changes no runtime, API, UI,
schema or migration behaviour.

Parent: #342 · Related: #404, #418, #421 · Blocks: #404, #418 PR 2

## 1. Decision

**Quarantine in place, derived, raw-preserved.**

Historical v2 `BacklogSnapshot` entries whose capacity state cannot be
translated without inventing data are **quarantined (non-restorable)** under
this policy:

- The snapshot record is **preserved byte-for-byte**. Quarantine never deletes,
  rewrites or annotates the stored JSON.
- The quarantine state is **derived deterministically from the raw snapshot
  content at read time** by a shared classifier. It is **never persisted**; no
  schema or data migration is introduced.
- **Restoration is prohibited** for a quarantined snapshot. A rollback attempt
  fails before any write — including the `pre_rollback` auto-snapshot — and
  returns an explicit stable reason.
- **Listing, diff and raw inspection remain available.** The snapshot list
  gains a derived status and reason; the existing `GET /:snapshotId` raw JSON
  access and diff endpoint are unchanged.
- **Readiness may treat a derived-quarantined snapshot as policy-accepted and
  non-blocking**, because its unrecoverability is proven, not hidden. Every
  other failure class — malformed/unsupported snapshots and all live-state
  blockers, including the 130 decisions — **continues to fail readiness**.
- **New snapshots can never enter quarantine**: creation emits validated V4
  payloads with complete capacity ownership and windows.

The single approved policy sentence:

> Historical v2 capacity state that cannot be translated without guessing is
> quarantined in place: raw records preserved, classification derived from
> stored content, restoration refused with an explicit stable reason, and the
> quarantine accepted by readiness only because the unrecoverability is
> provable from the record itself.

This validates the baseline proposed in Issue #426. Repository evidence shows
it is the smallest safe policy (Sections 2, 9, 10).

## 2. Evidence and constraints

### 2.1 The affected records (sanitized production evidence)

The #404 pass-2 remediation plan (issue comment `5161973152`) and the
read-only decision packs (comments `5162063434`, `5162109939`) establish,
against the installed commit `e99b20e…`:

- 105 stored `BacklogSnapshot` rows; **67 snapshots** (of 105) across 10
  projects contain entries whose capacity state is not translatable.
- **940 historical snapshot decisions** are unrecoverable from stored data:
  - **933** snapshot entries with windowless `CAPACITY_PLAN` state
    (752 ResourceType entries + 181 NamedResource entries);
  - **7** snapshot entries with a single `-1` window edge. The pass-2 plan
    lists 8 single-`-1`/negative-edge decisions of which 7 are snapshot
    window-interpretation decisions; the 8th is the live NamedResource
    owner-kind decision already counted in the 13 below.
- The complete evidence-based review of all 1,070 plan decisions proposed
  **zero** resolutions: no stored or reviewed semantic evidence establishes
  the historical `startWeek`/`endWeek` for any of the 940
  (comment `5162109939`).

The 940 are **not** the 130 live-state decisions (104 ResourceType
owner-intent, 13 segmentless ROLE profiles, 13 NamedResource owner-kind).
Those concern current persisted rows, not snapshots, and remain out of scope
and blocked (Section 5.3).

### 2.2 Why missing windows cannot be inferred

V2 translation preserves a captured window into
`AVAILABILITY_WINDOW`/`LEGACY` profiles and requires both edges for
`CAPACITY_PLAN`:

- `server/src/lib/projectSnapshotCapacity.ts`:
  `CAPACITY_PLAN without a captured start/end window cannot be translated
  without guessing capacity` (resource-type branch; identical for named
  resources).
- The #421 deterministic matrix (`docs/domain/capacity-profile-readiness-remediation.md`)
  already forbids translating windowless `CAPACITY_PLAN` to full-project or
  unbounded capacity.

A window is a historical fact (which weeks the entry occupied). No stored
field records it for these entries; no rule derives it. Any filled-in value
would be invented capacity — explicitly excluded by #404, #418, #421 and #426.

### 2.3 Why current live project state is not valid historical evidence

A snapshot captures project state at a point in time. Current
`CapacityProfile`/`CapacitySegment`/`CapacityPlan` state reflects later
edits, later owners and later migration behaviour; it is evidence of the
present, not of the snapshot's intent. Using it to rewrite snapshot JSON would
silently rewrite history with later intent and is forbidden by the #404/#418
stop conditions ("do not invent or apply unreviewed data repairs").

### 2.4 Why structural similarity is insufficient

Windowless `CAPACITY_PLAN` entries are structurally identical to valid ones
apart from the missing window value. Shape similarity cannot supply the
missing value; classifying "like the others" would be a guess in disguise.
The repository classifier therefore never uses similarity — it uses the exact
per-entry error classes (Section 3).

## 3. Deterministic classification

One shared pure classifier derives the verdict from the raw snapshot content
only. It composes the existing, already-shared primitives:
`parseSnapshotData` (`server/src/lib/projectSnapshotTypes.ts`),
`translateV2SnapshotProfiles` (`server/src/lib/projectSnapshotCapacity.ts`),
`validateSnapshotV3` (`server/src/lib/projectSnapshotValidation.ts`) and the
#421 never-active policy (`isNeverActiveWindow`).

| Class | Exact condition (raw content only) | Behaviour |
|---|---|---|
| **Restorable** | Parses; V1 (epic-only, no capacity state) → always; V3/V4 → `validateSnapshotV3` passes; V2 → `translateV2SnapshotProfiles` returns zero errors | Listed as restorable; rollback allowed (existing preflight still applies); readiness passes it |
| **Quarantined / non-restorable** | Parses as V2 AND **every** translation error is in the proven-unrecoverable set: windowless `CAPACITY_PLAN` ("cannot be translated without guessing capacity") and single negative window edge ("must be a non-negative integer or null") | Raw record preserved; listed with a stable reason; rollback refused before any write; readiness treats as policy-accepted; remediation reports as quarantined with evidence |
| **Malformed / unsupported** | Parse fails (`SnapshotSchemaError`, unknown `schemaVersion`) OR any error outside the proven set — unknown `allocationMode`, orphan NamedResource, structural validation failure, or a **mixture** of proven and other errors | Always blocks readiness; rollback refused; reported as a defect; never quarantined |
| **Recoverable but currently failing validation** | Parses but fails V3/V4 validation or V2 translation for reasons a reviewed remediation could address (defect class above, resolved later with review or external evidence) | Always blocks readiness until a reviewed remediation resolves it; never silently excluded |

Fail-closed rules:

1. Quarantine requires **all** errors to be in the proven-unrecoverable set.
   Any mixture classifies as a defect.
2. Unknown `schemaVersion` and unparseable payloads are defects, never
   quarantine.
3. `(-1, -1)` pairs and inverted windows are **not** quarantine: the #421
   never-active policy already translates them deterministically to
   zero-capacity profiles (`isNeverActiveWindow`,
   `server/src/lib/projectSnapshotCapacity.ts`).
4. The classifier is a pure function of stored content: idempotent,
   deterministic, re-derivable on every run. No persisted marker, no state.

This is a single classifier, not a generic status framework — there is no
other entity that needs statuses.

## 4. Product and API behaviour

The smallest required surface:

- **Snapshot list** — `GET /api/projects/:projectId/snapshots`
  (`server/src/routes/snapshots.ts`) adds derived fields:
  - `restoreStatus: 'restorable' | 'non-restorable'`;
  - `restoreReason: string | null` — the stable reason, present only for
    non-restorable rows. The reason reuses the exact existing translation
    error strings so list, rollback, readiness and remediation share one
    string source.
  - Derivation cost is one parse + classify per stored snapshot — trivial at
    the retention cap of 20 snapshots per project (`pruneSnapshots`,
    `server/src/lib/snapshotUtils.ts`).
- **Status/reason display** — `client/src/components/SnapshotHistoryPanel.tsx`
  renders the status and reason for non-restorable rows and disables its
  Rollback control; the API remains the enforcement boundary.
- **Restore attempts** — `POST /api/projects/:projectId/snapshots/:snapshotId/rollback`
  returns **400** with `{ error: <stable reason> }` before any write. The
  classifier runs at the same pre-transaction point where translation errors
  are already surfaced today, so the existing fail-closed ordering
  (parse → validate → translate → preflight → single `$transaction`) is
  unchanged. No `pre_rollback` snapshot is created (that happens only inside
  the transaction, after validation). An optional stable
  `code: 'SNAPSHOT_NON_RESTORABLE'` may reuse the existing structured-error
  pattern (`CapacityIntegrityError` shape) if machine-readable handling is
  wanted; the message alone satisfies the requirement.
- **Raw export / inspection** — unchanged: `GET /:snapshotId` already returns
  the full row including the raw snapshot JSON; the diff endpoint remains
  available. No new export endpoint is needed.
- **Audit and log evidence** — quarantine is never silent: readiness and
  remediation reports enumerate every quarantined snapshot and entry with its
  reason and evidence hash (Sections 5.4, 5.5).

Acceptance criteria for the future implementation (observable):

1. A fixture V2 snapshot containing only windowless-`CAPACITY_PLAN` and/or
   single-`-1` errors lists as `non-restorable` with the stable reason.
2. A rollback attempt against it returns 400 with that reason, performs zero
   writes and creates no `pre_rollback` row.
3. A V2 snapshot with captured windows, and all V3/V4 snapshots, remain fully
   restorable.
4. A snapshot with any defect-class error (mixed errors, unknown mode, orphan,
   unparseable) is never listed as quarantined and always blocks readiness.

## 5. Readiness and remediation

### 5.1 May an approved historical quarantine cease blocking readiness?

Yes — but only for the derived-quarantine class, and only under this approved
policy. The readiness snapshot section (`checkSnapshots` /
`validateStoredSnapshot` in `server/src/lib/productionMigrationReadiness.ts`)
continues to parse and validate every stored snapshot. The change is purely in
blocker classification:

- a **quarantined** snapshot is reported as
  `quarantined (policy-accepted, non-restorable)` and is not a blocker;
- a **defect-class** snapshot remains a blocker.

The distinction between "approved historical quarantine" and "unresolved
recoverable defect" is exactly the reviewed policy constant: the
proven-unrecoverable error set (Section 3). It needs no marker, because it is
a deterministic property of the record — the same property the evidence
review already established for all 940 decisions.

### 5.2 Why this does not weaken current/recoverable validation

The quarantine verdict applies only to historical V2 payloads and only to the
two proven error classes. V1 handling, V3/V4 structural validation, the
live-state completeness/shape section, the ownership audit and the shared
translation helper are untouched. Any failure outside the proven set — for any
snapshot, any version — still fails readiness.

### 5.3 Readiness continues to fail for the 130 live decisions

The 130 live decisions are current-state blockers in the per-project
completeness/shape section, not snapshots. This policy does not touch them:
the 104 ResourceType owner-intent, 13 segmentless ROLE profiles and 13
NamedResource owner-kind decisions remain `decisionRequired`; readiness exit
remains non-zero until reviewed manifest decisions resolve them. Quarantining
the 940 therefore **shrinks but does not clear** the blocker set.

### 5.4 How remediation reports quarantined snapshots

The remediation planner (`classifySnapshotEntry` in
`server/src/lib/productionRemediationPlan.ts`) currently classifies the 940
as `decisionRequired` with allowed resolution
`snapshot-window-interpretation`. Under the approved policy it reclassifies
the two proven-unrecoverable classes as a derived **`quarantined`** finding
carrying the stable reason and the existing evidence hash:

- no apply operation is generated for a quarantined entry;
- the plan summary separates `quarantined` from `decisionRequired`;
- `classifyPlanExit` semantics stay fail-closed for everything else:
  unsupported findings → exit 1, unresolved decisions (the 130) → exit 2;
  quarantined-only → eligible for exit 0.

### 5.5 Quarantined rows remain in audit evidence

Yes. The readiness report and the remediation plan continue to enumerate every
quarantined snapshot and entry (sanitized identifiers, reasons, evidence
hashes). A quarantine is an explicit classification in the output, never an
omission.

### 5.6 Re-entry of externally supplied historical facts

Because classification is derived per run, the sanctioned re-entry path is the
existing reviewed manifest flow: an approved manifest decision with shape
`snapshot-window-interpretation` applies a minimal `rewrite-snapshot-entry`
operation writing only `allocationStartWeek`/`allocationEndWeek` (negative
fallback aliases cleared), re-validates the complete snapshot through the
shared translation, and is idempotent. On the next dry-run/readiness run the
snapshot re-derives as **restorable**. No new mechanism is required. This
document does not authorize any such rewrite; it documents the only path by
which one may later be authorized.

### 5.7 This design alone does not authorize #418 PR 2

#418 PR 2 additionally requires, per #404/#421: reviewed decisions for the
130 live blockers, remediation apply, readiness exit 0, a fresh
post-remediation backup with restore verification, and the separately
sequenced ownership-invariant migration step.

## 6. New snapshot prevention

Confirmed against current code — no new work required:

- `buildSnapshot` (`server/src/lib/projectSnapshotService.ts`) emits V4
  payloads: complete `CapacityProfile`/`CapacitySegment` ownership and
  windows, no legacy candidate columns. `POST /snapshots` validates before
  persisting (`validateSnapshotV3`) and applies the 20-per-project retention
  policy.
- V4 structurally cannot contain windowless `CAPACITY_PLAN` or `-1` edge
  classes — they exist only in legacy V2 payloads.
- Creation validation stays strict; new snapshots remain fully restorable.
  Existing coverage: `server/src/test/snapshots.test.ts` (V4 capture,
  `validateSnapshotV3` rules).

## 7. Migration and rollback

- **Schema migration:** none. `BacklogSnapshot` keeps its current shape
  (`server/prisma/schema.prisma`: `id, projectId, label, trigger, snapshot,
  createdAt, createdById`). No status/quarantine column.
- **Data migration:** none. Existing rows are untouched, byte-for-byte.
- **Rollback implications:** a quarantined snapshot never enters the rollback
  transaction; no `pre_rollback` auto-snapshot is created for a refused
  attempt; the current single-transaction restore path and its preflight
  checks are unchanged for restorable snapshots. Tests already prove the
  fail-closed ordering: untranslatable V2 payloads are rejected before any
  state change (`server/src/test/snapshotRollback.integration.test.ts`,
  including the windowless-`CAPACITY_PLAN` case).
- **Preservation:** raw records are retained in every path. The only
  sanctioned write to snapshot JSON remains the reviewed manifest
  `rewrite-snapshot-entry` operation (Section 5.6).
- **#404 backup/restore sequence:** unaffected. The classification is
  computed at runtime and never alters stored data; the verified backup
  remains the rollback mechanism.
- **Production evidence required before #418 PR 2** (restating the #404/#421
  gates, not adding new ones): approved policy merged (this document);
  remediation apply executed with the quarantined class excluded and the 130
  live decisions resolved; readiness exit 0; ownership audit pass; fresh
  post-remediation backup created and restore-verified; ownership-invariant
  migration `20260721000001_enforce_capacity_profile_ownership_invariants`
  applied only after those preconditions.

## 8. Implementation boundary

### Required implementation (only after this design is approved)

1. One shared pure classifier (co-located with the shared translation helper,
   e.g. `classifySnapshotRestorability` in
   `server/src/lib/projectSnapshotCapacity.ts`, or a small
   `server/src/lib/snapshotRestorability.ts`) built on `parseSnapshotData` +
   `translateV2SnapshotProfiles` + `validateSnapshotV3`, with the
   proven-unrecoverable error set as the reviewed policy constant.
2. Wire the classifier into:
   - `server/src/routes/snapshots.ts` — list `restoreStatus`/`restoreReason`;
     rollback pre-transaction refusal with the stable 400 reason;
   - `server/src/lib/productionMigrationReadiness.ts` — quarantine accepted,
     defect class still blocking;
   - `server/src/lib/productionRemediationPlan.ts` — snapshot entry
     classification moves from `decisionRequired` to `quarantined` for the two
     proven classes;
   - `client/src/components/SnapshotHistoryPanel.tsx` — status/reason display,
     disabled rollback control, reason surfaced on attempt.
3. Tests: classifier unit tests (every class, mixture fail-closed);
   `snapshots.test.ts` list shape; `snapshotRollback.integration.test.ts`
   (refusal before any write, no `pre_rollback` row);
   `productionMigrationReadiness.integration.test.ts` (quarantine accepted,
   defect blocks); `productionRemediationPlan.test.ts` and
   `productionRemediation.integration.test.ts` (reclassification, no
   operations generated, re-entry path via manifest rewrite).

Acceptance criteria are listed at the end of Section 4 and in Section 5.1.

### Explicitly deferred

- Quarantine-management UI (bulk review, notes) — not needed to satisfy the
  policy.
- Raw export/download UI — raw inspection already exists via
  `GET /:snapshotId`.
- Persisted quarantine marker — only if a future failure class becomes
  non-derivable from raw content (Section 9, alternative 5).
- Dedicated quarantine audit tooling beyond readiness/plan output.

### Optional follow-ups (non-blocking)

- A toast/inline error handler on the client rollback mutation (today the
  panel has no `onError` handler) so the server reason is visible on a refused
  attempt — this belongs with the required client change rather than a
  separate feature.

### Issue tracking

After review and approval, create a **separate focused implementation issue**
(and update #426 to link it), mirroring how #421 was spun out of #418. Keep
this design review pure; do not expand this PR into implementation.

## 9. Alternatives rejected

1. **Manually inventing historical windows.** Rejected: fabricates historical
   facts. The evidence-based review of all 1,070 decisions proposed zero
   resolutions (comment `5162109939`); no stored or semantic evidence
   determines the 940 windows. Violates the no-guessing constraint in #404,
   #418, #421 and #426.
2. **Translating from current project state.** Rejected: current
   `CapacityProfile`/`CapacityPlan` state is evidence of the present, not of
   the snapshot's intent (Section 2.3). Would rewrite history with later
   intent and is forbidden by the #404 stop conditions.
3. **Silently ignoring the snapshots.** Rejected: hides the evidence boundary.
   Rollback would still fail at runtime with unexplained errors, readiness
   would appear to pass while restoration is broken, and the audit record
   would lose the fact that these snapshots exist.
4. **Deleting historical snapshots.** Rejected: destroys evidence
   irreversibly and is explicitly forbidden ("never delete or rewrite the raw
   snapshot merely to pass readiness"). Would falsify the audit trail and
   remove the only basis for future re-entry.
5. **Persisting a quarantine marker field.** Rejected as the primary
   mechanism: requires a schema migration, a data migration and a backfill;
   the classification is a pure function of raw content, so a marker adds
   drift risk and no information, and can go stale if the raw record changes.
   Retained only as a fallback if a future failure class becomes
   non-derivable.
6. **Deriving the state (chosen).** No schema or data migration; idempotent
   and deterministic; automatically correct after any reviewed raw-content
   change; reuses the existing shared translation helper as the single source
   of truth.

## 10. Simplicity Check

- **Minimum correct solution:** one pure classifier + wiring at four
  touchpoints (list, rollback, readiness, remediation) + client display. No
  schema change, no data migration, no new endpoints, no new state.
- **Essential abstractions:** exactly one — the shared classifier that
  produces the verdict consumed by list, rollback, readiness and remediation.
  It has one clear reason to change (the policy boundary) and reuses
  `translateV2SnapshotProfiles` rather than duplicating translation logic.
- **Deferred extensions:** persisted markers, management/export UI, dedicated
  audit tooling (Section 8).
- **Responsibility boundaries:** the classifier owns the verdict; routes own
  refusal/status surfacing; readiness owns blocker semantics; remediation owns
  plan classification; the client owns display. No component duplicates
  another's decision.
- **No hypothetical-future complexity:** the re-entry path reuses the existing
  manifest `snapshot-window-interpretation` operation; nothing is built for a
  future need.

## Appendix — Sources reviewed

Repository code (worktree at `e99b20e…`, branch
`design/426-unrecoverable-snapshot-policy`):

- `server/src/lib/projectSnapshotTypes.ts` — V1/V2/V3/V4 formats, version
  detection, `parseSnapshotData`.
- `server/src/lib/projectSnapshotService.ts` — `buildSnapshot` (V4 creation),
  `rollbackProjectSnapshot` (parse → validate → translate → preflight → single
  transaction), error types.
- `server/src/lib/projectSnapshotCapacity.ts` — shared v2 translation
  (`translateV2SnapshotProfiles`), `isNeverActiveWindow`, error classes and
  exact messages.
- `server/src/lib/projectSnapshotValidation.ts` — `validateSnapshotV3`.
- `server/src/lib/snapshotUtils.ts` — retention pruning (20/project).
- `server/src/routes/snapshots.ts` — list, create, detail, diff, rollback;
  error mapping (404/400, `{ error }` bodies).
- `server/src/lib/productionMigrationReadiness.ts` — three-section readiness,
  snapshot section (`checkSnapshots`, `validateStoredSnapshot`), shared
  translation helper.
- `server/src/lib/productionRemediationPlan.ts` — `classifySnapshotEntry`,
  `classifyPlanExit`, manifest shapes, `rewrite-snapshot-entry` op.
- `server/prisma/schema.prisma` — `BacklogSnapshot` model (no status column).
- `client/src/components/SnapshotHistoryPanel.tsx`, `client/src/lib/api.ts` —
  list/create/rollback/diff surface.
- `server/src/middleware/errorHandler.ts` — structured-error pattern.

Tests:

- `server/src/test/snapshots.test.ts` — parse/validate/create.
- `server/src/test/snapshotRollback.integration.test.ts` — V4 round-trip,
  V1 restore, V2 translation success/failure before any write, orphan
  rejection, never-active normalization, preflight and FK-failure rollback
  safety.
- `server/src/test/productionMigrationReadiness.integration.test.ts` —
  readiness snapshot section.
- `server/src/test/productionRemediationPlan.test.ts` and
  `server/src/test/productionRemediation.integration.test.ts` — derivation
  matrix, manifest flow, refusals.
- `server/src/test/projectSnapshotJsonValue.test.ts` — JSON value validation.

Documentation:

- `docs/domain/capacity-profile-readiness-remediation.md` — #421 command,
  deterministic matrix, historical v2 snapshot policy, manifest formats,
  handoff procedure, ownership-invariant migration sequencing.
- `docs/domain/legacy-capacity-column-runtime-cutover.md` — PR 1 cutover,
  V2→V3 translation, fail-closed rollback.

Sanitized production evidence (Issue #404 comments only — no production
system or data was accessed):

- `5161973152` — production pass 2 plan and counts.
- `5162063434` — read-only decision review pack (1,070 decisions; 7 groups).
- `5162109939` — evidence-based proposal result (0 proposals; 940/130 split).
