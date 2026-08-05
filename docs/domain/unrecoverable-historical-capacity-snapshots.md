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
- **Quarantined snapshots are protected from automatic retention pruning**:
  the existing 20-snapshot retention cap continues to apply to prunable
  restorable snapshots only; a quarantined historical snapshot is never
  deleted by snapshot creation or retention handling.

The single approved policy sentence:

> Historical v2 capacity state that cannot be translated without guessing is
> quarantined in place: raw records preserved, classification derived from
> stored content, restoration refused with an explicit stable reason, the
> quarantine accepted by readiness only because the unrecoverability is
> provable from the record itself, and quarantined records protected from
> automatic retention deletion.

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

The quoted messages are diagnostics of the existing translation helper; they
describe why translation stops, but they are not the classifier's predicates
(Section 3).

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
per-entry raw-value predicates (Section 3).

## 3. Deterministic classification

Quarantine is decided by **exact raw-value predicates on the stored V2
payload** — never by matching translation error strings. Translation errors
remain diagnostics only; they are not the classifier's source of truth (a
single error message can also represent unrelated corruption).

One shared pure classifier derives the verdict from the raw snapshot content
only. It composes the existing, already-shared primitives:
`parseSnapshotData` (`server/src/lib/projectSnapshotTypes.ts`),
`translateV2SnapshotProfiles` (`server/src/lib/projectSnapshotCapacity.ts`),
`validateSnapshotV3` (`server/src/lib/projectSnapshotValidation.ts`) and the
#421 never-active policy (`isNeverActiveWindow`), but applies the raw-value
predicates below as the policy boundary.

**Effective values.** For each V2 entry the classifier computes the effective
allocation mode and effective window edges under the existing V2 rules:

- ResourceType entries: mode = `allocationMode`; effective edges =
  `allocationStartWeek` / `allocationEndWeek`.
- NamedResource entries: effective mode =
  `namedResource.allocationMode ?? parentResourceType.allocationMode ?? null`
  — the exact rule used by the authoritative V2 translator
  (`translateV2SnapshotProfiles`, `server/src/lib/projectSnapshotCapacity.ts`).
  An explicit NamedResource `allocationMode` overrides the parent mode; when
  the NamedResource mode is null or absent, the parent ResourceType mode is
  inherited; a missing `resourceTypeId` or an absent parent ResourceType is an
  orphan ownership defect and can never quarantine. Effective edges =
  `allocationStartWeek` / `allocationEndWeek`, with the V2 alias fallback
  (`startWeek` / `endWeek`) where the V2 rules define it. Any populated
  alternate alias must agree with the effective edge; a populated alias that
  disagrees is a defect.

The classifier and the translator must share this effective-mode semantic
contract rather than implementing different mode rules.

**Approved quarantine scope.** A historical entry may be quarantined only when
all of the following hold:

1. it parses as V2;
2. its effective allocation mode is exactly `CAPACITY_PLAN`;
3. it matches exactly one of the two reviewed raw shapes below (Class A or
   Class B);
4. it has no additional translation, structural, ownership, alias or parsing
   defect.

### Class A — approved windowless `CAPACITY_PLAN` (reviewed 933)

The narrowest proven interpretation:

- both effective window edges are absent/null;
- no populated alternate alias supplies a conflicting or different value;
- the entry has no other error.

A **partial one-null/one-valid window** (one effective edge null, the other
populated) is **not** quarantine: the sanitized evidence does not prove that
shape belongs to the reviewed 933, so it stays blocking.

### Class B — approved single-`-1` edge (reviewed 7)

The approved sentinel-edge shape is exact:

- exactly one effective window edge equals `-1`;
- the other effective edge is a non-negative integer;
- the effective mode is `CAPACITY_PLAN`;
- no alternate alias conflicts with the effective edge;
- no other populated alias contains another negative, fractional or invalid
  value;
- the entry has no other error.

### Explicitly not quarantine

These shapes are never quarantine. They resolve into three outcomes:
deterministic never-active shapes (restorable via the reviewed zero-capacity
translation, no human decision), valid non-`CAPACITY_PLAN` entries (restorable
through the existing translation, no human decision), and blocking defects
(all the rest).

- `(-1, -1)` — deterministic never-active (zero capacity); restorable, not a
  blocking defect;
