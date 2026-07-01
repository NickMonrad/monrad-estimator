# Monrad Estimator User Guide

This guide explains how to use Monrad Estimator in plain English.

It is written for people creating, reviewing, or explaining an estimate. For implementation details, see the maintainer architecture guide: [`docs/architecture/scheduling-and-resource-model.md`](architecture/scheduling-and-resource-model.md).

## What Monrad Estimator is for

Monrad Estimator helps turn a project scope into:

- a structured backlog;
- effort by work item and role;
- a delivery timeline;
- resource demand and staffing views;
- commercial pricing; and
- CSV, PDF, and document outputs.

The app replaces a spreadsheet-style estimation process, but the same ideas still apply: define the work, decide when it happens, check the people/role demand, and turn that into a commercial view.

## The simple mental model

The easiest way to understand the app is to separate five related ideas:

| Area | Plain-English meaning |
|---|---|
| **Backlog** | What work is included. |
| **Effort** | How much work each item needs, usually by role or resource type. |
| **Timeline** | When the work is scheduled to happen. |
| **Resource Profile** | Who, or what type of person, is allocated over time. |
| **Commercial** | What the estimate costs after rates, allocation rules, discounts, overheads, and tax are applied. |

A useful shortcut:

```text
Backlog says: how much work exists
Timeline says: when the work happens
Resource Profile says: who or what role is allocated
Commercial says: what it costs
```

These views are connected, but they are not identical. A change in one area may not automatically mean every other area changes in the way you expect.

## Typical workflow

A normal estimate usually follows this path:

1. **Create or import a project.**
2. **Build the backlog** with epics, features, stories, tasks, descriptions, and assumptions.
3. **Estimate effort** by giving tasks hours or duration days and assigning resource types (roles).
4. **Define resource types** such as Senior Engineer, Project Manager, or Principal Consultant.
5. **Set rates and capacity** such as day rate, hours per day, and resource count.
6. **Set planning basis** on the Resource Counts panel — choose how each role is planned (demand-following or whole-project allocation), set availability windows, and configure capacity profiles.
7. **Add named people or named resources** if you need to model specific people or a staffing shape over time.
8. **Click Update timeline** to schedule the work onto the delivery timeline.
9. **Review the Timeline** for feature/story bars, warnings, gaps, dependencies, and manual overrides.
10. **Review Resource Profile** for role demand, named-person availability and assignment, utilisation, and unallocated work.
11. **Review Commercial** for pricing, discounts, overheads, and tax.
12. **Export outputs** such as CSV, PDF, and generated documents.

You can repeat this loop as the estimate changes.

## Backlog and effort

The Backlog is where the scope is described.

The usual hierarchy is:

```text
Epic -> Feature -> Story -> Task
```

Tasks are where effort is normally captured. A task can include:

- hours of effort;
- duration days;
- resource type;
- description; and
- assumptions.

The important point is that backlog effort answers this question:

> How much work do we think is required?

It does not, by itself, decide exactly when the work will happen or what the final price will be.

## Timeline

The Timeline answers a different question:

> Given the backlog, dependencies, resource setup, and manual overrides, when should the work happen?

The scheduler creates feature and story bars on the Gantt chart. It considers sequencing, dependencies, manual pins, and optionally resource levelling.

### Update timeline — the main scheduling action

**Update timeline** is the normal action to rebuild the Timeline from the latest inputs.

Use it after changing any of the following:

- backlog items (new, removed, or reordered);
- dependencies between features or epics;
- project start date;
- resource counts or planning basis settings;
- named people or named resources;
- capacity settings that affect how much work a role can handle per week.

If **Resource levelling** is enabled, the regenerated schedule respects weekly resource capacity and tries to avoid overloading resource types.

> **Tip:** If the Timeline is not showing what you expect after an input change, try clicking **Update timeline** first before investigating other causes.

### Epic scheduling mode

Epic scheduling mode controls how an epic relates to other epics.

| Mode | Meaning |
|---|---|
| **Sequential** | This epic waits for earlier sequential work before starting. |
| **Parallel** | This epic can start alongside other work instead of waiting for previous epics to finish. |

