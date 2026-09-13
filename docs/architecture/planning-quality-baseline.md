# Planning-quality benchmark baseline

Issue #479 establishes a deterministic evidence baseline before changing planner semantics. The committed tests use the existing pure `runScheduler`, `runSAPlanner`, and `computeCapacityPlan` paths; production planner code is unchanged.

## Deterministic synthetic benchmark

The large benchmark is generated independently from any customer or
programme-led import. Its committed shape is fixed by index-based rules:

- 14 synthetic epics, each containing 15 features and one story per feature;
- three generic technical roles with counts of 3 Platform Engineers, 5 Data
  Engineers and 2 Cloud Engineers;
- varied role effort, alternating parallel/sequential epic modes, branch and
  chain feature dependencies, and three explicit epic dependency edges; and
- an explicit Data Engineer availability window used only by the constrained
  failure path.

The fixture retains no customer names, descriptions, story text, identifiers,
source metadata or imported measurements. The expected scale and constraint
values are exported by
`server/src/test/planningBenchmarkFixtures.ts`; effort totals are calculated
from the generated task graph.

## Measurement and invariants

`server/src/lib/planning-benchmark.ts` measures scheduler outputs for target and achieved duration, expected and actual scheduled effort hours/person-days by role, staffed capacity hours and FTE-weeks, peak staffing by role and total, utilisation, capacity/dependency violations, demand/ramp shape, and deterministic fingerprints. `runCapacityPlanSchedule()` mirrors the deterministic `runSAPlanner` configuration used by `computeCapacityPlan` and feeds its actual output to `measureCapacityPlanQuality()`; capacity-plan dependency checks derive each worked feature's first and final allocation week, while effort totals come from the planner's actual weekly demand output. It records only available failure evidence when planning throws.

Total scheduler peak staffing is the maximum **combined weekly demand across all roles**. `peakStaffingFteByRole` remains the independent per-role peak. The overlap regression uses Developer 1.0 FTE plus QA 0.5 FTE in the same week, yielding total peak 1.5 FTE rather than the maximum individual role peak.

Every claimed-feasible scheduler scenario asserts effort conservation, dependency correctness, capacity compliance and repeatability. Capacity-plan controls assert deterministic output, expected-versus-scheduled effort conservation by role, predecessor-completion dependency correctness, staffed capacity, peak staffing, utilisation, ramp shape and applicable capacity invariants. Failure cases retain target, expected effort and the concrete planner error while leaving unavailable schedule metrics empty.

## Scheduler baseline metrics

Values below are from the current deterministic scheduler at each fixture's default capacity. FTE-weeks measure committed capacity in the requested planning window.

| Scenario | Target / achieved weeks | Effort by role (person-days) | Staffed FTE-weeks | Peak role / total FTE | Utilisation by role |
|---|---:|---|---|---|---|
| Serial critical path | 4 / 4 | Developer 10 | Developer 4 | Developer 0.50 / 0.50 | Developer 50% |
| Parallel same-role | 4 / 4 | Developer 20 | Developer 4 | Developer 1.00 / 1.00 | Developer 100% |
| Role hand-off | 2 / 2 | Developer 5; QA 5 | Developer 2; QA 2 | Developer 1.00; QA 1.00 / 1.00 | 50%; 50% |
| Sparse specialist | 4 / 4 | Developer 20; Specialist 1 | Developer 4; Specialist 4 | Developer 1.00; Specialist 0.05 / 1.00 | 100%; 5% |
| Manual capacity/schedule lock | 6 / 6 | Developer 15 | Developer 6 | Developer 1.00 / 1.00 | Developer 50% |
| Mixed sequential/parallel | 6 / 6 | Developer 25; QA 10 | Developer 6; QA 6 | Developer 1.00; QA 1.00 / 1.50 | 83.33%; 33.33% |

The serial fixture remains four weeks with one or four Developers because each task has a ten-day elapsed-duration floor. The parallel fixture reduces delivery from four to two weeks when Developer capacity doubles without changing conserved effort. The sparse specialist remains fractional rather than inflating to full-time demand.

## Capacity-planner baseline metrics

