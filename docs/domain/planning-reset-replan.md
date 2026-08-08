# Planning Reset / Replan Project (issue #449)

Parent: #342 — capacity-profile adoption / legacy-column retirement
Related: #404 — production migration execution, #418 — legacy capacity-column migration,
#411 — Squad Planner → manual transfer (distinct, non-destructive)

## Problem

Monrad Estimator can accumulate planning state that is difficult or unsafe to unwind
incrementally: Capacity Plans, manual profile edits, planner-generated resources,
schedule outputs, manual timeline overrides and later planning changes can leave a
project in a state where reconstructing the user's historical intent is harder than
planning again from the current backlog.

Issue #421 proposed a 2,011-write / 130-human-decision preservation remediation.
It is closed as not planned and must NOT be resumed. This feature replaces that path
with an explicit, supported recovery workflow.

## Product decision

> Preserve estimation and business inputs; discard planning state; let the user
> build a new plan from the current backlog using the planning inputs they choose now.

Reset Planning is deliberately NOT an automatic repair system. There is no inverse
operation for every combination of Capacity Plans, manual capacity edits, Squad
Planner, Resource Optimiser, manual timeline overrides, profile ownership transfers
or future planning tools. A project may intentionally be incomplete from a planning
perspective; that state is explicit and supported rather than confused with corruption.

## Explicit project planning state

`Project.planningState` (enum `ProjectPlanningState`):

| State | Meaning |
|---|---|
| `CURRENT` | Planning is expected to be canonical. Missing, duplicate, malformed or conflicting profile state remains a real integrity failure (fail closed exactly as before). |
| `NEEDS_REPLAN` | The project deliberately discarded its planning state (Reset Planning or the reviewed maintenance classification). Planning incompleteness is expected and capacity-dependent execution is quarantined until the user replans. |

`NEEDS_REPLAN` is never inferred from malformed or missing data — only the persisted
field, set by the atomic reset operation, quarantines a project.

## Reset boundary

One atomic server-side operation (`lib/resetProjectPlanning.ts`) inside a single
Prisma transaction. Any failure rolls the whole reset back.

### Cleared (planning-owned state)

