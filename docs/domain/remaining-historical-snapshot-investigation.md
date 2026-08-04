# Remaining Historical Snapshot Quarantine Blockers — Investigation (Issue #430)

Status: **investigation / design only** — no runtime, API, UI, schema or
migration change is authorized by this issue. This document reconciles the
authoritative quarantine boundary observed at the merged PR #429 release and
defines the smallest evidence-backed next step for the 366 snapshot decisions
that remain outside the approved quarantine policy.

Parent: #342 · Coordinates with: #404, #418, #421, #426, #428 ·
Depends on: merged PR #429 (`ffed1fa`, Issue #428)

## 1. Production observation summary

Source: Issue #404 comment `5172781179` (quarantine release dry-runs) and
Issue #430. At the merged PR #429 commit `ffed1fa` two read-only remediation
dry-runs produced identical plans (fingerprint `eccf77ed…`, baseline-state
hash `09b504b5…` — byte-identical covered state to the prior reviewed passes,
so the result is not production drift):

| Metric | Reviewed expectation | Observed |
|---|---|---|
| Quarantined snapshot-entry findings | 940 (933 Class A + 7 Class B) | **574 (Class A only; 0 Class B)** |
| Quarantined snapshots | 67 | **49** |
| Snapshot decisions remaining | 0 | **366** (359 windowless + 7 single-`-1`) |
| Defect-classified snapshots | 0 | **18** |
| Live-state decisions | 130 | **130 — exactly stable** |
| Unsupported findings | 0 | **0 — matches** |
| Rewrite-snapshot-entry operations | 0 | **0 — matches** |
| Plan exit code | 0 (after quarantine) | **2** (366 + 130 decisions unresolved) |

The observed 574 + 366 = 940: the old expectation counted the pass-2 per-entry
decision inventory (933 windowless + 7 single-`-1`), not the outcome of the
approved fail-closed snapshot-level classifier. The expectation was broader
than the approved predicate boundary; **574 is the authoritative quarantine
count** (see Sections 6–8).

## 2. Repository and Git-history evidence

### 2.1 The approved policy (Issue #426 / PR #427, doc `unrecoverable-historical-capacity-snapshots.md`)

- **Class A** — effective `CAPACITY_PLAN`, both effective window edges
  absent/null, no populated alias conflict, no other defect.
- **Class B** — effective `CAPACITY_PLAN`, exactly one effective edge `-1`,
  the other a **non-negative integer**, exactly one populated field `-1`, no
  alias conflict, no other defect.
- **Explicitly not quarantine** (design §3 list): one `-1` edge paired with
  **null**; one-null/one-valid windows; `(-1,-1)` (never-active, restorable);
  non-negative inverted windows (never-active, restorable); valid
  non-`CAPACITY_PLAN` entries; values below `-1`; fractional weeks; alias
  conflicts; invalid stale aliases; unknown modes; orphans; malformed
  payloads; structural-validation failures.
- **Snapshot-level fail-closed rule** (design §3): a snapshot is
  derived-quarantined only when it contains at least one approved entry and
  every other entry either translates successfully or matches an approved
  shape; any independent defect anywhere makes the whole snapshot a blocking
  defect. "A snapshot containing unrelated or unknown corruption must not
  become quarantined merely because it also contains Class A entries."

### 2.2 The merged implementation (Issue #428 / PR #429, commit `ffed1fa`)

- `server/src/lib/snapshotRestorability.ts` — one pure classifier
  (`classifySnapshotRestorability`, `classifyV2QuarantineShape`) whose
  predicates are the reviewed policy constant; per-entry rules come from the
  shared translator helpers in `server/src/lib/projectSnapshotCapacity.ts`
  (`v2ResourceTypeEntryErrors`, `v2NamedResourceEntryErrors`,
  `v2EffectiveNamedMode`, `v2PercentIsValid`, `isNeverActiveWindow`,
  `validateV2TranslatedProfiles`).