- non-negative inverted windows (`start > end`) — deterministic never-active;
  restorable, not a blocking defect;
- valid `TIMELINE` entries — `null`/`null` effective windows are unbounded
  capacity, and valid non-negative captured windows translate directly;
  restorable, not blocking;
- valid `EFFORT`, `FULL_PROJECT` and null-mode entries — follow the existing
  translation rules (stale window aliases that are null or valid are
  deliberately discarded); restorable, not blocking;
- values below `-1` (e.g. `-2`) in any populated window field;
- fractional weeks in any populated window field;
- one `-1` edge paired with null (effective `CAPACITY_PLAN`);
- one missing edge paired with a populated non-null edge (effective
  `CAPACITY_PLAN`, unless separately proven);
- a single negative edge such as `-1` in a window-using non-`CAPACITY_PLAN`
  mode (e.g. `TIMELINE`) paired with a non-negative value or null — an
  actual translation defect, blocking;
- conflicting `allocationStartWeek`/`startWeek` or
  `allocationEndWeek`/`endWeek` aliases;
- invalid stale aliases (any populated alias holding a negative, fractional
  or otherwise invalid value);
- mixed quarantine-shape and independent defect errors;
- unknown modes, orphan owners, malformed payloads or structural validation
  failures.

An effective mode other than `CAPACITY_PLAN` is **outside quarantine**: the
entry is restorable when the existing translation succeeds and blocking only
when an independent translation, ownership, parsing or structural defect
exists. A mode differing from `CAPACITY_PLAN` is never itself an error.

### Snapshot-level verdict

A snapshot is derived-quarantined **only** when:

- it contains **at least one** entry matching an approved quarantine
  predicate, and
- **every other** entry either translates successfully (zero translation
  errors) or matches an approved quarantine predicate.

Any other error — in any entry — makes the snapshot a **blocking defect**, and
defects are never quarantined.

### Classification table

| Class | Exact condition (raw content only) | Behaviour |
|---|---|---|
| **Restorable** | Parses; V1 (epic-only, no capacity state) → always; V3/V4 → `validateSnapshotV3` passes; V2 → `translateV2SnapshotProfiles` returns zero errors, including deterministic never-active normalization (`(-1, -1)` pairs, non-negative inverted windows) and valid non-`CAPACITY_PLAN` translations (`TIMELINE` unbounded or captured windows; `EFFORT`/`FULL_PROJECT`/null mode with windows discarded) | Listed as restorable; rollback allowed (existing preflight still applies); readiness passes it |
| **Quarantined / non-restorable** | Parses as V2; at least one entry matches Class A or Class B exactly; every other entry translates successfully or matches Class A/Class B; no defect-class error anywhere | Raw record preserved and protected from retention pruning; listed with a stable reason; rollback refused before any write; readiness treats as policy-accepted; remediation reports as quarantined with evidence |
| **Malformed / unsupported** | Parse fails (`SnapshotSchemaError`, unknown `schemaVersion`) OR any entry has an error outside Class A/Class B — unknown `allocationMode`, orphan NamedResource, partial windows, alias conflicts, invalid values, structural failure, or a **mixture** of quarantine and other errors | Always blocks readiness; rollback refused; reported as a defect; never quarantined |
| **Recoverable but currently failing validation** | Parses but fails V3/V4 validation or V2 translation for reasons a reviewed remediation could address (defect class above, resolved later with review or external evidence) | Always blocks readiness until a reviewed remediation resolves it; never silently excluded |

### Fail-closed rules

1. Raw-value predicates are the classifier's source of truth. Translation
   error strings may remain diagnostics but are never the policy boundary.
2. Quarantine requires **all** errors to belong to an approved quarantine
   shape; any mixture classifies as a defect.
3. Unknown `schemaVersion` and unparseable payloads are defects, never
   quarantine.
4. `(-1, -1)` pairs and non-negative inverted windows are **not** quarantine:
   the #421 never-active policy already translates them deterministically to
   zero-capacity profiles (`isNeverActiveWindow`,
   `server/src/lib/projectSnapshotCapacity.ts`).
