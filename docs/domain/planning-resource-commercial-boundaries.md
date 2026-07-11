# Planning, Resource, and Commercial Boundaries

Parent epic: #263  
Definition issue: #243  
Related issues: #253, #255, #264, #265, #266, #267, #268, #269, #270, #271

Related design: [`capacity-profile-design.md`](capacity-profile-design.md)

> Note: this boundary document still contains some older/internal terms such as “synthetic slot”, “allocation mode”, and “actual allocated days”. The capacity profile design refines the preferred plain-English terminology. Treat those older labels as implementation or legacy language unless a later design explicitly keeps them.

## Decision

Monrad Estimator should treat **delivery effort**, **resource plan / capacity**, and **commercial pricing** as separate domain concepts with clear ownership.

They are related, but they are not the same thing:

- **Delivery effort** is the estimated work required to complete backlog items and tasks.
- **Resource plan / capacity** is how that effort is scheduled, constrained, assigned, and spread across roles, named resources, availability windows, and capacity plans.
- **Commercial pricing** is how the project is priced or billed. It may use actual scheduled days, planned allocation, full-project assumptions, or another agreed billing basis.

The application should stop using the same-looking allocation fields across multiple screens to represent different concepts. Where one surface displays a value owned by another surface, that value should be read from a shared read model or derived at response/render time, not independently recalculated or persisted as duplicate state.

A user should be able to answer three different questions without the UI implying that they are the same question:

1. **How much work is required?** This is delivery effort.
2. **How will we staff and schedule that work?** This is the resource plan / capacity model.
3. **How will we price or bill it?** This is the commercial model.

## Why this is needed

The Resource Profile, Timeline, and Commercial areas have grown from useful views into partially overlapping domain editors. This has made the product harder to reason about and harder to maintain.

Current problems include:

- Resource Profile, Timeline, and Commercial all expose planning/allocation concepts.
- Commercial can appear to edit planning allocation state, even though pricing and planning are different concerns.
- Resource Profile displays named-resource and allocation state that is partly derived from Timeline scheduling.
- Project onboarding weeks and buffer weeks appear in more than one place.
- `Actual Days` vs `Pro-rata` reads like a planning mode, but it is really a billing-basis decision.
- Bugs such as #253 show that commercial calculations can drift from planning allocations.
- Bugs such as #255 show that persisted or duplicated display values can become stale after resource edits.

The main maintainability issue is not a single bug. It is that the same business idea is represented in several places with slightly different meanings.

## Target ownership model

### Backlog / Estimation owns effort inputs

Backlog / Estimation is the source of truth for the effort required to deliver the work.

It owns:

- task effort inputs;
- task duration inputs where duration is used as the estimate basis;
- backlog structure used to roll effort up to stories, features, epics, and roles;
- the raw estimated work before scheduling, capacity constraints, or pricing rules are applied.

Resource Profile may summarise estimated effort by role. Timeline / Planning may distribute the effort across time. Commercial may price a selected billing basis derived from effort or planning outputs. None of those surfaces should become a second owner of the original task effort estimate.

### Timeline / Planning owns planning reality

Timeline / Planning is the source of truth for delivery scheduling and planning outputs.

It owns:

- schedule outputs;
- feature and story timing;
- weekly demand;
- capacity by week;
- onboarding weeks and buffer weeks;
- manual timeline overrides;
- named-resource actual assignment;
- actual allocated days, weeks, and segments;
- planning windows used for delivery scheduling;
- resource-level scheduling outputs;
- capacity-plan materialisation where it affects schedule and actual assignment.

Timeline / Planning may use effort from Backlog / Estimation and resource metadata from Resource Profile, but it owns the derived planning result.

Onboarding weeks and buffer weeks belong here because they shape the project planning window, affect when capacity is required, and change how resources are allocated over time.

### Resource Profile owns resource shape

Resource Profile is the source of truth for the resource inputs used by planning and pricing.