- All consumers share the verdict: listing (`routes/snapshots.ts`), rollback
  refusal (`projectSnapshotService.ts`), retention pruning
  (`snapshotUtils.ts`), readiness (`productionMigrationReadiness.ts`),
  remediation plan classification (`productionRemediationPlan.ts`), apply
  guard (`productionRemediationApply.ts`).
- Class B requires the other edge to be a non-negative integer
  (`classifyV2QuarantineShape`: `otherEdge == null || !isNonNegativeInteger(otherEdge)`
  → null); the `-1`+null shape is intentionally excluded and tested
  (`snapshotRestorability.test.ts`: "-1 paired with null (effective
  CAPACITY_PLAN)" → defect).
- Independent defects (per-entry errors, or structural validation of the
  complete translated set with quarantine-shaped windows sanitized) force the
  snapshot verdict to `defect`; the plan builder keeps the per-entry
  `classifySnapshotEntry` classifications for defect snapshots, so windowless
  `CAPACITY_PLAN` entries inside them stay `decisionRequired`.

### 2.3 Verification of the implementation against the design

No implementation defect was found. Every checked point matches the approved
design:

- Class A implements the exact approved predicate (both effective edges
  absent, alias fallback applied, `v2PercentIsValid` gate).
- Class B correctly requires the other edge to be a non-negative integer and
  rejects `-1`+null, double-`-1`, alias conflicts and negative/fractional
  populated values.