5. An effective mode other than `CAPACITY_PLAN` is **outside quarantine**:
   it is restorable when the existing translation succeeds and blocking only
   when an independent translation, ownership, parsing or structural defect
   exists. A mode differing from `CAPACITY_PLAN` is never itself an error.
6. The classifier is a pure function of stored content: idempotent,
   deterministic, re-derivable on every run. No persisted marker, no state.

**Coverage statement.** The predicates cover exactly the reviewed production
classes — 933 approved windowless entries and 7 approved single-`-1` entries
across the 67 affected snapshots — and claim no broader coverage.

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
    the retention scale (up to 20 restorable snapshots per project plus any
    preserved quarantined historical snapshots; see Section 7).
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

Acceptance criteria for the future implementation (observable), grouped by
the three possible outcomes:

**A. Quarantined / non-restorable**

1. A fixture V2 snapshot containing only entries matching Class A (both
   effective window edges absent/null, no conflicting aliases, no other
   defect) lists as `non-restorable` with the stable reason.
2. A fixture V2 snapshot containing only entries matching Class B (exactly
   one effective edge `-1`, the other a non-negative integer, no alias
   conflicts, no other defect) lists as `non-restorable` with the stable
   reason.
3. A rollback attempt against either fixture returns 400 with that reason,
   performs zero writes and creates no `pre_rollback` row.
4. The snapshot-level fail-closed requirements of Section 3 hold: at least
   one approved entry, every other entry translating successfully or
   matching an approved shape, and no defect-class error anywhere.

**B. Deterministic / restorable (not quarantined, not blocking)**

5. A `(-1, -1)` effective window pair and a non-negative inverted effective
   window (`start > end`) are translated to the reviewed zero-capacity
   representation (never-active policy): they do **not** quarantine, do not
   block readiness, remain restorable through the existing deterministic
   translation, and require no human decision.
6. Valid non-`CAPACITY_PLAN` entries remain restorable through the existing
   translation and are **not** blocking — never merely because the effective
   mode differs from `CAPACITY_PLAN`:
   - `TIMELINE` with `null`/`null` effective windows — valid unbounded
     capacity;
   - `TIMELINE` with valid non-negative captured windows — translated
     directly;
   - `EFFORT`, `FULL_PROJECT` and null modes — follow the existing
     translation rules (stale window aliases that are null or valid are
     deliberately discarded);
   - explicit NamedResource mode override producing a valid translation
     (e.g. explicit `TIMELINE` with a `CAPACITY_PLAN` parent).

**C. Blocking defects (not quarantined)**

7. An effective mode other than `CAPACITY_PLAN` is outside quarantine: it is
   restorable when the existing translation succeeds and blocking only when
   an independent translation, ownership, parsing or structural defect
   exists. Each case below classifies as a **blocking defect**, never as
   quarantine:
   - one-null/one-valid effective window (effective `CAPACITY_PLAN`);
   - one `-1` edge paired with null (effective `CAPACITY_PLAN`);
   - one missing edge paired with a populated non-null edge (effective
     `CAPACITY_PLAN`);
   - a single negative edge such as `-1` in a window-using
     non-`CAPACITY_PLAN` mode (e.g. `TIMELINE`) paired with a non-negative
     value or null;
   - a value below `-1` (e.g. `-2`) in any populated window field;
   - a fractional or non-integer week in any populated window field;
   - conflicting `allocationStartWeek`/`startWeek` or
     `allocationEndWeek`/`endWeek` aliases that cannot be reconciled under
     the existing V2 rules;
   - an invalid populated alias (negative, fractional or otherwise invalid
     value);
   - a mixture of quarantine-shape and independent defect in one snapshot;
   - an unknown `allocationMode`;
   - an orphan NamedResource (missing/unknown `resourceTypeId` or absent
     parent ResourceType);
   - an unparseable payload or unknown `schemaVersion`;
   - structural-validation failures.

**NamedResource mode-inheritance acceptance cases** (same three-outcome
contract, effective mode =
`namedResource.allocationMode ?? parentResourceType.allocationMode ?? null`):

8. NamedResource mode null + parent `CAPACITY_PLAN` + Class A or Class B:
   effective mode is `CAPACITY_PLAN`; the entry quarantines when all
   remaining predicates pass.
9. NamedResource explicit `CAPACITY_PLAN` + non-`CAPACITY_PLAN` parent:
   explicit mode wins; the entry may quarantine when Class A/B and all
   remaining predicates pass.