Common misconception:

> Setting an epic to parallel does not automatically make the features inside that epic run in parallel. It controls how the epic relates to other epics.

### Feature scheduling mode

Feature scheduling mode controls how features inside an epic relate to each other.

| Mode | Meaning |
|---|---|
| **Sequential** | Features inside the epic run one after another. |
| **Parallel** | Features inside the epic can overlap when dependencies and capacity allow. |

To model a proof of concept running alongside a main delivery stream, you may need both:

- the PoC epic set to **parallel**, so it does not wait for the main delivery epic; and
- the PoC epic's features set to **parallel**, so features inside the PoC can overlap.

### Dependencies

Dependencies tell the scheduler that one thing must happen before another.

For example:

> Feature B cannot start until Feature A finishes.

Dependencies can explain why a feature starts later than expected even when capacity appears available.

### Manual pins and overrides

Manual timeline changes let you pin a feature or story to a specific start week or duration.

Manual pins are useful when you know something must happen at a certain time, but they also limit what the scheduler can change later.

If the schedule is not moving the way you expect, check whether a feature or story has been manually pinned.

### Resource levelling

Resource levelling tries to avoid assigning more work to a resource type than it can handle in a week.

In plain English:

> If two features both need the same role at the same time, the scheduler may spread or queue the work so the role is not overloaded.

Resource levelling can create gaps or push work later. That does not always mean something is broken. It may mean the required role is busy on another feature, or a dependency is blocking progress.

## Resource types, roles, and capacity

Resource planning has several terms that sound similar.

| Term | Meaning |
|---|---|
| **Role (resource type)** | A category of work, such as Senior Engineer or Project Manager. |
| **Planned resource** | A role-level staffing slot defined by the resource count. |
| **Named person / named resource** | A specific person attached to a role, with their own availability and allocation. |
| **Capacity profile** | How headcount for a role or person changes over the project — for example starting with one person, growing to three, then tapering back down. |
| **Assigned days** | The days a role or person is actually scheduled to work. |
| **Billable days** | The days used for commercial pricing, which may differ from assigned days depending on the billing basis. |
| **Billing basis** | The commercial rule that decides billable days, such as actual scheduled days or planned allocation. |

A role can have no named people, one named person, or many named people.

If a role has a count greater than the number of named people, the remaining capacity is treated as unnamed capacity. Think of it as planned staffing slots that are not tied to a specific person yet.

## Resource Counts / planning basis

The Resource Counts panel lets you control how each role's capacity is planned.

### Demand-following

The role gets exactly as many people each week as the scheduled work demands, up to the resource count. This is the simplest mode: set a count and let the scheduler decide how many are needed each week.

### Whole-project allocation

The role is assigned a fixed allocation for the entire project (or for a specific date range), regardless of how much scheduled work exists in each week. This is useful for roles like project management that are billed as a consistent effort throughout the project rather than varying week to week.

### Availability window

The date range during which a role or named person is available. Work outside this window is not scheduled against that resource.

### Capacity profile

A model of how headcount changes over time. For example, a project may start with one engineer, grow to three engineers during the main delivery phase, and then taper back down. Capacity profiles let you represent this shape.

After changing resource counts, planning basis, named people, capacity profiles, or dependencies, the Timeline may be stale. Click **Update timeline** to rebuild it.

## Squad Planner and Starting Team Finder

These are secondary tools for exploring capacity, not the normal way to refresh the Timeline.

### Starting Team Finder

Starting Team Finder helps you find a sensible starting squad size. Given the backlog and timeline constraints, it suggests a resource count that fits the work. It is useful early in a project when you are deciding how many people you need.

### Squad Planner

Squad Planner generates or reviews a capacity profile. You can use it to model how headcount changes over time — for example ramping up, sustaining, and ramping down. It is a planning aid, not the normal scheduling action.

> **Remember:** **Update timeline** is the normal action to refresh the schedule. Squad Planner and Starting Team Finder are tools for exploring and refining capacity settings, not for regenerating the timeline.

## Capacity profiles

Capacity profiles are useful for modelling how staffing changes over time.

