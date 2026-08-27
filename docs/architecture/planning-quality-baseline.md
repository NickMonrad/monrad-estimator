# Planning-quality benchmark baseline

Issue #479 establishes a deterministic baseline before changing planner semantics. The benchmark is pure server-side coverage over the existing `runScheduler`, `runSAPlanner`, and `computeCapacityPlan` paths; it does not change production planner behaviour.

## Harness and invariants

`server/src/lib/planning-benchmark.ts` measures, for a scheduler result:

- requested and achieved duration;
- effort hours/person-days by role;
- staffed capacity hours and FTE-weeks over the requested planning window;
- peak demand staffing and role utilisation;
- weekly capacity violations and dependency violations;
- demand weeks, ramp-up/ramp-down transitions, and sparse-role shape; and
- a stable output fingerprint for repeatability checks.

Every claimed-feasible scenario asserts effort conservation, dependency correctness, capacity compliance, and repeatability. The scenarios intentionally use small, named fixtures in `server/src/test/planningBenchmarkFixtures.ts` rather than a generic optimisation framework.

## Baseline metrics

The following values are produced by the current deterministic scheduler at the fixture's default capacity. FTE-weeks measure committed capacity in the requested window, not only consumed demand; this makes idle capacity visible.

| Scenario | Target / achieved weeks | Effort by role (person-days) | Staffed FTE-weeks | Peak demand FTE | Utilisation by role |
|---|---:|---|---|---:|---|
| Serial critical path | 4 / 4 | Developer 10 | Developer 4 | 0.50 | Developer 50% |
| Parallel same-role | 4 / 4 | Developer 20 | Developer 4 | 1.00 | Developer 100% |
| Role hand-off | 2 / 2 | Developer 5; QA 5 | Developer 2; QA 2 | 1.00 | 50%; 50% |
| Sparse specialist | 4 / 4 | Developer 20; Specialist 1 | Developer 4; Specialist 4 | 1.00 | 100%; 5% |
| Manual capacity/schedule lock | 6 / 6 | Developer 15 | Developer 6 | 1.00 | Developer 50% |
| Mixed programme | 6 / 6 | Developer 25; QA 10 | Developer 6; QA 6 | 1.00 | 83.33%; 33.33% |
| Explicit Developer maximum | 2 / 4 | Developer 20 | capped at 1 FTE in the plan period | — | — |

The parallel fixture is the deliberate capacity-sensitivity control: changing Developer count from one to two reduces achieved duration from four to two weeks without changing the conserved 20 person-days of effort. The serial fixture keeps its four-week duration with one or four Developers because each task has a ten-day elapsed-duration floor.

## Factory / Supply Chain reproduction

No Factory / Supply Chain CSV, workbook, timeline, resource-profile export, customer/dependency register, or related artefact was found in the repository or its git history; GitHub code search for `Coles Factory` returned no matches. The only committed CSV is an unrelated Westpac Fabric enablement PoC import. The committed large-project fixture is therefore explicitly **sanitised and representative**, not a copy of customer data.

The fixture preserves the planning facts available in issue history: 23 epics, 248 features, seven role types, and 25,760 hours (approximately 26k). It preserves role-mix and parallel/sequential topology characteristics but contains no customer names, work-item descriptions, or asserted spreadsheet week placements.

The reproduction calls `computeCapacityPlan`, which is the pure core called by `POST /api/projects/:projectId/squad-plan` in `server/src/routes/squadPlan.ts`.

| Input | Value |
|---|---|
| Target duration | 78 weeks |
| Period / max delta | 13 weeks / 1 headcount per period |
| Resource types | 7; constrained role count is 3 |
| Explicit `maxCap` | None |
| `maxParallelismPerFeature` | 2 |
| `maxConcurrentEpics` | 6 |
| Constrained resolved profile | Data Integration role segment, 100% in weeks 0–5 only |
| Current result | Failure: `Fractional planner could not finish feature factory-feature-014 within 1252 weeks` |
| Control result | Removing only that profile window succeeds in 55 weeks with the same topology and planner settings |

### Evidence-backed constraint diagnosis

1. `squadPlan.ts` loads resolved scheduler capacity with `includeCapacityPlanMaterialization: false`; it preserves non-empty role profile segments.
2. `computeCapacityPlan` invokes `runSAPlanner` with the configured target, parallelism, concurrency, and optional max cap.
3. `runSAPlanner.getWeeklyCapacityDays()` divides `getWeeklyCapacity()` by role hours/day. A non-empty `roleSegments` array is authoritative; weeks outside its segments have zero capacity.
4. The Data Integration role has remaining demand after week 5. The allocator therefore cannot finish the representative feature and throws after its deterministic availability probe/maximum horizon; the route converts that error into the current generic 400 “No feasible squad plan” response with the detail appended.
5. Removing the role segment, without changing counts, max caps, parallelism, concurrency, effort, or topology, succeeds. This isolates the profile window as the reproduced limiter.

The run has no configured hard role maximum (`maxCap` is absent). The profile window is an actual persisted-capacity constraint, not a UI-only inference. Current role counts are also used as the available capacity seed, but they are not the direct cause in this reproduction: removing the window is sufficient to produce a plan. Feature/epic ordering and the configured parallelism/concurrency limits remain real schedule constraints, but they do not explain this failure because the same settings succeed in the control run. No explicit dependency edges are needed to trigger the failure.

No comparable manual Factory / Supply Chain profile was available, so this baseline does not claim automatic/manual dominance or encode a spreadsheet as the correct answer.

## Implications for #480 and #481

- #480 must make blank role maxima genuinely unbounded while preserving deliberate capacity-profile windows and reporting them as structured constraints; blank max alone cannot erase an existing profile.
- #481 must plan around explicit/manual profile windows rather than treating every current count or profile as an unexplained optimisation cap, and must report the constrained role and available window when the target cannot be met.
- Neither issue should discard the effort/dependency/capacity invariants or the deterministic benchmark fixtures. Future positive assertions can replace the reproduced failure assertion once the approved semantics change.