10. NamedResource explicit `TIMELINE` + parent `CAPACITY_PLAN`: explicit mode
    wins; the entry does not quarantine as `CAPACITY_PLAN` and remains
    restorable when the translation succeeds.
11. NamedResource mode null + parent `TIMELINE` with `null`/`null` windows:
    inherited effective mode is `TIMELINE`; restorable unbounded, not
    quarantined.
12. NamedResource mode null + parent `EFFORT`, `FULL_PROJECT` or null: the
    inherited effective mode is not `CAPACITY_PLAN`; the entry follows the
    existing translation and does not quarantine under this policy.
13. Missing/unknown `resourceTypeId` or absent parent ResourceType: blocking
    orphan defect; never quarantine.

**Retention acceptance cases**

14. Creating a new V4 snapshot while quarantined historical snapshots exist
    does not delete the quarantined rows, and ordinary restorable-snapshot
    retention (newest 20) continues to work (Section 7).
15. A snapshot whose classification cannot be completed is never silently
    deleted by retention handling (Section 7).

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
recoverable defect" is exactly the reviewed policy constant: the approved
raw-value predicates, Classes A and B (Section 3). It needs no marker, because
it is a deterministic property of the record — the same property the evidence
review already established for all 940 decisions.

### 5.2 Why this does not weaken current/recoverable validation

The quarantine verdict applies only to historical V2 payloads and only to the
two approved raw-value shapes (Classes A and B). V1 handling, V3/V4
structural validation, the live-state completeness/shape section, the
ownership audit and the shared translation helper are untouched. Any failure
outside the approved shapes — for any snapshot, any version — still fails
readiness; valid non-`CAPACITY_PLAN` translations are not failures.

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
the two approved raw-value shapes (Section 3) as a derived
**`quarantined`** finding carrying the stable reason and the existing
evidence hash:

- quarantined findings are removed from `decisionRequired` and receive **no
  plan decision ID** (they no longer appear in `plan.decisions`);
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

The current #421 manifest flow **cannot** re-enter quarantined entries:
quarantined findings are removed from `decisionRequired`, they have no plan
decision ID, and the manifest resolver only resolves entries listed in
`plan.decisions`. The existing manifest must reject — or remain unable to
address — a quarantined entry; nothing in this design implies otherwise.

The minimum feasible re-entry contract is:

1. A quarantined snapshot remains non-restorable unless new explicit
   historical evidence is supplied.
2. The evidence must identify the exact snapshot entry and the exact intended
   window, and must receive human review.
3. Re-entry requires a **separate focused remediation issue** and a
   **separately reviewed targeted artifact or command** — it is not part of
   the first quarantine implementation.
4. That future artifact must:
   - bind to the exact snapshot and its evidence hash;
   - support dry-run;
   - change only the approved window fields;
   - run transactionally and fail on drift;
   - revalidate the complete snapshot;
   - preserve unrelated raw content;
   - produce audit evidence.
5. After that separately reviewed repair, the derived classifier naturally
   reclassifies the snapshot as **restorable** on the next run — no
   persisted state is needed.
6. The re-entry mechanism is **deferred** and not required for the first
   quarantine implementation.

This document does not authorize any such repair; it only fixes the boundary:
quarantine is permanent until a separately reviewed, evidence-bound repair is
authorized under its own issue.

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
  Creating a new snapshot must never delete an existing quarantined
  historical snapshot (retention protection, Section 7).
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
- **Retention protection:** `pruneSnapshots`
  (`server/src/lib/snapshotUtils.ts`, called after every snapshot creation)
  currently deletes every record beyond the newest 20 for a project. The
  future implementation must **exclude derived-quarantined snapshots from
  automatic pruning**, using the smallest policy:
  - quarantined snapshots are never deleted by retention handling;
  - the existing retention cap continues to apply to prunable/restorable
    snapshots, so a project may contain its normal retained restorable
    snapshots **plus** preserved quarantined historical snapshots;
  - snapshot creation must not delete a quarantined row;
  - if a snapshot's classification cannot be completed, the snapshot is kept
    (fail closed) — a classification failure must never silently delete a
    record;
  - retention handling never rewrites stored snapshot JSON;
  - no archival framework, generic legal-hold system or new management
    product is introduced.
  Future tests must prove: (1) creating new V4 snapshots does not delete a
  quarantined historical snapshot; (2) ordinary restorable-snapshot retention
  still works; (3) classification failure does not silently delete a record;
  (4) no stored snapshot JSON is rewritten by retention handling.
