# Remaining Historical Snapshot Quarantine Blockers — Investigation (Issue #430)

Status: **investigation / design only** — no runtime, API, UI, schema or
migration change is authorized by this issue. This document records the
quarantine boundary observed at the merged PR #429 release, assesses its
deterministic-semantics implications, and defines the smallest
evidence-backed next step for the 366 snapshot decisions that remain outside
the approved quarantine policy.

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
than the approved predicate boundary. **574 is the current classifier's
quarantine count — the correct expected result for the merged implementation
at `ffed1fa`** — and it is not yet final as a policy boundary: Section 3.5
assesses whether the legacy scheduler proves a deterministic unbounded
interval-and-percentage outcome for current NamedResource Class A entries,
which would narrow the quarantine class.

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

The legacy scheduler examined **only the NamedResource's own `allocationMode`**
(`effectiveAllocationPct`), never the parent ResourceType mode — so the V2
"effective mode" (`namedResource.allocationMode ??
parentResourceType.allocationMode ?? null`, current `v2EffectiveNamedMode`) is
a translator interpretation that must not be read back into the historical
percentage contract:

- `nr.allocationMode === 'CAPACITY_PLAN'` (explicit) → the captured
  `nr.allocationPercent`, used directly in the capacity arithmetic — a null
  percent contributes zero (`null / 100` × hours), there is no fallback to
  `100`;
- `nr.allocationMode === null` (inherited category) or any other mode → the
  default EFFORT branch → `100`.

The explicit `CAPACITY_PLAN` percentage branch was introduced in `74b98d3`
(2026-05-05); at the snapshot-era start (`f783b26`, 2026-05-01) explicit
`CAPACITY_PLAN` also fell to the default `100`. The outer gate below is
unchanged across the whole era.