- Independent defects (entry-level or structural) prevent snapshot-level
  quarantine; mixed quarantine-and-defect snapshots are defects, never
  quarantined — including duplicate-owner structural failures
  (`snapshotRestorability.test.ts`: "duplicate resourceType ids fail
  structural validation (never quarantine)").
- Readiness, rollback, retention and remediation consume the same verdict.
- Quarantined entries receive no decision ID and no operation.
- Valid non-`CAPACITY_PLAN` entries remain valid/restorable; the 130
  live-state decisions are untouched by the snapshot changes (PR #429 diff
  does not touch the live-state sections).
- The observed 574/366 deviation is the classifier's own correct output at
  `ffed1fa`, not a code defect: production reported identical fingerprints
  and an unchanged baseline-state hash across two runs.

## 3. `-1` + null analysis (7 entries, 7 snapshots)

### 3.1 Exact observed shape

Seven effective `CAPACITY_PLAN` snapshot entries (all NamedResource) with one
effective window edge `-1` and the other effective edge null, in seven
snapshots (`cmqsz…`, project `cmol0t3gj…` per #404 comment `5172781179`).
Sanitized evidence does **not** establish which of the four captured fields
(`allocationStartWeek`, `allocationEndWeek`, `startWeek`, `endWeek`) holds the
`-1`, nor whether the other three are null.

### 3.2 Writer trace (Git history)

- The only server writer that ever emitted a `-1` window edge was the legacy
  Squad Planner apply path (`server/src/routes/squadPlan.ts`): from `74b98d3`
  (2026-05-05) until the profile-first rewrite removed it (`e7c461b`,
  2026-07-14; `c42f678` 2026-07-16), the apply loop wrote
  `slotWindows[idx] ?? { startWeek: -1, endWeek: -1, allocationPercent: 100 }`
  as a **single atomic UPDATE of both edges** of a NamedResource row.
- `deriveSlotWindowsByResourceType` →
  `materializeCapacityPlanResources` (`server/src/lib/capacityPlanMaterialisation.ts`)
  only produces non-negative integer windows from period data; it cannot
  emit `-1`.
- The planner-to-manual exit path (`server/src/lib/capacityPlanExit.ts`)
  nulls both edges; the optimiser writes `startWeek` only when `> 0`
  (`routes/optimiser.ts`); project clone copies rows verbatim
  (`routes/projects.ts`) and can propagate but not create the shape.
- The remaining writer is client-driven: the legacy named-resource PUT/PATCH
  routes (`routes/namedResources.ts`) accepted `startWeek`, `endWeek`,
  `allocationStartWeek`, `allocationEndWeek` from the request body with no
  range validation, and the Resource Profile UI
  (`client/src/components/resource-profile/NamedResourcesPanel.tsx`)
  allowed typing any number into the window fields (empty input → null).
  Typing `-1` into one field produced exactly one `-1` edge with the other
  null.

**Conclusion: the `-1`+null shape was never intentionally emitted by any
server writer.** It is a partial/unvalidated client-written state (or, in the
primary-pair variants, a stale client value). `(-1, -1)` remains the only
intentionally written sentinel pair.

### 3.3 Consumer trace — provable historical capacity

The legacy scheduler gate (`server/src/lib/scheduler.ts`, e.g. `d179cbe`):

```ts
const start = nr.startWeek ?? 0        // null = project start (week 0)
const end = nr.endWeek ?? Infinity     // null = project end
if (week >= start && week <= end) { /* allocationPercent of hpd*5 */ }
```

For effective `CAPACITY_PLAN` the allocation gate is the alias pair
`startWeek`/`endWeek` only (`effectiveAllocationPct` returns the percent
unconditionally for `CAPACITY_PLAN`); `allocationStartWeek`/`allocationEndWeek`
were not consulted by the legacy scheduler for this mode. The test
`scheduler.test.ts` ("slot never active → endWeek=-1 → does not contribute
capacity") codifies the gate. Weekly capacity is therefore provable per
orientation:

| Raw shape (all other fields null) | Legacy gate | Provable weekly capacity |
|---|---|---|
| `startWeek = -1`, `endWeek = null` | `week >= -1` always true, `end = ∞` | **unbounded** — identical to `null`/`null` |
| `startWeek = null`, `endWeek = -1` | `start = 0`, `week <= -1` never true | **zero** — identical to `(-1, -1)` |
| `allocationStartWeek = -1` (aliases null) | gate on `null`/`null` → `0..∞` | **unbounded** |
| `allocationEndWeek = -1` (aliases null) | gate on `null`/`null` → `0..∞` | **unbounded** |

`null` meant unbounded (`endWeek ?? Infinity`); `-1` never meant "unset" or
"unbounded" as an intentional single edge — the single-`-1` value is stray,
and the scheduler result came from the null fallback and the other edge.

**Conclusion: the class does not have one deterministic meaning without the
field orientation.** Three of the four possible orientations are provably
equivalent to the windowless Class A shape (unbounded via scheduler defaults,
no captured window stored); the fourth (`startWeek = null`, `endWeek = -1`)
is provably equivalent to the never-active `(-1, -1)` shape (zero capacity,
deterministic translation already exists). No orientation requires inventing
a window, but the sanitized evidence does not currently distinguish them.

### 3.4 Per the required conclusion options

- **Deterministic translation** — justified **only** for a proven
  `startWeek = null` + `endWeek = -1` (aliases null) shape: provable zero
  capacity, same scheduler semantics as `(-1, -1)`; the never-active policy
  would need the exact predicate extension `(null, -1)` with focused tests.
- **New exact quarantine class** — justified for the other orientations:
  provably identical semantics to Class A (no captured window; scheduler
  default, not a captured window). The amendment would extend Class A's exact
  predicate to "one effective edge `-1`, the other null, every populated
  field otherwise clean, no other defect".
- **Separately reviewed repair / decision-required** — the current state
  (decision-required, blocking) remains correct while orientation is unknown.

Do **not** infer the meaning from `(-1, -1)`: that pair is the planner's
intentional never-active sentinel; the single-`-1`+null shape has a different
writer origin and splits by orientation as shown.

## 4. Mixed-defect snapshot analysis (11 snapshots, 359 windowless entries)

### 4.1 Established facts

- 11 of the 18 defect-classified snapshots contain 359 decision-required
  entries whose message is the windowless `CAPACITY_PLAN` translation error
  ("cannot be translated without guessing capacity"). The other 7 defect
  snapshots are the single-`-1`+null class of Section 3 (7 entries; each of
  those snapshots has no windowless entries — otherwise they would count in
  the 359).
- The plan reports **0 unsupported findings**, so the independent defects in
  the 11 snapshots are **not** orphan NamedResources, unknown modes, or
  malformed/unknown-version payloads.
- The classifier's defect verdict for these snapshots is driven by per-entry
  errors and/or structural validation of the complete translated profile set
  (duplicate owners, percent ranges, enum failures) — the same fail-closed
  boundary the approved design mandates.

### 4.2 Candidate independent defect classes (exact classifier paths)

From `snapshotRestorability.ts` + `projectSnapshotCapacity.ts` +
`capacityProfileStructureValidation.ts`, the defect classes that produce no
`unsupported` finding and no additional decision are:

| Candidate class | Classifier path | Plan-level finding |
|---|---|---|
| Invalid percentages: non-finite `allocationPercent`/`allocationPct`; NAMED_PERSON percent outside `[0,100]`; negative ROLE percent | per-entry percent checks + structural `defaultPercent` rules | none distinct — percent is not consulted by `classifySnapshotEntry`, so the entry's decision (or none) is driven only by mode/windows |
| Conflicting populated aliases (primary vs alias of one edge disagree) | explicit alias-conflict check for TIMELINE/CAPACITY_PLAN | none distinct — effective edges resolve by `??` at plan level |
| Partial CAPACITY_PLAN windows (one edge populated, other null) | "CAPACITY_PLAN without a captured start/end window" error | decisionRequired with the **same message** as windowless — indistinguishable in the 359 without raw evidence |
| Values below `-1` / fractional weeks | per-entry window checks | negative → decisionRequired "single -1/negative window edge" (distinguishable from the 7 only by raw shape); fractional with one null edge → windowless message; fractional with both edges → alreadyValid (no decision) |
| Duplicate physical owners (duplicate RT/NR ids in the payload) | structural duplicate-owner check | none (no per-entry finding for the duplicates) |
| Window-exceed (`start > end`) | never-active normalization — not a defect | alreadyValid (normalized) |

The 282f9bd-era readiness inventory (comment `5155476979`) recorded "211 NR
entries with startWeek/endWeek = -1 (422 messages) + 415 synthetic-profile
shape errors"; after the #421 never-active policy, the `(-1,-1)`-derived shape
errors vanished, and the surviving structural errors in the 11 snapshots are
what remains. The exact surviving classes cannot be named from sanitized
GitHub evidence (Section 5).

### 4.3 Per the required conclusion options

- Whether each candidate is genuine corruption, a known legacy shape, a
  misclassified deterministic state, a new quarantine candidate, or a
  separately repairable defect **cannot be decided from the available
  sanitized evidence** — except:
  - **window-exceed / never-active** are already handled deterministically
    (not present as defects);
  - **orphans / unknown modes** are provably absent (unsupported = 0).
- The fail-closed principle is preserved: none of the 11 snapshots may
  quarantine while their independent defect is unidentified, and no Class A
  entry inside them may quarantine (the approved snapshot-level rule).

## 5. Evidence gaps

The following are **not** established by any sanitized evidence on GitHub and
cannot be derived from repository history:

1. For the 7 single-`-1`+null entries: which of the four captured window
   fields holds `-1`, and whether the other three are null (decisive for
   deterministic-zero vs Class-A-equivalent quarantine).
2. For the 11 defect-classified snapshots: the distinct independent-defect
   reasons with counts (decisive for the outcome of the 359 entries).
3. Whether the 359 include partial-window entries (one-null/one-valid) or are
   purely both-null — the plan message cannot distinguish them.

### 5.1 Smallest safe read-only evidence request (for the #404 production agent)

All items are read-only aggregates of the **existing** plan and readiness
outputs already on the production machine (`plan-1.json`/`plan-2.json` at
`ffed1fa`, readiness log `a1b4237b…`). No new database access, no payload
copy, no identifiers required.

1. For the 7 decisions with message "single -1/negative window edge without
   established meaning": a shape-category table — per entry, which of
   `allocationStartWeek` / `allocationEndWeek` / `startWeek` / `endWeek`
   equals `-1` and whether the other three captured fields are null
   (categories only: e.g. `startWeek=-1, others null`), plus entry kind and
   effective mode (all expected `namedResource`, `CAPACITY_PLAN`).
2. For the 18 defect-classified snapshots: counts of snapshot-entry findings
   by message (sanitized to reason categories), per snapshot — specifically
   the distinct non-"without captured window" messages (percent-range,
   alias-conflict, partial-window, below-`-1`, fractional, duplicate-owner,
   structural) and their counts.
3. Per-snapshot classification counts for the 11 mixed snapshots:
   `decisionRequired` by message (windowless vs partial vs single-negative),
   `alreadyValid`, `unsupported`, `quarantined` (expected 0/0/0/0).

Nothing in the request asks for complete plan JSON, snapshot payloads,
customer/project names, decision IDs, credentials or database copies.

## 6. Outcome table (one row per remaining defect class)

| Class | Observed count | Proven historical semantics | Recommended outcome | Evidence |
| ----- | -------------: | --------------------------- | ------------------- | -------- |
| Class A windowless entries in fully-clean snapshots | 574 entries / 49 snapshots | no captured window; unrecoverable without guessing | **Quarantine (unchanged — authoritative)** | #404 `5172781179`; classifier at `ffed1fa` |
| Windowless `CAPACITY_PLAN` entries inside 11 mixed-defect snapshots | 359 entries / 11 snapshots | same raw shape as Class A; snapshot carries ≥1 unidentified independent defect | **Decision-required (unchanged)** until defect classes are identified (Section 5.1 item 2) | #404 `5172781179`; fail-closed snapshot rule |
| `-1` + null (effective `CAPACITY_PLAN`) | 7 entries / 7 snapshots | orientation-dependent provable: `startWeek=null, endWeek=-1` → zero (≡ never-active); all other orientations → unbounded (≡ windowless Class A) | **Decision-required (unchanged)** until orientation evidence (Section 5.1 item 1); then deterministic (zero) or Class A-extension quarantine (unbounded) | scheduler gate (`d179cbe`), planner writer trace (§3.2–3.3) |
| `(-1,-1)` / non-negative inverted never-active | 205 normalized, not findings | zero capacity | Deterministic (unchanged) | #421 policy; `scheduler.test.ts` |
| Single `-1` + non-negative other edge (Class B) | 0 | — | n/a (no production match) | #404 `5172781179` |
| Valid non-`CAPACITY_PLAN` entries | not findings | restorable per existing translation | Restorable (unchanged) | classifier tests |
| Live-state decisions (104 + 13 + 13) | 130 | out of snapshot scope | Unchanged, blocked | #404 `5172781179` (stable) |
| Unsupported findings | 0 | — | — | #404 `5172781179` |

## 7. Recommended policy

**Path A — no policy change now**, with a precise evidence request (Section
5.1) and a documented count reconciliation (Section 8).

- The current implementation is faithful to the approved design (Section
  2.3); no classifier correction is justified (**Path C not applicable**).
- No repository evidence yet proves a new exact quarantine class or a
  deterministic extension: the `-1`+null class splits by field orientation
  into two provable meanings, neither of which needs a *new* semantic —
  zero (never-active deterministic, predicate extension `(null, -1)`) or
  unbounded (Class A-equivalent, exact predicate extension). The orientation
  is the missing fact (**Path B deferred until Section 5.1 item 1 is
  returned**).
- A separate evidence-bound repair (**Path D**) is not applicable: no stored
  or reviewed evidence determines historical intent for any of the 366 (the
  #404 evidence review proposed zero resolutions, comment `5162109939`).
- The 11 snapshots' independent defects must be identified before any
  per-class outcome (Section 4.3); quarantine must not be broadened to absorb
  them (fail-closed).

### 7.1 Post-evidence forks (design boundary only, not implemented here)

If Section 5.1 item 1 returns `startWeek=null, endWeek=-1` (all else null) for
some entries: those entries are deterministic never-active (zero capacity) —
extend the never-active predicate with the exact raw shape and focused tests;
they leave the decision set.

For every other orientation: the entry is provably unbounded — the semantic
equivalent of windowless Class A (no captured window; the scheduler's default,
not a captured window). Extend Class A's exact predicate to "one effective
edge `-1`, other null, all populated fields otherwise clean, effective
`CAPACITY_PLAN`, no other defect" with focused tests; these entries quarantine
with the Class A reason and receive no decision.

If Section 5.1 item 2 identifies, for example, partial-window entries
(one-null/one-valid): the same orientation analysis applies —
`(start=null, end=N)` in the alias pair is a provable window `[0, N]`
(deterministic), while `(start=0, end=null)` and primary-pair partials are
provably unbounded (Class A-equivalent). Each identified class receives its
own exact predicate; nothing is absorbed by structural similarity.

## 8. Authoritative expected production counts (Path A)

Under the current implementation at `ffed1fa` (unchanged by this issue):

| Metric | Value |
| ------ | ----- |
| Quarantined entries | **574** (all Class A) |
| Quarantined snapshots | **49** |
| Defect-classified snapshots (blocking readiness) | **18** (11 mixed + 7 single-`-1`) |
| Snapshot decisions remaining | **366** (359 windowless-in-defect + 7 single-`-1`) |
| Live decisions remaining | **130** |
| Unsupported findings | **0** |
| Rewrite-snapshot-entry operations | **0** |
| Deterministic operations | 2,011 (unchanged) |
| Dry-run exit code | **2** (unresolved decisions) |
| Readiness exit before live decisions resolve | **1** (18 defect snapshots + live-state blockers) |

The 940 figure is superseded: it was the pass-2 per-entry decision inventory,
not a quarantine outcome. `940 = 574 quarantined + 366 remaining` under the
approved fail-closed snapshot-level rule.

## 9. Implementation boundary

None authorized by this issue. If the evidence returned by Section 5.1
establishes a deterministic extension or a Class A predicate extension, that
is a **separate focused design amendment** (an updated `#426` policy section)
followed by a separate implementation issue mirroring the #426 → #428 flow —
not part of this investigation. #404 and #418 PR 2 remain blocked.

## 10. Simplicity Check

- **What is the minimum correct next step?** Post the Section 5.1 evidence
  request to #404, record the authoritative 574/366 boundary, and change no
  code. No runtime change is authorized or required.
- **Is a code change actually required?** No. The implementation matches the
  approved design; the deviation is an expectation-count error, not a code
  defect.
- **Which exact new abstraction or predicate, if any, is essential?** None
  now. At most two future exact predicate extensions (never-active
  `(null, -1)`; Class A "one `-1` + null") — each only if orientation
  evidence proves the corresponding historical semantics.
- **Can the issue be resolved by correcting expected counts instead?** Yes —
  that is exactly the recommendation (Section 8): 574/366/49/18 are
  authoritative under the approved policy.
- **Is any proposed complexity present only to avoid human decisions?** No.
  The 366 stay decision-required until provable semantics exist; quarantine
  is never broadened by similarity.
- **Does the recommendation preserve one shared classifier and fail-closed
  behavior?** Yes. One classifier remains the single source of the verdict;
  mixed-defect snapshots remain defects; unsupported stays zero; nothing is
  absorbed into quarantine without an exact proven predicate.

## Cross-links

- `unrecoverable-historical-capacity-snapshots.md` — approved quarantine
  policy (#426); Section 11 carries the implementation record and the
  authoritative-count note.
- `capacity-profile-readiness-remediation.md` — #421 deterministic matrix,
  `-1` sentinel evidence, manifest flow.
- `legacy-capacity-column-runtime-cutover.md` — #418 runtime cutover.