- **Preservation:** raw records are retained in every path. The only
  sanctioned write to snapshot JSON is a separately reviewed, evidence-bound
  repair authorized under the re-entry contract (Section 5.6); the existing
  manifest flow cannot address quarantined entries.
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
   `translateV2SnapshotProfiles` + `validateSnapshotV3`, with the approved
   raw-value predicates (Classes A and B, Section 3) as the reviewed policy
   constant and the shared effective-mode rule
   (`namedResource.allocationMode ?? parentResourceType.allocationMode ??
   null`) taken from the translator. Translation error strings are
   diagnostics only.
2. Wire the classifier into:
   - `server/src/routes/snapshots.ts` — list `restoreStatus`/`restoreReason`;
     rollback pre-transaction refusal with the stable 400 reason;
   - `server/src/lib/productionMigrationReadiness.ts` — quarantine accepted,
     defect class still blocking;
   - `server/src/lib/productionRemediationPlan.ts` — snapshot entries
     matching Classes A/B move from `decisionRequired` to `quarantined` with
     no plan decision ID, and no apply operation is generated for them;
   - `server/src/lib/snapshotUtils.ts` (`pruneSnapshots`) or its direct
     caller — exclude derived-quarantined snapshots from automatic pruning
     (Section 7);
   - `client/src/components/SnapshotHistoryPanel.tsx` — status/reason display,
     disabled rollback control, reason surfaced on attempt.
3. Tests:
   - classifier unit tests covering **every positive and negative boundary
     case** in Sections 3–4 across the three outcomes:
     quarantine (Class A, Class B, snapshot-level at-least-one/mixed rules),
     deterministic/restorable (`(-1, -1)`, non-negative inverted windows,
     valid non-`CAPACITY_PLAN` entries: `TIMELINE` null/null and captured
     windows, `EFFORT`/`FULL_PROJECT`/null mode with discarded windows), and
     blocking defects (one-null/one-valid, one `-1` paired with null,
     `TIMELINE` single negative edge, values below `-1`, fractional weeks,
     conflicting aliases, invalid populated aliases, unknown mode, orphan
     NamedResource), plus the NamedResource mode-inheritance cases
     (null mode + parent `CAPACITY_PLAN`; explicit override; inherited
     non-`CAPACITY_PLAN` parent; missing/absent parent);
   - `snapshots.test.ts` list shape;
   - `snapshotRollback.integration.test.ts` (refusal before any write, no
     `pre_rollback` row);
   - `productionMigrationReadiness.integration.test.ts` (quarantine accepted,
     defect blocks);
   - `productionRemediationPlan.test.ts` and
     `productionRemediation.integration.test.ts` (reclassification of
     Classes A/B, no plan decision IDs, no operations generated);
   - retention tests per Section 7 (quarantined rows survive new V4 creation;
     ordinary restorable retention still works; classification failure does
     not silently delete; no stored JSON rewritten by retention handling).

Acceptance criteria are listed at the end of Section 4 and in Section 5.1.

### Explicitly deferred

- **Quarantine re-entry repair** — the separately reviewed, evidence-bound
  artifact or command defined in Section 5.6; requires its own focused issue.
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
   remove the only basis for future re-entry. Automatic retention pruning is
   a distinct deletion hazard, addressed by excluding quarantined snapshots
   from `pruneSnapshots` (Section 7).
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

- **Minimum correct solution:** one pure classifier + wiring at five
  touchpoints (list, rollback, readiness, remediation, retention pruning) +
  client display. No schema change, no data migration, no new endpoints, no
  new state.
- **Essential abstractions:** exactly one — the shared classifier that
  produces the verdict consumed by list, rollback, readiness, remediation
  and retention handling. It has one clear reason to change (the policy
  boundary) and reuses `translateV2SnapshotProfiles` rather than duplicating
  translation logic.