It owns:

- resource types / roles;
- named people or synthetic slots;
- resource counts;
- hours per day;
- default and overridden day rates;
- availability and capacity inputs;
- role/category metadata;
- resource metadata required by planning and commercial calculations.

Resource Profile can display estimated effort and planning-derived information, such as actual assigned days, but should not independently calculate a separate version of the effort or planning result.

PR #356 (open, pending merge) introduces capacity-profile read adoption in Resource
Profile, making it authoritative for displaying and exporting capacity-profile data
from the persisted `CapacityProfile`/`CapacitySegment` read model. The adapter in
`capacityProfileResourceAdapter.ts` resolves profiles with profile-first precedence:

1. **Persisted owner-specific profile** — if a `CapacityProfile` exists for the
   owner (role or named resource), its data is used with
   `resolutionSource: 'PROFILE'`.
2. **Active Capacity Plan materialisation** — only when the existing
   `shouldFallbackToActiveCapacityPlan` logic requires it (e.g. `CAPACITY_PLAN`
   mode with no explicit profile override). Materialised from active `CapacityPlan`
   periods with `resolutionSource: 'ACTIVE_CAPACITY_PLAN'`. Checked before LEGACY
   because CAPACITY_PLAN-mode legacy fields are meaningless for display.
3. **Pure legacy compatibility state** — derived from legacy `ResourceType`/
   `NamedResource` fields with `resolutionSource: 'LEGACY'`. This is owner-specific
   legacy state only, never contaminated by capacity plan materialisation.

