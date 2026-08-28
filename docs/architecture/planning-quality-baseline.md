# Planning-quality benchmark baseline

Issue #479 establishes a deterministic evidence baseline before changing planner semantics. The committed tests use the existing pure `runScheduler`, `runSAPlanner`, and `computeCapacityPlan` paths; production planner code is unchanged.

## Source evidence and sanitisation

The large benchmark is derived from the authoritative planning repository's generated programme-led Monrad import and its planning outputs:

- generated programme-led import: 18 epics, 222 features, 755 source tasks, and 16,989.8 source hours;
- resource summary: role demand and peak demand shape;
- planning-period resource profile and recommended staffing profile: 19-working-day periods, role mix, ramp limits and proposed capacity shape;
- detailed programme timeline: dependency-driven sequencing and 337 model working days; and
- dependency register and generated dependency model: prerequisite topology.

The committed fixture retains 18 generic epics, 222 generic features, 256 resolved feature dependency edges, one epic dependency, three generic roles, and role-level feature effort. It aggregates source tasks by role inside each feature, excludes customer-owned zero-effort tasks, and removes customer names, descriptions, story text and identifiers. The source role totals retained by the fixture are Principal Consultant 4,062.2 hours, Senior Data Engineer 10,024.4 hours, and Senior Cloud Engineer 2,903.2 hours.

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
| Derived Factory control | 78 / 53 | PC 4,062.2h; Data 10,024.4h; Cloud 2,903.2h | PC 6,150h / 153.75 FTE-weeks; Data 12,560h / 314; Cloud 4,160h / 104 | PC 3; Data 6; Cloud 2 / 11 | 66.01%; 79.80%; 69.75% | 0 / 0 |
| Derived Factory profile-window failure | 78 / unavailable | PC 4,062.2h; Data 10,024.4h; Cloud 2,903.2h | unavailable after planner failure | unavailable | unavailable | unavailable; profile failure recorded |

The explicit-cap result is a deterministic best-effort plan, not a claimed target-feasible result: the plan reaches four weeks under a hard one-FTE cap against a two-week target. Both successful capacity-plan baselines prove expected effort equals the actual weekly planner demand by role. No post-failure utilisation or schedule values are fabricated for the Factory failure.

## Factory / Supply Chain reproduction

The sanitised fixture uses the source-derived role-capacity shape of 3 Principal Consultants, 6 Senior Data Engineers and 2 Senior Cloud Engineers, target 78 weeks, period size 13 weeks, maximum headcount delta 1, no explicit `maxCap`, `maxParallelismPerFeature=2`, and `maxConcurrentEpics=6`. The Data role additionally has an authoritative profile segment covering weeks 0–5 only for the failure path.

Both paths run through `computeCapacityPlan`, the pure core used by `POST /api/projects/:projectId/squad-plan`:

- **Observed failure:** `Fractional planner could not finish feature factory-feature-003 within 1107 weeks`.
- **Control:** removing only the Data role profile segment, while preserving counts, target, topology, effort, dependency edges, parallelism and epic concurrency, succeeds in 53 weeks with peak 11 FTE, expected-versus-scheduled effort conservation by role, and no capacity or predecessor-completion dependency violations.

The constraint is code/runtime evidenced. `computeCapacityPlan` invokes `runSAPlanner`; `runSAPlanner` obtains weekly capacity through `getWeeklyCapacity`; a non-empty `roleSegments` array replaces the role's phantom-slot capacity and weeks outside the segment have zero capacity. The derived fixture has continuing Data demand after week 5, so the allocator cannot complete the blocked feature and eventually exhausts its deterministic horizon. The control removes that window and succeeds, isolating the profile window as the limiting constraint for this reproduction. The result is not a claim that every current customer runtime failure has the same blocker.

The source planning outputs provide a useful qualified comparison: the accepted dependency-driven timeline ends at 337 model working days and its resource profile reports a raw-demand peak of 11.5 FTE. The 53-week control is faster, but its 11-FTE staffing and role aggregation are not an exact reproduction of the source profile because customer-owned work and PM/governance calculations are excluded from the sanitised planner input. The benchmark therefore compares shape and constraints, not exact weekly equality.

## Implications for #480 and #481

- #480 must distinguish an unrestricted role maximum from an explicit/profile-backed availability window; blank `maxCap` cannot erase a deliberate profile window, and diagnostics should identify the constrained role and window.
- #481 must plan around explicit/manual profile windows and reconcile reported delivery with the same final capacity-aware schedule; the benchmark's 53-week control is the current evidence baseline, not a production target.
- Both follow-on issues should retain the effort, dependency, capacity and deterministic invariants established here. No production planner behaviour is changed by this benchmark work.