| State | Evidence |
|---|---|
| `CapacityProfile` / `CapacitySegment` rows | Planning state being reset (issue #449 boundary) |
| `CapacityPlan` / `CapacityPlanPeriod` / `CapacityPlanEntry` | Planning inputs/outputs |
| `TimelineEntry` / `StoryTimelineEntry` (generated and manual) | Generated schedule output; Timeline/Planning owns manual overrides as planning state |
| `Project.weeklyDemandCache` | Derived planning cache |
| NamedResource rows with a `PLANNED_RESOURCE` profile | Proven planner-generated placeholders: Squad Planner's `findOrCreatePlannedResources` writes those rows and marks them with a `PLANNED_RESOURCE` profile; user-authored named resources always carry `NAMED_PERSON` profiles |
| `Project.planningState` → `NEEDS_REPLAN` | Explicit quarantine |

### Preserved (never touched)

- Project identity, description, customer/org links, status, `hoursPerDay`,
  onboarding/buffer weeks, `startDate`, tax settings.
- Backlog hierarchy, task effort/duration/resource-type assignment, dependencies.
- ResourceType identity, count, `hoursPerDay`, `dayRate`, category, global-type links.
- User-authored NamedResource identity and `pricingModel` (billing basis).
- `ProjectDiscount`, `ProjectOverhead`, snapshots, generated documents.

The candidate legacy capacity columns on `ResourceType`/`NamedResource` are NOT
removed or rewritten by reset (issue #418 PR 2 owns those columns). Runtime readers
are `NEEDS_REPLAN`-aware, so stale legacy values are never projected as capacity
while quarantined.

If provenance is ambiguous, the row is preserved. Names alone ("Developer 1") are
never treated as provenance.

## Reset API

```
POST /api/projects/:projectId/planning/reset   body: { confirm: true }
→ 200 { projectId, planningState: "NEEDS_REPLAN" }
```

- Requires project ownership (`authenticate` + `ownedProject`).
- Requires explicit `{ confirm: true }` (explicit destructive intent).
- Never creates replacement capacity; the user builds the new plan through the
  existing planning surfaces (Resource Profile capacity editor, Squad Planner).

## Replanning completion

```
POST /api/projects/:projectId/planning/complete
→ 200 { projectId, planningState: "CURRENT" }      (canonical state valid)
→ 422 { code: "REPLAN_INCOMPLETE", findings: [...] } (actionable validation findings)
```

The completion rule: the project returns to `CURRENT` only when the persisted
planning state passes the existing canonical validation
(`validatePersistedCapacityProfiles` + `checkPersistedCompleteness` — the same rules
readiness and `GET /capacity-profiles` enforce). Validation runs inside the same
transaction that flips the state, so the flag is never cleared without a canonical
plan, and no profile is ever fabricated. `CURRENT` projects are a no-op.

## Planning-dependent guards

While `NEEDS_REPLAN`, capacity-dependent operations return
`409 { code: "REPLAN_REQUIRED", error: ... }` (typed, actionable — no legacy
fallback, no auto-repair, no invented capacity, no opaque 500):

- `POST /timeline/schedule` (Update Timeline) and `POST /timeline/level`
- `GET /timeline/export/csv`
- Manual timeline overrides (`PUT`/`DELETE` feature and story entries, clear-all)
- `POST /optimise` and `POST /optimise/apply`
- `GET /timeline` returns an explicit neutral empty payload (schedule output was
  cleared by reset; never derived from stale state)

Surfaces the user needs to replan stay accessible:

- `GET /resource-profile` returns effort/inputs with no planning-derived values
  (no capacity-plan materialisation, no profile/legacy projection, no assignments,
  no commercial totals) plus `planningState: "NEEDS_REPLAN"`.
- `GET /capacity-profiles` serves the persisted set without the completeness check
  (expected missing state) but still fails closed on genuinely malformed rows.
- Profile writes (`PUT /capacity-profiles/...`), named-resource identity writes,
  resource-type writes, squad plan build and **Squad Planner apply** stay available:
  they construct the new canonical plan from explicit user inputs and do not consume
  the discarded plan.
- Backlog/project editing is unaffected.

## Stale timeline behaviour

Reset clears generated schedule output and manual overrides as part of the approved
ownership boundary (Timeline/Planning owns both). After reset the timeline is
intentionally empty — there is no stale schedule to misread as authoritative. A
historical timeline viewer is out of scope for this issue.

## UI

- **Reset planning…** — Resource Profile page header, only for `CURRENT` projects.
  Confirmation dialog explains: project/backlog/effort/dependencies kept, business
  and commercial data kept, capacity profiles/plans/planned resources/schedule
  removed, project must be replanned.
- **Planning needs attention** banner (Resource Profile + Timeline pages) — copy:
  "This project's resource planning is no longer current. Review the resource
  inputs and replan from the existing backlog." Primary action **Replan project**:
  runs the completion validation; on success the project returns to `CURRENT`; on
  `REPLAN_INCOMPLETE` the actionable findings are shown inline with a link into
  Resource Profile.
- No planning option is automatically selected because of migration history; the
  user picks the approach (As needed, fixed whole project, fixed selected weeks,
  manually shaped, Squad Planner) in the existing surfaces.

## Relationship to #411

#411 (Switch a valid Squad Planner-managed role to manual management while
PRESERVING its capacity) is a separate, non-destructive workflow. #449 Reset
Planning deliberately discards the current planning model. They are kept as distinct
user actions and are never merged into one "detach/reset" operation.

## Production maintenance classification (#404)

`server/src/scripts/classifyNeedsReplan.ts` (library logic in
`lib/classifyNeedsReplan.ts`):

```
npx tsx src/scripts/classifyNeedsReplan.ts --manifest manifest.json            # DRY RUN (default)
npx tsx src/scripts/classifyNeedsReplan.ts --manifest manifest.json --apply    # apply
```

- Manifest shape: `{ "projectIds": ["<id>", ...] }` — an explicitly reviewed input,
  never invented selection rules on production.
- Dry-run by default; `--apply` required to write.
- Each classified project goes through the same atomic reset transaction as the
  product action: planning state discarded, business data preserved, marked
  `NEEDS_REPLAN`.
- Fails closed: malformed manifest, unknown arguments, or a manifest project that no
  longer exists abort with nothing changed.
- No capacity inference, profile reconstruction, percentage, window or owner-kind
  decisions. Output is sanitized (operator-supplied IDs and aggregate counts only).
- Production execution under #404 remains owned by the production agent; the
  restore-tested backup retained by #404 is untouched by this command.

## Readiness semantics

`lib/productionMigrationReadiness.ts` per-project completeness section skips
projects whose persisted state is `NEEDS_REPLAN` — expected missing planning state
is allowed ONLY because (a) the state is explicitly persisted, (b) planning-dependent
execution is quarantined, and (c) the project can later be replanned through the
normal workflow. The global ownership audit still fails on cross-project ownership,
impossible FK/ownership relationships and duplicate owners where rows remain:
`NEEDS_REPLAN` is never a generic "ignore this project" switch.

## Snapshot implications

V4 snapshots now capture `project.planningState` and restore it when present.
Pre-feature snapshots (no field) leave the project's planning state untouched on
rollback, so an old payload can never implicitly un-quarantine a `NEEDS_REPLAN`
project or quarantine a `CURRENT` one. Snapshot creation and rollback remain
available in both states (a pre-replan snapshot is a useful safety net).

## Migration sequencing

Once merged and proven on production (under #404's process):

1. Classify the affected legacy projects as `NEEDS_REPLAN` via the reviewed
   maintenance command.
2. Run permanent readiness: `CURRENT` projects must pass; `NEEDS_REPLAN` projects
   are explicitly quarantined.
3. Prove the normal Reset/Replan workflow on a representative project and return it
   to `CURRENT`.
4. Create/restore a representative V4 snapshot and rerun readiness.
5. Only then authorize #418 PR 2 legacy-column removal.

The #421 2,011-write/130-decision preservation plan is superseded and must not be
applied.