For example, you may want to show that a project starts with one engineer, then grows to three engineers, then tapers back down.

After changing resource counts, named resources, dependencies, sequencing, or capacity profiles, the Timeline may be stale. The normal action is to click **Update timeline** to rebuild the Timeline from the latest inputs. If **Resource levelling** is enabled, the regenerated schedule respects weekly resource capacity and tries to avoid overloading resource types.

Capacity profile changes may also change Resource Profile, Commercial, and reporting views. Do not assume that changing a capacity profile automatically moves feature dates on the Timeline.

## Resource Profile

Resource Profile helps answer:

> What staffing does this estimate imply?

Use it to review:

- days by role;
- cost by role;
- FTE or equivalent staffing levels;
- named-person availability and assignment bars;
- utilisation over time;
- unallocated demand; and
- overhead or whole-project resources.

A resource can appear in Resource Profile even when it does not correspond to a single backlog task. For example, project management, governance, onboarding, and overhead-style activities may be modelled differently from delivery tasks.

## Commercial

Commercial turns the planning model into pricing.

It may include:

- day rates;
- scheduled or assigned days;
- billing basis, such as actual scheduled days or planned allocation;
- whole-project allocation;
- overheads;
- discounts; and
- tax such as GST.

The key point is:

> Price is not the same thing as effort, capacity, or demand.

For example, a person may have available capacity, but only part of that capacity may be charged to the project. Or a role may be priced using a whole-project allocation rather than only the exact days produced by task effort.

## Exports and documents

Exports should reflect the same planning facts shown in the app.

Depending on the export, it may include:

- backlog scope;
- assumptions;
- effort breakdown;
- Timeline/Gantt information;
- resource demand;
- named resources;
- Resource Profile summaries;
- commercial totals; and
- generated PDF/document sections.

If an export does not match what you expect, first check which screen or model the export is based on. Some exports are timeline-focused, some are resource-focused, and some are document-focused.

## Common questions and troubleshooting

### I changed the Timeline but Commercial did not change

Possible causes:

- the commercial view is using a billing basis that is not based only on scheduled days;
- query/data refresh has not happened yet;
- the relevant resource is priced as whole-project allocation or another billing basis;
- overheads or discounts are masking the change; or
- the change affected timing but not total chargeable effort.

### I changed a capacity profile but feature dates did not move

That is expected unless you re-run scheduling afterwards.

Use **Update timeline** to refresh the Timeline dates. If you want a levelled schedule, turn on **Resource levelling** first so the regenerated schedule respects weekly resource capacity.

If dates still do not move after that, check resource type counts, named-resource availability, dependencies, sequencing modes, and manual pins.

### Resource demand is higher than capacity

Possible causes:

- too much work is scheduled in the same week;
- resource levelling is disabled;
- dependencies or manual pins prevent the scheduler from spreading work;
- resource count or named-resource availability is too low; or
- the capacity profile or resource setup does not match the intended staffing model.

### A named resource bar is wider than expected

Check whether the bar is showing:

- the configured availability window;
- the actual assigned window;
- a whole-project allocation; or
- calculated demand segments.
Different views may show planned availability and actual demand differently.

### There are gaps in the Timeline

Gaps can come from:

- dependencies;
- resource contention;
- manual pins;
- sequential epic or feature settings;
- onboarding or buffer weeks; or
- capacity windows.

A gap is not always wrong. It may be the scheduler respecting a constraint.

### A feature starts later than expected

Check:

- does it depend on another feature or epic?
- is its parent epic sequential?
- are features inside the epic sequential?
- is the feature manually pinned?
- is the required resource type already busy?
- is resource levelling enabled?

## When to use the architecture guide

Use this user guide when you want to understand the app workflow.

Use the architecture guide when you need to debug or change implementation details, such as:

- scheduler internals;
- resource levelling behaviour;
- capacity-plan materialisation;
- weekly demand cache behaviour;
- named-resource assignment derivation;
- Resource Profile / Commercial consistency; and
- cross-surface data-flow issues.

Architecture guide: [`docs/architecture/scheduling-and-resource-model.md`](architecture/scheduling-and-resource-model.md).