**Commercial calculations remain unchanged.** Billing formulas, billable days,
discounts, tax, and totals use the same inputs as before. The adapter's
profile-first resolution enriches Resource Profile display and export from
persisted `CapacityProfile`/`CapacitySegment` data. Separately, the pre-existing
active Capacity Plan fallback (not introduced by PR #356) uses segment-aware
trajectory capacity for named-resource assignment and planned-capacity totals in
`namedResourceAssignments.ts` and `projectPlanningModel.ts`; this pre-dates and is
independent of PR #356's adapter. Scheduler and leveller algorithms themselves are not
redesigned by PR #356. Active-plan weekly capacity remains mathematically equivalent
to existing plan headcount.

**Role aggregate vs per-resource profiles:** Role-level (`ResourceType`) profiles
represent aggregate capacity across all resources of that type. Each individual
named-resource (`NamedResource`) profile is specific to one resource slot. These
use different owner kinds and are independently keyed by `resourceTypeId` and
`namedResourceId` respectively — the two key namespaces never collide.

**Duplicate owner keys fall through:** If the adapter encounters a duplicate owner
key in the profile map (defensive guard), it treats the entry as absent and falls
through to the next precedence tier rather than throwing or blocking.

### Commercial owns billing and price presentation

Commercial is the source of truth for pricing presentation and billable calculation choices.

It owns:

- billing basis;
- discounts;
- tax;
- commercial totals;
- commercial export presentation;
- explanation of which planning basis was used for pricing.

Commercial may display effort and planning-derived values, but it should not be the primary place where delivery effort or planning allocation modes are edited.

## Terminology

| Term | Meaning | Owner | Persisted or derived |
| --- | --- | --- | --- |
| Estimated effort | Work required to complete backlog tasks, usually from task estimates and effective hours/days. | Backlog / Estimation | Persisted at task level, derived in summaries |
| Effort summary by role | Estimated effort rolled up by resource type / role. | Resource Profile display | Derived from backlog effort inputs |
| Scheduled demand | Effort distributed across timeline weeks. | Timeline / Planning | Derived planning output |
| Capacity | Available working capacity for a role or named resource across time. | Resource Profile inputs, Planning output by week | Inputs persisted, weekly capacity derived |
| Onboarding weeks | Planning time added before delivery work ramps up. | Timeline / Planning | Persisted planning input, reflected in derived planning window |
| Buffer weeks | Planning time added to the schedule window to absorb delivery risk or transition time. | Timeline / Planning | Persisted planning input, reflected in derived planning window |
| Planned allocation | Intended allocation based on selected planning mode, percentage, dates, count, or capacity plan. | Timeline / Planning, using Resource Profile inputs | Inputs persisted, result derived |
| Actual named-resource assignment | The actual assignment of weekly demand to named people or synthetic slots. | Timeline / Planning | Derived planning output |
| Actual allocated days | The days actually assigned by the planning model. | Timeline / Planning | Derived planning output |
| Billable days | The number of days used for commercial calculation. | Commercial | Derived from selected billing basis |
| Billing basis | The commercial rule used to decide billable days, such as actual scheduled days or planned allocation. | Commercial | Persisted as commercial/pricing choice where required |
| Rate | Day rate or default day rate used for price calculation. | Resource Profile / rate card | Persisted input |
| Subtotal / total price | Commercial calculation after billable days, rates, discounts, and tax. | Commercial | Derived commercial output |

## UI decisions

### Allocation mode editing

Allocation mode should be edited from a planning-oriented surface, not from Commercial.

Preferred target:

- The main editing surface should be Timeline / Planning or a clearly named planning settings surface.
- Resource Profile may show the mode for context when looking at roles and named resources.
- Commercial may show the resolved planning basis used for pricing, but should not be the primary editor for planning allocation mode.

This reduces the chance that a user changes delivery planning while thinking they are only changing pricing.

### Allocation mode display

Allocation mode should be displayed where it helps explain the current plan.

- Timeline / Planning should show and edit the actual planning mode.
- Resource Profile should show enough information to understand how a role or named resource is being used.
- Commercial should show the planning-derived value as an input to price, not as the owner of the planning state.

### Aggregate mode

`Aggregate` should not hide the underlying named-resource behaviour.

Preferred target:

- Avoid presenting `Aggregate` as if it is a real editable planning mode.
- When named resources exist, show the underlying named-resource modes or a clearer summary such as `Named resources: mixed modes`.
- If a compact row-level label is needed, make it clear that it is a summary, not the source-of-truth mode.

### Onboarding weeks and buffer weeks

Onboarding weeks and buffer weeks should be owned by Timeline / Planning.

Preferred target:

- Timeline / Planning is the only primary edit surface for onboarding weeks and buffer weeks.
- Timeline / Planning uses them directly because they affect dates, weekly demand, capacity timing, and resource allocation over time.
- Resource Profile may display them as read-only context where they explain role/resource summaries.
- Commercial may display them as read-only context where they explain pricing inputs, but it should not own or edit them.
- They should not be primary editable controls in Resource Profile or Commercial.

### Named-resource billing basis

`Actual Days` vs `Pro-rata` should be renamed so it reads as a commercial billing basis rather than a planning mode.

Preferred target labels:

- `Bill actual scheduled days`
- `Bill planned allocation`

Commercial wording should explain that:

- `Bill actual scheduled days` prices the actual days assigned by the planning model.
- `Bill planned allocation` prices the planned/pro-rata allocation, even if actual scheduling assigns fewer or different days.

This setting should be edited where the user is making a commercial pricing decision. It should not be described as an allocation mode.

### Commercial tab behaviour

Commercial should answer:

- What are we charging for?
- Which billing basis is being used?
- Which rate applies?
- Which discounts/tax apply?
- What is the resulting subtotal/total?

Commercial should not be the place where users primarily answer:

- How much work is required?
- When is the work scheduled?
- Which named resources are assigned?
- Which allocation mode shapes the delivery plan?
- How does capacity constrain the schedule?

## API and read-model direction

Follow-up #264 should introduce a shared project planning read model used by Timeline, Resource Profile, Commercial, and exports.

The read model should provide consistent planning-derived facts, including:

- effort rollups by role from the backlog estimate;
- onboarding weeks and buffer weeks as Timeline-owned planning inputs;
- planning window derived from Timeline-owned planning inputs;
- weekly demand;
- weekly capacity;
- named-resource actual assignments;
- actual allocated days/weeks/segments;
- derived start/end windows;
- stable IDs for roles, named resources, features, stories, and assignments;
- display labels resolved from current source records.

The read model should avoid each route recalculating its own version of the same planning facts.

### Persisted vs derived data

Persisted data should be limited to source inputs and intentional user decisions, such as:

- task effort inputs;
- task duration inputs where duration is an estimate input;
- resource type and named-resource metadata;
- rates;
- allocation mode inputs;
- onboarding weeks and buffer weeks;
- availability windows;
- capacity-plan inputs;
- manual timeline overrides;
- billing-basis choices;
- discounts and tax settings.

Derived data should be calculated through shared services/read models, such as:

- effort summaries by role;
- planning windows derived from Timeline-owned planning inputs;
- weekly demand;
- weekly capacity;
- actual named-resource assignment;
- actual allocated days;
- allocation segments;
- row-level planning summaries;
- commercial billable days;
- commercial subtotals and totals.

Display labels should be resolved from IDs at response/render time. Planning outputs should persist IDs and derived facts, not stale copies of resource names.

## Automated testing expectations

Automated tests should be updated as each implementation slice lands. Testing should not be deferred until the end of the #263 refactor.

Each behaviour-changing PR under #263 should either add/update automated tests or clearly explain why no automated coverage changed.

Expected coverage by slice:

- #264 should test the shared planning read model and parity with existing route outputs.
- #265 should test that Commercial no longer owns planning allocation edits.
- #266 should cover renamed billing-basis terminology where practical.
- #267 should cover invalidation helpers or mutation side effects where practical.
- #268 should test that display labels resolve from current IDs after a rename.
- #270 should test Timeline-owned onboarding/buffer week changes and cross-view refresh.
- #271 should keep behaviour-preserving tests green while the Resource Profile hook is split.
- #269 should provide the canonical consistency fixture across Timeline, Resource Profile, Commercial, and exports.

Prefer fast integration/unit coverage around the shared planning model and API behaviour. Add Playwright coverage for key user flows where the existing UI test harness makes that practical.

## Follow-up implementation sequence

> **Note:** PR #356 (open, pending merge) introduces capacity-profile read adoption in
> Resource Profile, as part of the #340 source-of-truth epic. It introduces profile-first
> read precedence in the Resource Profile route and export hook, ahead of the #263
> sequence above. This means Resource Profile display and export fields will resolve from
> `CapacityProfile`/`CapacitySegment` when a persisted profile exists, rather than
> exclusively from legacy `ResourceType`/`NamedResource` fields. Commercial calculations
> (allocatedDays, actualAllocatedDays, totalDays, estimatedCost) remain unchanged.
> Scheduler, leveller, Timeline, and Squad Planner also remain unchanged — they continue
> to read legacy allocation fields directly. The sequence below is for the #263 epic
> (ownership boundaries); the #340 epic (profile source-of-truth migration) runs in
> parallel and may inform later #263 items.
Recommended order under #263:

1. #264 - Extract shared project planning read model.
2. #265 - Move allocation-mode editing out of Commercial tab.
3. #266 - Clarify named-resource billing basis terminology.
4. #267 - Centralise project query invalidation for planning and resource changes.
5. #268 - Store planning IDs and derived facts instead of stale display labels.
6. #270 - Move onboarding and buffer weeks into Timeline planning settings.
7. #271 - Split Resource Profile client hook into focused modules.
8. #269 - Add canonical Timeline to Resource Profile to Commercial consistency fixture.

This order is intentional. The shared read model should come before UI movement and client refactors so later changes have one stable source of planning-derived facts.

## Acceptance criteria for this decision

This decision is satisfied when:

- Backlog / Estimation, Timeline / Planning, Resource Profile, and Commercial have clearly defined ownership.
- Delivery effort, resource plan / capacity, and commercial pricing are documented as separate concepts.
- Allocation mode has a planning owner and is no longer treated as a commercial control.
- Timeline / Planning owns onboarding weeks and buffer weeks.
- Named-resource billing basis is described as a commercial pricing decision, not a planning mode.
- Follow-up #264 can proceed without re-litigating the domain model.
- Follow-up UI and refactor issues can use this document as the source of truth.
- Automated testing expectations are explicit for the implementation issues under #263.

## Non-goals for this slice

This document does not implement the refactor. It intentionally avoids changing runtime behaviour.

The implementation work belongs in the follow-up issues under #263, especially #264 through #271.

## Implementation status

### Pending: Capacity-profile read adoption in Resource Profile (PR #356, open)

PR #356 (open, pending merge) would make the persisted `CapacityProfile`/`CapacitySegment`
read model authoritative for display and export in Resource Profile, using profile-first
precedence. These changes are currently on the `feature/capacity-profile-resource-profile-reads`
branch and will land when PR #356 merges.

**Key changes:**

- **Adapter (profile-first precedence, exact order):**
  `buildResourceCapacityProfileMap` in `capacityProfileResourceAdapter.ts` uses
  three-tier precedence: persisted owner-specific profile (`resolutionSource:
  'PROFILE'`) → active Capacity Plan materialisation (`resolutionSource:
  'ACTIVE_CAPACITY_PLAN'`, only when `shouldFallbackToActiveCapacityPlan` requires
  it) → pure legacy compatibility state (`resolutionSource: 'LEGACY'`). No
  reconciliation comparison is required — the adapter uses persisted data directly
  when a profile exists for the owner.

- **Route display-field projection:**
  `GET /api/projects/:projectId/resource-profile` uses
  `projectCapacityProfileToLegacyAllocation` (`capacityProfileLegacyProjection.ts`)
  to project profile fields into legacy display fields (`allocationMode`,
  `allocationPercent`, `allocationStartWeek`, `allocationEndWeek`) when a profile
  exists, falling back to raw legacy fields when no profile is available.

- **Client types updated:**
  `ResourceProfileRow.capacityProfile` in `backlog.ts` includes `defaultPercent`,
  `startWeek`, `endWeek`, and `resolutionSource` fields.

- **CSV export:**
  `useResourceProfileExport.ts` adds five new columns: **Planning basis**,
  **Profile source**, **Default capacity %**, **Profile start**, **Profile end**.
  The `Capacity profile segments` column shows segments in human-readable format
  (e.g. `W1-W4 50%; W5-W10 100%`), distinct from the `Assignment segments` column.

**Key constraints preserved:**

- Legacy ResourceType/NamedResource fields remain authoritative for write paths.
- Commercial billing formulas, billable days, discounts, tax, and totals are unchanged.
- Entity identity is preserved — one named person / planned resource with multiple
  capacity segments is one row, not multiple.
- Role aggregate vs per-resource profiles — role-level (ResourceType) profiles
  represent aggregate capacity across all resources of that type; each
  named-resource profile is specific to one resource slot.
- Independent key spaces — role profiles keyed by `resourceTypeId`,
  named-resource profiles by `namedResourceId`; the two namespaces never collide.
- Duplicate owner keys in the profile map fall through to the next precedence
  tier rather than blocking.

**New files introduced:**

| File | Purpose |
|------|---------|
| `server/src/lib/capacityProfileResourceAdapter.ts` | Adapter with profile-first read precedence |
| `server/src/lib/capacityProfileLegacyProjection.ts` | Pure projection helper for display fields |
| `server/src/test/capacityProfileResourceAdapter.test.ts` | 7 unit tests for adapter |

See `capacity-profile-design.md#resource-profile-and-export-adoption` for details.
