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
| NamedResource rows with proven planner provenance | Proven planner-generated placeholders, matched ONLY by exact provenance markers: (a) a `CapacityProfile` with `ownerKind = PLANNED_RESOURCE` (what Squad Planner's `findOrCreatePlannedResources` writes), or (b) the established legacy planner form `NAMED_PERSON` + `SQUAD_PLANNER` + `CAPACITY_PROFILE` (`isLegacyPlannerProfile` — the same safe provenance rule the Squad Planner adoption path uses). User-authored named resources always carry `NAMED_PERSON` profiles outside those exact markers |
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

Findings identify the affected resource by its human-readable name (issue #456) —
e.g. `Resource type "Business Analyst" lacks exactly one persisted ROLE profile
(resource type <id>)` — with the internal ID kept only as secondary diagnostic
context. Machine-readable error codes (`REPLAN_INCOMPLETE`, `REPLAN_REQUIRED`) are
unchanged.

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
  inputs and replan from the existing backlog." Primary action **Complete replan**:
  validates the configured planning inputs; on success the project returns to
  `CURRENT`. When incomplete, the banner gives a concise blocker count and links
  to the actionable Resource Profile recovery checklist.
- **Zero-demand roles stay visible while NEEDS_REPLAN.** Reset preserves every
  ResourceType, and canonical completion requires a profile per preserved role.
  While `NEEDS_REPLAN` the Resource Profile surface therefore exposes EVERY
  preserved role — including roles with no task demand — with real identity and
  non-planning metadata, zero effort/demand, and no fabricated capacity, editable
  through the existing capacity-profile editor. The client's normal
  zero-demand-row filtering is suspended only while `NEEDS_REPLAN`; `CURRENT`
  behaviour is unchanged.
- **Planning exports are quarantined.** Export Resource Profile and Export Full
  Project are disabled while `NEEDS_REPLAN` with the guidance "Replan the project
  before exporting planning data." (the timeline CSV endpoint inside the full
  export is additionally protected by the server-side `REPLAN_REQUIRED` guard).
  `CURRENT` export is unchanged.
- **Missing persisted ROLE profiles are marked (issue #456).** While
  `NEEDS_REPLAN`, a role row that requires a persisted ROLE profile (role-only
  types, or roles with planner-owned profiles) but does not have one renders a
  distinct amber **Needs capacity profile** badge that opens the existing
  capacity editor (create path). The effective/fallback As-needed draft is never
  presented as if it were persisted canonical state. `CURRENT` Resource Profile
  behaviour is unchanged.
- **Bulk "Use role counts as As needed" (issue #456).** Resource Profile exposes
  one explicit user-triggered action (only while `NEEDS_REPLAN`) that persists a
  canonical demand-following (`DEMAND_FOLLOWING`, 100%, `MANUAL` source) ROLE
  profile for EVERY eligible missing role-only ResourceType in one atomic batch
  (`lib/bulkAsNeededProfiles.ts` + `POST
  /api/projects/:projectId/capacity-profiles/bulk-as-needed`). It reuses the
  existing authoritative writer (`replaceCapacityProfile`): it never overwrites
  an existing persisted profile, never guesses named-person/planned-resource/
  segmented authority, is idempotent, and rolls the whole batch back on any
  failure. The project stays `NEEDS_REPLAN` — the existing completion operation
  remains the only path back to `CURRENT` — and the response reports any
  remaining completeness findings by human-readable resource name.
- **Named-resource recovery (issue #474).** While `NEEDS_REPLAN`, Resource Profile
  shows each missing named person's name, parent role and next action. Eligible
  persisted named people can be repaired together with **Use As needed for eligible
  named people**, which creates only canonical `NAMED_PERSON` profiles
  (`DEMAND_FOLLOWING`, 100%, `MANUAL`, no fixed window or provenance) through
  `POST /api/projects/:projectId/capacity-profiles/bulk-named-as-needed`. The batch
  is atomic, create-only and idempotent; existing, planner-owned, planned-resource
  and ambiguous authority is never overwritten or reinterpreted. Remaining blocked
  people stay visible with direct individual or Squad Planner actions. A role with
  no named resources does not receive an attention-style People indicator merely
  because its panel is expanded.
- No planning option is automatically selected because of migration history; the
  user picks the approach (As needed, fixed whole project, fixed selected weeks,
  manually shaped, Squad Planner) in the existing surfaces.

## Relationship to #411

#411 (Switch a valid Squad Planner-managed role to manual management while
PRESERVING its capacity) is a separate, non-destructive workflow. #449 Reset
Planning deliberately discards the current planning model. They are kept as distinct
user actions and are never merged into one "detach/reset" operation.

## Production maintenance classification (#404) — completed

The one-time production classification command
(`server/src/scripts/classifyNeedsReplan.ts` + `lib/classifyNeedsReplan.ts`)
classified the 131 affected legacy projects as `NEEDS_REPLAN` under #404
before the destructive legacy-column migration. It ran dry-run-by-default
with a reviewed manifest and deterministic state fingerprint, applied
atomically at SERIALIZABLE isolation, failed closed on any drift, and never
inferred capacity.

**Completed in production under #404:** the classification applied exactly
once (CURRENT 4 / NEEDS_REPLAN 130) and the migration then completed. The
command, its tests and its wiring were removed in PR 3; the product
Reset Planning / Replan workflow remains the supported user path for
`NEEDS_REPLAN` projects.

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

### Deployment prerequisite: the ownership-invariants migration must be applied first

The new #450 migration `20260808221539_add_project_planning_state` sits AFTER
`20260721000001_enforce_capacity_profile_ownership_invariants` in Prisma migration
order. Production evidence (#404) records `20260721000001` as the single pending
migration (37 found, 36 applied). A normal `prisma migrate deploy` therefore
applies `20260721000001` before the #450 migration, and it must already be applied
before the #450 release is installed.

The #450 release must NOT be installed on production while
`20260721000001_enforce_capacity_profile_ownership_invariants` is still pending.

Required production sequence:

1. **#404 executes the reviewed pending migration as its own controlled step**
   (before the #450 release is installed), using the #404 production safety
   process:
   - exact reviewed commit containing `20260721000001_enforce_capacity_profile_ownership_invariants`;
   - maintenance window with no application writes as required;
   - current ownership audit/preflight clean;
   - appropriate current backup/rollback protection;
   - `prisma migrate deploy`;
   - verify ONLY that migration was newly applied;
   - rerun the ownership audit / required validation;
   - stop on any failure.
2. Only after production migration state confirms
   `20260721000001_enforce_capacity_profile_ownership_invariants` is applied may
   the #450 release be installed; its `20260808221539_add_project_planning_state`
   migration then deploys in order.
3. Continue the approved #449/#404 sequence:

   a. Classify the affected legacy projects as `NEEDS_REPLAN` via the reviewed
      maintenance command (dry-run → reviewed fingerprint → `--apply` with it).
   b. Run permanent readiness: `CURRENT` projects must pass; `NEEDS_REPLAN`
      projects are explicitly quarantined.
   c. Prove the normal Reset/Replan workflow on a representative project and
      return it to `CURRENT`.
   d. Create/restore a representative V4 snapshot and rerun readiness.
   e. Only then authorize #418 PR 2 legacy-column removal.

The #421 2,011-write/130-decision preservation plan is superseded and must not be
applied.