- **Deferred extensions:** the quarantine re-entry repair (Section 5.6),
  persisted markers, management/export UI, dedicated audit tooling
  (Section 8).
- **Responsibility boundaries:** the classifier owns the verdict; routes own
  refusal/status surfacing; readiness owns blocker semantics; remediation
  owns plan classification; retention handling owns pruning exclusion; the
  client owns display. No component duplicates another's decision.
- **No hypothetical-future complexity:** nothing is built for a future need —
  re-entry is deferred to a separately reviewed, evidence-bound repair under
  its own issue (Section 5.6) and is not part of the first implementation.

## 11. Implementation record (Issue #428)

Implemented on merged main (`fe80eb7c`, PR #427) by the `#428` PR. This
section records only the implemented component/function names and actual API
fields; it does not restate or broaden the policy.

- **Classifier** — `classifySnapshotRestorability(raw, projectId)` in
  `server/src/lib/snapshotRestorability.ts`, returning a discriminated
  verdict `{ kind: 'restorable' }` | `{ kind: 'quarantined', … }` |
  `{ kind: 'defect', … }` with `restoreStatus: 'restorable' |
  'non-restorable'` and `restoreReason: string | null`. The raw-value shape
  predicate is `classifyV2QuarantineShape(fields)`; stable reasons are
  `QUARANTINE_CLASS_A_REASON` and `QUARANTINE_CLASS_B_REASON`.
- **Shared translator helpers** — `v2ResourceTypeEntryErrors`,
  `v2NamedResourceEntryErrors`, `v2EffectiveNamedMode`, `isKnownV2Mode`,
  `v2PercentIsValid`, `v2ProfilesToStructureInput` and
  `validateV2TranslatedProfiles` in `server/src/lib/projectSnapshotCapacity.ts`;
  the authoritative translator and the classifier run the same entry-level
  rules (never-active policy, alias fallback, orphan rejection, percentage
  and window-value checks).
- **Listing API** — `GET /api/projects/:projectId/snapshots` returns the
  existing fields plus `restoreStatus` and `restoreReason` per row, derived
  from the stored content at read time.
- **Rollback** — `rollbackProjectSnapshot` refuses any non-restorable
  snapshot (quarantined or defective) with a 400 `{ error: <reason> }`
  before any write, including the `pre_rollback` auto-snapshot.
- **Retention** — `pruneSnapshots` (newest-20 cap) deletes only snapshots
  positively classified restorable; quarantined and unclassifiable records
  are preserved and never rewritten.
- **Readiness** — the snapshot section classifies via the shared classifier;
  quarantined snapshots are reported as
  `quarantined (policy-accepted, non-restorable)` in a new `notes` list and
  never block; every defect class still blocks.
- **Remediation** — the planner classifies approved Class A/B entries as
  `quarantined` findings with the stable reason and evidence hash, no plan
  decision ID and no apply operation; `plan.summary.quarantined` counts them
  separately. `classifyPlanExit` is unchanged (quarantine-only is eligible
  for exit 0; decisions → 2; unsupported → 1). The manifest resolver cannot
  address quarantined entries.
- **Client** — `SnapshotHistoryPanel` renders `Non-restorable` with the
  reason for non-restorable rows and does not render the Rollback control;
  Diff/inspection remains available.

### Observed production outcome at the PR #429 implementation

At the merged release `ffed1fa` two stable read-only production dry-runs
(identical fingerprints and baseline-state hash) observed: **574 quarantined
snapshot-entry findings (all Class A), 49 policy-accepted quarantined
snapshots, 18 defect-classified snapshots, 366 remaining snapshot decisions
(359 windowless entries across all 18 defect-classified snapshots — 226 in
the 11-snapshot windowless-only subgroup and 133 in the 7-snapshot
single-`-1` subgroup — plus 7 single-`-1` with a null other edge, the
seven-snapshot subgroup holding 140 total decisions), 130 live-state
decisions, 0 unsupported, 0 snapshot rewrite operations** (Issue #404
comments `5172781179`, `5174355909`).

These figures supersede the earlier operational expectation that all 940
pass-2 snapshot decisions (933 windowless + 7 single-`-1`) would immediately
quarantine: 940 was the per-entry decision inventory, not a quarantine
outcome, and `940 = 574 + 366` under the approved snapshot-level fail-closed
rule (§3) and the explicit `-1`+null exclusion. They remain the **correct
expected result for the currently merged classifier**.

Issue #430 has now completed its evidence-backed classification against the
sanitized production evidence emitted at `019db41b` (Issue #404 comment
`5187338312`, Issue #430 comment `5187339153`): the seven S records are
**deterministic zero** (raw alias pair `(-1,-1)` is the scheduler-consumed
never-active sentinel) and the 574 Class A entries are **deterministic full
capacity** (legacy scheduler gate and explicit 100% percentage branch prove
unbounded 100% weekly capacity). The recommended policy amendment is
recorded in [Section 12](#12-evidence-backed-amendment-issue-430) of this
document and in
[`remaining-historical-snapshot-investigation.md`](remaining-historical-snapshot-investigation.md)
Section 11 (Issue #430). No runtime behaviour changes through that
investigation; the amendment is design-only pending review.

## 12. Evidence-backed amendment (Issue #430) — design only, not implemented

Status: **design only, pending review** — this section amends the approved
policy where the sanitized production evidence (Issue #404 comment
`5187338312`; Issue #430 comment `5187339153`; evidence JSON SHA-256
`99745f68e172829f4f6ec868206f8822bc2782948c542c9dff069075830b1e41`,
Markdown SHA-256
`b0ad5fcb133e86794fb07d1036c4bada9384af984ea38c248b8576a89c55d312`,
plan fingerprint `eccf77ed…`, baseline `09b504b5…`) proves a deterministic
historical outcome. It does not change any runtime behaviour; a separate
implementation issue (mirroring the #426 → #428 flow) is required before the
classifier, translator, plan or readiness change.

The full evidence analysis, per-subgroup records and count arithmetic live in
[`remaining-historical-snapshot-investigation.md`](remaining-historical-snapshot-investigation.md)
Section 11. This section records only the policy amendment.

### 12.1 S predicate — deterministic zero (supersedes part of the never-active handling)

The legacy scheduler consumed, for a NamedResource row, only the alias pair
`startWeek`/`endWeek` as the outer capacity gate
(`start = nr.startWeek ?? 0`, `end = nr.endWeek ?? Infinity`, inclusive
`week >= start && week <= end`; verified at `f783b26` 2026-05-01, `74b98d3`
2026-05-05 and `b194e6c` 2026-07-14 in `server/src/lib/scheduler.ts`). The
exact observed S shape — raw `startWeek`/`endWeek` both `-1` (the legacy
Squad Planner never-active sentinel), `allocationStartWeek` null,
`allocationEndWeek` populated (non-negative integer), raw mode explicit
`CAPACITY_PLAN`, percents valid — therefore has a provably **zero active
interval** (the gate admits no non-negative week), regardless of the
populated primary end field (never a scheduler input for `CAPACITY_PLAN`)
and regardless of the 100% percentage fields. Outcome: **deterministic zero
capacity**, never quarantine and never decision-required.

Smallest valid authoritative representation: the existing never-active
translation — `AVAILABILITY_WINDOW`/`LEGACY` profile, `defaultPercent 0`,
null window (identical to the `(-1,-1)` handling). The classifier evaluates
the never-active predicate on the raw alias pair before the effective-edge
and alias-conflict checks for `CAPACITY_PLAN` NamedResources; the end-edge
alias conflict becomes scheduler-irrelevant (reported in evidence, not a
defect). Fail-closed exclusions: inherited mode; populated
`allocationStartWeek`; one alias `-1` + other null; below-`-1`/fractional
values anywhere; percent categories other than the observed valid set;
structural defects.

### 12.2 Class A predicate — deterministic full capacity (supersedes the windowless quarantine class for the exact observed shape)

The evidence proves every one of the 574 quarantined entries is windowless
`CAPACITY_PLAN` at 100% (531 ResourceType with `allocationPercent` 100; 43
NamedResource explicit with `allocationPercent` 100 and `allocationPct` 100;
all 43 fallback aliases absent; no conflicts or structural defects; 6
ResourceType-only + 43 mixed snapshots; eras before 2026-05-05 and
2026-05-05→2026-07-13). Under the legacy scheduler contract:

- **NamedResource entries**: the gate defaulted `null`/`null` to `0..∞`
  (unbounded active interval) and the explicit `CAPACITY_PLAN` percentage
  branch returned `allocationPercent` = 100 (from `74b98d3` 2026-05-05;
  before it the default was also 100) — provably **unbounded 100% weekly
  capacity**, era-independent.
- **ResourceType entries**: the scheduler never consumed a ResourceType's
own allocation fields. `getWeeklyCapacity` summed NamedResource
contributions (each gated on its own alias pair) plus full-time phantom
slots `max(0, count − namedResources.length)`, so with every snapshot entry
windowless at 100% the exact historical weekly capacity is
`max(count, namedResources.length) × hoursPerDay × 5` — **not**
unconditionally `count × hoursPerDay × 5`. The `max()` cannot be collapsed:
the legacy `resourceTypes.ts` `PUT` (`74b98d3`) accepted `count` from the
request body without synchronising the NamedResource collection, so no
historical invariant guaranteed `count ≥ namedResources.length`. `count`,
`hoursPerDay` and the per-RT NamedResource set are all captured in the V2
payload. The condition is snapshot-wide: the predicate fails closed if any
entry of the snapshot is not windowless-100% (or otherwise
deterministically full-capacity).

**Lossless translation (verified against the current capacity-consumption
contract):** the current scheduler contract consumes ROLE profile segments
as aggregate FTE percent (may exceed 100 for ROLE — the squad-planner
headcount convention) and NAMED_PERSON segments as per-person percent; a
plain null-window `defaultPercent 100` ROLE contributes exactly one FTE and
therefore reproduces `max(count, namedResources.length) × hoursPerDay × 5`
only when `namedResources.length = count − 1`. The lossless representation
uses the captured `count`: ROLE profile with null window at aggregate
percent `max(0, count − namedResources.length) × 100` plus NAMED_PERSON
profiles at 100%, null window — the scheduler then yields
`max(count, namedResources.length) × hoursPerDay × 5` in all four
cardinality cases (`n = 0`, `0 < n < c`, `n = c`, `n > c`). The full
four-case proof and the required acceptance matrix are in the investigation
document (Section 11.5 and Section 11.7).

The deterministic result is the **scheduler capacity** — the authoritative
capacity contract snapshot restoration must reproduce (and the acceptance
authority for the future implementation). One pre-existing contract caveat
is recorded for the implementation issue: `routes/resourceProfile.ts`
(current) count-scales per-slot percents for RT rows without named
resources (TIMELINE/FULL_PROJECT display branches); focused tests must cover
both consumers. The non-scheduler display path at `74b98d3` derived a
display window from the then-active CapacityPlan; that live derivation is
not stored in snapshots and is not a capacity input.

Outcome: the exact observed Class A predicate is **deterministic** — the 49
snapshots translate (ROLE null-window at `max(0, count − n) × 100`% + NAMED
_PERSON 100% null-window profiles) instead of quarantining.
No broadening: inherited mode (0 observed), percents ≠ 100, partial windows,
alias conflicts, below-`-1`/fractional values and structural defects stay
excluded and decision-required/defect.

### 12.3 Unchanged by this amendment

- The snapshot-level fail-closed rule (§3): a snapshot with any unresolved
  independent defect stays defect. The 18 defect snapshots and their 359
  windowless decisions remain blocking; the 130 live decisions remain
  unchanged and blocking.
- Class B, the `-1`+null exclusion, malformed/unsupported handling,
  retention and rollback fail-closed behaviour for everything outside the
two amended predicates.
- The derived-quarantine architecture (classification derived at read time,
  raw records preserved) for any class that remains quarantine-eligible.

### 12.4 Expected count change (design boundary)

Under the amended predicates: deterministic snapshot findings +581 (574
Class A + 7 S); quarantined entries 574 → 0; quarantined snapshots 49 → 0;
restorable snapshots 38 → 87; snapshot decisions 366 → 359; live decisions
130 (unchanged); unsupported 0; rewrite operations 0; plan exit 2;
readiness exit 1. See the investigation document Section 11.8 for the full
table and arithmetic.

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
- `5187338312` — successful sanitized snapshot evidence report (PR #436
  release `019db41b`); source for Section 12.
- `5187339153` — Issue #430 cross-link and final classification request.