| Scenario | Target / achieved weeks | Effort | Staffed capacity | Peak role / total FTE | Utilisation | Capacity / dependency violations |
|---|---:|---|---|---|---|---|
| Explicit Developer maximum | 2 / 4 | Developer 160 hours / 20 days | 160 hours / 4 FTE-weeks | Developer 1 / 1 | 100% | 0 / 0; explicit max 1 is the blocker |
| Synthetic programme control | 48 / 91 | Generated from 210 features | deterministic successful plan | 10.25 total FTE | calculated | 0 / 0 |
| Synthetic profile-window failure | 48 / unavailable | Same generated task graph | unavailable after planner failure | unavailable | unavailable | unavailable; profile failure recorded |

The explicit-cap result is a deterministic best-effort plan, not a claimed
target-feasible result: the plan reaches four weeks under a hard one-FTE cap
against a two-week target. The synthetic control proves expected effort equals
the actual weekly planner demand by role. No post-failure utilisation or
schedule values are fabricated.

## Synthetic profile-window reproduction

The synthetic fixture uses 3 Platform Engineers, 5 Data Engineers and 2 Cloud
Engineers, target 48 weeks, period size 4 weeks, maximum headcount delta 1,
no explicit `maxCap`, `maxParallelismPerFeature=3`, and
`maxConcurrentEpics=4`. The Data Engineer role additionally has a profile
segment covering weeks 0–6 at 100% for the failure path.

Both paths run through `computeCapacityPlan`, the pure core used by
`POST /api/projects/:projectId/squad-plan`:

- **Observed failure:** `Fractional planner could not finish feature synthetic-feature-009 within 1050 weeks`.
- **Control:** removing only the Data Engineer profile segment, while preserving the generated counts, target, topology, effort, dependency edges, parallelism and epic concurrency, succeeds in 91 weeks with peak 10.25 FTE and no capacity or predecessor-completion dependency violations.

The constraint is code/runtime evidenced. `computeCapacityPlan` invokes
`runSAPlanner`; `runSAPlanner` obtains weekly capacity through
`getWeeklyCapacity`; a non-empty `roleSegments` array replaces the role's
phantom-slot capacity and weeks outside the segment have zero capacity. The
synthetic graph has continuing Data Engineer demand after week 6, so the
allocator cannot complete the blocked feature and exhausts its deterministic
horizon. The control removes that window and succeeds, isolating the profile
window as the limiting constraint.

## Implications for #480 and #481

- #480 must distinguish an unrestricted role maximum from an explicit/profile-backed availability window; blank `maxCap` cannot erase a deliberate profile window, and diagnostics should identify the constrained role and window.
- #481 must plan around explicit/manual profile windows and reconcile reported delivery with the same final capacity-aware schedule; the benchmark's 53-week control is the current evidence baseline, not a production target.
- Both follow-on issues should retain the effort, dependency, capacity and deterministic invariants established here. No production planner behaviour is changed by this benchmark work.

## Joint-planner regression contract (#481)

The #481 joint planner adds a separate reconciliation contract; it does not
change the deterministic #479 scheduler or capacity-plan baseline values above.
The returned period envelope is authoritative and must be replayable through
the production materializer: replay must preserve delivery duration and feature
starts, conserve scheduled effort by role, complete dependencies, and keep
weekly demand at or below effective committed capacity. Explicit named-resource
locks and profile windows remain hard (including zero-capacity gaps), while
growth and reduction operate in deterministic 0.25-FTE quanta. A target failure
must return the best truthful result or structured diagnostics rather than a
vacuous successful claim.

The generated envelope is normalised to the same week-level authority used by
replay. Periods use an inclusive `startWeek` and exclusive `endWeek`; zero
periods are retained so unavailable weeks and profile gaps cannot be inferred
away. A role-level `roleSegments` profile constrains only aggregate role
capacity, while named-person windows remain independent. When a role has both
named and unnamed slots, unrestricted unnamed capacity remains available
outside a named person's window. A named-only role does not gain synthetic
out-of-window capacity. Protected named allocations are floors of the reported
envelope and therefore remain included in cost, peak, and utilisation metrics.

Manual feature windows, including fractional-week starts, and individual story
pins are enforced during planning and replay. A story pin does not delay its
automatic siblings, and applying a plan preserves manual timeline rows. When
an immutable pin prevents the target, the completed plan retains its achieved
duration and reports a `SCHEDULE_LOCK` diagnostic. Generated periods can split
at availability or protected-allocation boundaries within the requested planning
period; the apply path must reproduce their weekly capacity and feature starts.