The outer capacity gate (`getWeeklyCapacity`) is the alias pair
`startWeek`/`endWeek` only: `allocationStartWeek`/`allocationEndWeek` were not
consulted by the legacy scheduler for this mode. The test
`scheduler.test.ts` ("slot never active → endWeek=-1 → does not contribute
capacity") codifies the gate. The active interval is therefore provable per
orientation:

| Raw shape (all other fields null) | Legacy gate | Provable active interval |
|---|---|---|
| `startWeek = -1`, `endWeek = null` | `week >= -1` always true, `end = ∞` | **unbounded** — identical to `null`/`null` |
| `startWeek = null`, `endWeek = -1` | `start = 0`, `week <= -1` never true | **zero** — identical to `(-1, -1)` |
| `allocationStartWeek = -1` (aliases null) | gate on `null`/`null` → `0..∞` | **unbounded** |
| `allocationEndWeek = -1` (aliases null) | gate on `null`/`null` → `0..∞` | **unbounded** |

`null` meant unbounded (`endWeek ?? Infinity`); `-1` never meant "unset" or
"unbounded" as an intentional single edge — the single-`-1` value is stray,
and the scheduler result came from the null fallback and the other edge.

**Conclusion: the active interval does not have one deterministic meaning
without the field orientation.** Three of the four possible orientations are
provably **unbounded** (the scheduler gate defaulted to `0..∞` and the `-1`
value was stray); the fourth (`startWeek = null`, `endWeek = -1`) is provably
**zero** (never-active, identical to `(-1, -1)`). No orientation requires
inventing a window. The exact weekly capacity, however, is interval ×
percentage: the percentage is determined by the explicit-versus-inherited
mode category (Section 3.4), so **orientation alone does not prove complete
weekly capacity**. The sanitized evidence does not currently distinguish the
orientations (or the mode category), so the per-entry outcome is not yet
assignable.

### 3.4 Per the required conclusion options

All seven entries remain **decision-required** until sanitized evidence
identifies their exact raw-field orientation, alias state, raw
`allocationMode`, parent `allocationMode` (explicit-versus-inherited
category) and percentage fields (Section 5.1 item 1). Once those are
established, each exact shape is evaluated as a **deterministic translation
candidate** — never as a quarantine candidate, because the historical
capacity outcome is provable and therefore reproducible without guessing.

**Proven zero-capacity orientation.** For the exact raw shape
`startWeek = null` and `endWeek = -1` (all other window fields null, effective
`CAPACITY_PLAN`), the historical outer scheduler gate never admitted an
active week (`start = 0`, `end = -1`), so the entry contributed zero capacity
**regardless of percentage** — identical to the proven never-active
`(-1, -1)` semantics. This is a deterministic zero-capacity candidate,
subject to:

- exact alias constraints (every other captured window field null);
- effective allocation mode exactly `CAPACITY_PLAN`;
- valid ownership;
- no independent defect;
- focused future implementation tests.

It is **not** a quarantine candidate.

**Proven unbounded orientations.** For the exact raw shapes
`startWeek = -1` + `endWeek = null`, or only `allocationStartWeek = -1`, or
only `allocationEndWeek = -1` (with the scheduler-consumed `startWeek` /
`endWeek` aliases null), the outer gate provably defaulted to `0..∞`, so the
active interval is unbounded. The deterministic weekly capacity must combine
that interval with the **historically used percentage**, which splits by
mode category:

- **explicit** `namedResource.allocationMode = CAPACITY_PLAN` → unbounded
  interval at `nr.allocationPercent` (from `74b98d3` 2026-05-05; a null
  percent contributes zero; before `74b98d3` the default `100` applied);
- **inherited** effective `CAPACITY_PLAN`
  (`namedResource.allocationMode = null`, parent `CAPACITY_PLAN`) →
  unbounded interval at the scheduler's null-mode default of **100%** — the
  captured `allocationPercent` was not used for this category.

The two categories must not be combined into one deterministic mapping.

They are **not**:

- Class A quarantine extensions;
- "unrecoverable";
- non-restorable merely because a conventional window pair is absent.

The historical capacity semantics (interval × percentage) are deterministic;
the smallest future design task is selecting the **existing valid profile
representation** that reproduces both the active interval and the
historically used percentage — explicit and inherited modes may require
different target profiles or profile values. A structurally valid null-window
`AVAILABILITY_WINDOW` representation already exists and is used for
windowless `TIMELINE` entries; whether it (or another existing
representation) is the correct target for `CAPACITY_PLAN`/`LEGACY` entries
is an unresolved design question (Section 3.5). Inventing a finite window is
neither required nor allowed. A deterministic interval without the correct
percentage is not a complete translation.

Do **not** infer the meaning from `(-1, -1)`: that pair is the planner's
intentional never-active sentinel; the single-`-1`+null shape has a different
writer origin and splits by orientation as shown.

### 3.5 Assessment — current NamedResource Class A policy

The scheduler reasoning above is not limited to the seven `-1`+null entries.
The current approved policy quarantines every windowless effective
`CAPACITY_PLAN` entry (Class A) because the translator requires a captured
start and end window. For historical NamedResource entries, however, the
legacy scheduler used `startWeek ?? 0` / `endWeek ?? Infinity` as the outer
capacity gate (stable across the whole snapshot window: `f783b26`
2026-05-01 → `b194e6c` 2026-07-14) and applied **no inner allocation-window
gate** for `CAPACITY_PLAN`. A NamedResource entry with all four window fields
null therefore provably produced an **unbounded active interval**. The
percentage is category-dependent and the assessment must separate the two
categories:

- **explicit** `namedResource.allocationMode = CAPACITY_PLAN`: the scheduler
  used the captured `allocationPercent` (from `74b98d3` 2026-05-05 onward; a
  null percent contributed zero; before `74b98d3` the default `100`
  applied);
- **inherited** effective `CAPACITY_PLAN`
  (`namedResource.allocationMode = null`, parent `CAPACITY_PLAN`): the
  scheduler examined the NamedResource's own null mode and fell to the
  default EFFORT branch — **100%**, not the captured `allocationPercent`.

For each category the assessment must ask:

- which percentage the historical scheduler used (explicit: the captured
  `allocationPercent`; inherited: the `100` default);
- which raw percentage fields were present in the snapshot payload
  (`allocationPercent` vs `allocationPct`);
- whether the scheduler behaviour was stable across the applicable writer
  era (the explicit-mode percentage branch appeared on 2026-05-05 in
  `74b98d3`; before that every mode fell to the `100` default);
- whether a current valid authoritative profile representation can reproduce
  both interval and percentage;
- whether effective-mode inheritance occurred at snapshot time (the payload
  captured the raw NamedResource `allocationMode` and the raw parent mode
  verbatim) or is only a current translator interpretation
  (`v2EffectiveNamedMode`).

It is **not** claimed that all windowless effective-`CAPACITY_PLAN`
NamedResources historically used `allocationPercent`.

The three questions are separated deliberately:

1. **Is the historical scheduler outcome provable?** The active interval is
   provable for NamedResource entries under the legacy scheduler contract
   cited above. The percentage is provable per category: explicit
   `CAPACITY_PLAN` used `allocationPercent` from `74b98d3` (2026-05-05)
   onward (the first four days of the snapshot window used the default `100`
   for every non-FULL_PROJECT/TIMELINE mode); inherited/null mode used `100`
   throughout. This is a proven scheduler outcome, not an inference about
   intent.
2. **Is the correct authoritative profile representation already proven?**
   No. The #421 deterministic matrix and the approved #426 policy treat
   windowless `CAPACITY_PLAN` as untranslatable-without-guessing and the
   merged classifier quarantines it; no reviewed mapping reproduces a proven
   unbounded historical outcome (interval **and** percentage) as an
   authoritative profile for `CAPACITY_PLAN`/`LEGACY` entries. A structurally
   valid null-window `AVAILABILITY_WINDOW` profile exists (used for
   windowless `TIMELINE`), but whether that (or another existing
   representation) is the correct target is an unresolved design question
   that belongs in a focused future amendment.
3. **Does the existing Class A quarantine policy therefore remain valid,
   require narrowing, or require a focused design amendment?** Under
   assessment. The merged policy is not silently invalidated: it remains in
   force and its outcome (574 quarantined) remains the correct expectation
   for the current implementation. Whether some or all current NamedResource
   Class A entries should instead be deterministic unbounded translations
   cannot be concluded from sanitized evidence alone, because the proof must
   hold for:

   - ResourceType **and** NamedResource entries **separately** — the legacy
     `getWeeklyCapacity` gate consulted only NamedResource rows and phantom
     slots (`max(0, count - namedResources.length)` full-time); the
     ResourceType's own allocation fields were not the capacity source in
     that function, so no unbounded conclusion transfers to RT entries from
     this gate;
   - explicit vs inherited NamedResource `CAPACITY_PLAN` (the scheduler read
     only the NamedResource's own `allocationMode`);
   - every applicable writer era (legacy planner column writes, client
     PUT/PATCH, clone propagation, and the post-#359 profile-first era in
     which the legacy columns became a compatibility projection);
   - percentage semantics (`allocationPercent` vs `allocationPct`, the
     scheduler's per-mode percentage branches);
   - primary and fallback aliases (which pair the scheduler consumed);
   - effective-mode inheritance (`v2EffectiveNamedMode`) — whether it
     reflects snapshot-time state or translator interpretation;
   - all structurally valid neighbouring shapes (a translated profile set
     must validate as a complete set).

   The sanitized evidence cannot currently split the 574 Class A entries into
   ResourceType vs NamedResource counts, nor by explicit/inherited category,
   nor by writer era (Section 5.1 item 4). Until that split exists, **the
   investigation does not claim that 574 is the final authoritative policy
   boundary**; it is the current implementation outcome.

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
   fields holds `-1`; whether the other three are null, populated or
   conflicting; the raw NamedResource `allocationMode`; the parent
   ResourceType `allocationMode` (explicit-versus-inherited category); and
   the sanitized percentage fields (decisive for assigning
   deterministic-zero vs deterministic-unbounded interval semantics and the
   historically used percentage).
2. For the 11 defect-classified snapshots: the distinct independent-defect
   reasons with counts (decisive for the outcome of the 359 entries).
3. Whether the 359 include partial-window entries (one-null/one-valid) or are
   purely both-null — the plan message cannot distinguish them.
4. For the current Class A assessment (Section 3.5): the ResourceType vs
   NamedResource split of the 574 quarantined entries and 49 quarantined
   snapshots, further split by explicit vs inherited NamedResource
   `CAPACITY_PLAN` and raw null/other mode categories, with writer-era
   grouping where derivable from existing snapshot metadata (no payloads) —
   required before 574 can be called final.

### 5.1 Smallest safe read-only evidence request (for the #404 production agent)

All items are read-only aggregates of the **existing** plan and readiness
outputs already on the production machine (`plan-1.json`/`plan-2.json` at
`ffed1fa`, readiness log `a1b4237b…`), supporting the deterministic
interval-and-percentage analysis (Sections 3.4–3.5) and the mixed-defect
assessment (Section 4). No new database access, no payload copy, no
identifiers required.

1. For the 7 decisions with message "single -1/negative window edge without
   established meaning": a shape-category table — per entry, which of
   `allocationStartWeek` / `allocationEndWeek` / `startWeek` / `endWeek`
   equals `-1`; whether the other captured window fields are null, populated
   or conflicting; the raw NamedResource `allocationMode` and the parent
   ResourceType `allocationMode` (explicit vs inherited category); the
   sanitized percentage category (`allocationPercent` absent/null, finite
   value with an aggregate bucket, or exact value only if non-sensitive;
   `allocationPct` absent/null or finite); and entry kind.
2. For the 18 defect-classified snapshots: counts of snapshot-entry findings
   by message (sanitized to reason categories), per snapshot — specifically
   the distinct non-"without captured window" messages (percent-range,
   alias-conflict, partial-window, below-`-1`, fractional, duplicate-owner,
   structural) and their counts.
3. Per-snapshot classification counts for the 11 mixed snapshots:
   `decisionRequired` by message (windowless vs partial vs single-negative),
   `alreadyValid`, `unsupported`, `quarantined` (expected 0/0/0/0).
4. For the current Class A assessment: aggregate counts of the 574
   quarantined entries and 49 quarantined snapshots split by ResourceType vs
   NamedResource; explicit NamedResource `CAPACITY_PLAN`; inherited
   NamedResource `CAPACITY_PLAN`; NamedResource raw null/other mode
   categories; percentage-field presence category; and writer-era grouping
   where derivable from existing snapshot metadata (the plan already carries
   `ownerKind` per snapshot-entry finding).

Nothing in the request asks for complete plan JSON, snapshot payloads,
customer/project names, decision IDs, credentials or database copies.

## 6. Outcome table (one row per remaining defect class; current implementation outcome)

| Class | Observed count | Proven historical semantics | Recommended outcome | Evidence |
| ----- | -------------: | --------------------------- | ------------------- | -------- |
| Class A windowless entries in fully-clean snapshots | 574 entries / 49 snapshots | no captured window; for NamedResource entries the legacy scheduler gate proves an unbounded active interval, with percentage per explicit/inherited mode (§3.5); RT semantics are not established by that gate | **Quarantine (current implementation outcome — unchanged); NamedResource subset under assessment (§3.5)** | #404 `5172781179`; classifier at `ffed1fa`; scheduler gate `f783b26`→`b194e6c` (percentage branch `74b98d3`) |
| Windowless `CAPACITY_PLAN` entries inside 11 mixed-defect snapshots | 359 entries / 11 snapshots | same raw shape as Class A; snapshot carries ≥1 unidentified independent defect | **Decision-required (unchanged)** until defect classes are identified (Section 5.1 item 2) | #404 `5172781179`; fail-closed snapshot rule |
| `-1` + null (effective `CAPACITY_PLAN`) | 7 entries / 7 snapshots | orientation-dependent provable: `startWeek=null, endWeek=-1` → zero interval (≡ never-active); all other orientations → unbounded interval at the category-specific percentage (explicit `allocationPercent` or inherited `100` default) | **Decision-required (unchanged)** until orientation, alias and mode-source evidence exists (Section 5.1 item 1); zero orientation is deterministic zero; unbounded orientation is deterministic only when the historically used percentage is also established; explicit and inherited modes may require different deterministic target profiles — never quarantine | scheduler gate (`f783b26`→`b194e6c`; percentage branch `74b98d3`), planner writer trace (§3.2–3.3) |
| `(-1,-1)` / non-negative inverted never-active | 205 normalized, not findings | zero capacity | Deterministic (unchanged) | #421 policy; `scheduler.test.ts` |
| Single `-1` + non-negative other edge (Class B) | 0 | — | n/a (no production match) | #404 `5172781179` |
| Valid non-`CAPACITY_PLAN` entries | not findings | restorable per existing translation | Restorable (unchanged) | classifier tests |
| Live-state decisions (104 + 13 + 13) | 130 | out of snapshot scope | Unchanged, blocked | #404 `5172781179` (stable) |
| Unsupported findings | 0 | — | — | #404 `5172781179` |

## 7. Recommended policy

**Path A — no runtime or policy change yet; obtain the minimal sanitized
evidence and complete the deterministic interval-and-percentage assessment.**

- The current implementation follows the currently approved policy (Section
  2.3); no classifier correction is justified (**Path C not applicable**).
- The old expectation that all 940 would immediately quarantine was
  incorrect; 574/366 is the observed outcome of the current classifier.
- The seven `-1`+null entries remain blocked until their orientation, alias
  state and mode-source category are known; each proven orientation then
  belongs to deterministic translation analysis (zero or unbounded), not
  quarantine. No Class A extension for `-1`+null is proposed and no new
  quarantine class is created by this PR.
- Proven zero and proven unbounded historical outcomes are deterministic
  states — potentially restorable — not unrecoverable quarantine candidates.
- A complete deterministic translation must reproduce both the active
  interval and the historically used percentage; explicit and inherited
  NamedResource `CAPACITY_PLAN` used different historical percentages and
  may require different target profiles or profile values (Section 3.4).
- The effect on current NamedResource Class A entries (Section 3.5) must be
  resolved before 574 is called the final policy count.
- Mixed-defect snapshots remain fail-closed (Section 4.3).
- A separate evidence-bound repair (**Path D**) is not applicable: no stored
  or reviewed evidence determines historical *intent* for any of the 366 —
  the #404 evidence review proposed zero resolutions (comment `5162109939`);
  the deterministic question here is about proven scheduler *outcomes*, not
  intent.
- The 11 snapshots' independent defects must be identified before any
  per-class outcome (Section 4.3); quarantine must not be broadened to absorb
  them (fail-closed).
- #404 and #418 remain blocked.

### 7.1 Post-evidence forks (design boundary only, not implemented here)

If Section 5.1 item 1 returns `startWeek=null, endWeek=-1` (all other window
fields null) for some entries: those entries are deterministic zero-capacity
candidates (never-active-equivalent) — the active interval is zero
regardless of percentage. A future focused amendment would define the exact
raw predicate, alias constraints, effective-mode rules and category checks
and add focused implementation tests; the entries then leave the decision
set without a human decision. They are not quarantine candidates.

If item 1 returns any other orientation (`startWeek=-1` + `endWeek=null`, or
a single `-1` in the primary pair with null aliases): the entry has a
deterministic unbounded active interval. The deterministic mapping must also
reproduce the historically used percentage, which splits by mode category:

- explicit `namedResource.allocationMode = CAPACITY_PLAN` → the captured
  `allocationPercent` (from `74b98d3` 2026-05-05; a null percent contributes
  zero; before `74b98d3` the default `100` applied);
- inherited effective `CAPACITY_PLAN` (null own mode, parent `CAPACITY_PLAN`)
  → the scheduler's `100%` null-mode default.

A future focused amendment would select the **existing valid profile
representation** that reproduces both the interval and the category-specific
percentage (a null-window `AVAILABILITY_WINDOW` representation already exists
and is used for windowless `TIMELINE`); explicit and inherited modes may
require different target profiles or profile values. Inventing a finite
window is neither required nor allowed. The profile-representation choice is
the smallest open design task — the historical capacity semantics (interval
and percentage) are already deterministic per category. These entries are
not quarantine candidates.

If Section 5.1 item 2 identifies partial-window entries (one-null/one-valid):
the same orientation analysis applies — `(start=null, end=N)` in the alias
pair is a provable window `[0, N]` (deterministic), while `(start=0,
end=null)` and primary-pair partials are provably unbounded. Each identified
class receives its own exact predicate; nothing is absorbed by structural
similarity, and none of these outcomes is quarantine.

The Section 3.5 assessment may additionally conclude that some or all current
NamedResource Class A entries are deterministic unbounded translations; that
conclusion, if reached, requires the same focused design-amendment +
implementation flow — it does not change any runtime behaviour through this
PR.

## 8. Current implementation outcome (observed production result at `ffed1fa`)

Under the merged implementation at `ffed1fa` (unchanged by this issue and by
this PR):

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
approved fail-closed snapshot-level rule. These figures are the **current
policy/classifier boundary**: they are the correct expected result for the
currently merged classifier, and they remain subject to the Section 3.5
interval-and-percentage assessment before any later focused policy amendment
is considered.

## 9. Implementation boundary

None authorized by this issue. If the evidence returned by Section 5.1
establishes a deterministic zero or deterministic unbounded
interval-and-percentage candidate (or the Section 3.5 assessment narrows
Class A), that is a **separate focused design amendment** (an updated `#426`
policy section) followed by a separate implementation issue mirroring the
#426 → #428 flow — not part of this investigation. No quarantine extension
is proposed. #404 and #418 PR 2 remain blocked.

## 10. Simplicity Check

- **What is the minimum correct next step?** Post the Section 5.1 evidence
  request to #404, record the observed 574/366 boundary as the current
  implementation outcome, complete the Section 3.5
  interval-and-percentage assessment, and change no code. No runtime change
  is authorized or required.
- **Is a code change actually required?** No. The implementation matches the
  approved design; the deviation is an expectation-count error, not a code
  defect.
- **Which exact new abstraction or predicate, if any, is essential?** None
  now. At most two future deterministic translation candidates
  (`(null, -1)` zero-capacity; unbounded orientations at the
  category-specific historical percentage) — each only if orientation and
  mode-source evidence proves the corresponding historical interval and
  percentage; both require a focused design amendment, and neither is a
  quarantine class.
- **Can the issue be resolved by correcting expected counts instead?** Only
  partially. The observed counts are the correct expected result for the
  current implementation (the 940 expectation was wrong), but Issue #430 is
  not resolved by counts alone: the Section 3.5 assessment must determine
  whether the NamedResource Class A boundary narrows.
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
  observed-outcome note.
- `capacity-profile-readiness-remediation.md` — #421 deterministic matrix,
  `-1` sentinel evidence, manifest flow.
- `legacy-capacity-column-runtime-cutover.md` — #418 runtime cutover.
