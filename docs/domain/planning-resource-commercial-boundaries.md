# Planning, Resource, and Commercial Boundaries

Parent epic: #263  
Definition issue: #243  
Related issues: #253, #255, #264, #265, #266, #267, #268, #269, #270, #271

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
- manual timeline overrides;
- named-resource actual assignment;
- actual allocated days, weeks, and segments;
- planning windows used for delivery scheduling;
- resource-level scheduling outputs;
- capacity-plan materialisation where it affects schedule and actual assignment.

Timeline / Planning may use effort from Backlog / Estimation and resource metadata from Resource Profile, but it owns the derived planning result.

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

Project-level planning settings should have one owning surface.

Preferred target:

- Onboarding weeks and buffer weeks should live in the planning/project settings area.
- Timeline / Planning should use them directly because they affect dates and schedule outputs.
- Resource Profile and Commercial may display them as read-only context if needed.
- They should not be primary editable controls in multiple places.

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
- planning window;
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
- availability windows;
- capacity-plan inputs;
- manual timeline overrides;
- billing-basis choices;
- discounts and tax settings.

Derived data should be calculated through shared services/read models, such as:

- effort summaries by role;
- weekly demand;
- weekly capacity;
- actual named-resource assignment;
- actual allocated days;
- allocation segments;
- row-level planning summaries;
- commercial billable days;
- commercial subtotals and totals.

Display labels should be resolved from IDs at response/render time. Planning outputs should persist IDs and derived facts, not stale copies of resource names.

## Follow-up implementation sequence

Recommended order under #263:

1. #264 - Extract shared project planning read model.
2. #265 - Move allocation-mode editing out of Commercial tab.
3. #266 - Clarify named-resource billing basis terminology.
4. #267 - Centralise project query invalidation for planning and resource changes.
5. #268 - Store planning IDs and derived facts instead of stale display labels.
6. #270 - Give project planning settings one owning surface.
7. #271 - Split Resource Profile client hook into focused modules.
8. #269 - Add canonical Timeline to Resource Profile to Commercial consistency fixture.

This order is intentional. The shared read model should come before UI movement and client refactors so later changes have one stable source of planning-derived facts.

## Acceptance criteria for this decision

This decision is satisfied when:

- Backlog / Estimation, Timeline / Planning, Resource Profile, and Commercial have clearly defined ownership.
- Delivery effort, resource plan / capacity, and commercial pricing are documented as separate concepts.
- Allocation mode has a planning owner and is no longer treated as a commercial control.
- Named-resource billing basis is described as a commercial pricing decision, not a planning mode.
- Project-level planning settings have one intended owning surface.
- Follow-up #264 can proceed without re-litigating the domain model.
- Follow-up UI and refactor issues can use this document as the source of truth.

## Non-goals for this slice

This document does not implement the refactor. It intentionally avoids changing runtime behaviour.

The implementation work belongs in the follow-up issues under #263, especially #264 through #271.
