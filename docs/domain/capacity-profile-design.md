# Capacity Profile Design

Related epic: #312  
Related issues: #310, #311  
Builds on: [`planning-resource-commercial-boundaries.md`](planning-resource-commercial-boundaries.md)

## Purpose

This design separates four ideas that are currently mixed together across Timeline, Resource Profile, Commercial, Squad Planner, and exports:

1. **Role/person setup** — what roles, people, or planned resources exist.
2. **Capacity profile** — how much of each role/person/resource is available over time.
3. **Planning assignment** — how scheduled work consumes that availability.
4. **Billing basis** — what Commercial charges for.

The goal is to support both simple projects and larger programmes without making resource handover confusing.

## Design principles

- Use plain English in UI, exports, and generated documents.
- Do not expose developer terms such as `SyntheticSlot`, `PricingModel`, or `ActualAllocatedDays`.
- Do not imply that variable capacity means multiple people.
- Keep planning and pricing separate.
- Treat exports as handover artefacts for delivery, SOW, commercial, and resourcing users.

## Plain-English terms

| Current/internal term | Preferred term |
| --- | --- |
| Resource type | Role |
| Named resource | Named person / named resource |
| Synthetic slot | Planned resource |
| Pricing model | Billing basis |
| Capacity Plan | Capacity profile |
| Timeline allocation | Availability window |
| Full Project | Whole-project allocation |
| Allocated days | Assigned days in Resource Profile; Billable days in Commercial |
| Actual allocated days | Assigned days in Resource Profile; Billable days in Commercial |
| T&M | Demand-following assignment, or Bill actual scheduled days when used commercially |
| Pro-rata | Bill planned allocation |

## Core concepts

### Role

A role is the type of person or capability required, such as `Principal Consultant - Security` or `Senior Engineer - Data, AI & IoT`.

### Resource identity

A resource row should say whether it represents:

- **Named person** — a real person is known.
- **Planned resource** — a placeholder resource not yet mapped to a real person.
- **Role-level capacity** — capacity is planned at the role level only.

### Capacity profile

A capacity profile describes availability over time.

Examples:

```text
Security Consultant 1: W1-W14 at 100%
```

```text
Security Consultant 1:
- W1-W4 at 50%
- W5-W10 at 100%
- W11-W14 at 25%
```

This is one planned resource with changing capacity, not three different people.

Capacity profile sources should include:

- fixed FTE;
- availability window;
- segmented profile;
- Squad Planner generated profile;
- manual adjustment;
- imported profile in future.

### Planning assignment

Planning assignment describes how scheduled work consumes availability.

Suggested assignment methods:

- **Demand-following** — assign only scheduled demand, up to available capacity.
- **Planned capacity** — use the planned capacity profile, even when demand is lower.
- **Manual assignment** — user overrides a resource or period.

Resource Profile should show this as **Assigned work**, **Assigned weeks**, and **Assigned days**.

### Billing basis

Billing basis describes what Commercial charges for.

Suggested billing bases:

- **Bill actual scheduled days**.
- **Bill planned allocation**.
- **Bill whole-project allocation**.
- **Exclude / non-billable**.

Commercial should show **Billing basis** and **Billable days**, not vague allocation language.

## Product workflow

### Simple project

Most estimates should follow a simple path:

```text
Set role counts / capacity
Enable Resource levelling if needed
Update Timeline
Review Resource Profile and Commercial
Export handover artefacts
```

### Larger programme

Larger programmes may need shaped capacity over time:

```text
Use Starting Team Finder to find a sensible initial squad size
Use Squad Planner to generate a capacity profile
Review and adjust the capacity profile
Update Timeline
Review Resource Profile, Commercial, and exports
```

Starting Team Finder should be described as a helper for Squad Planner. Squad Planner should be described as a capacity-profile generator, not as the normal Timeline refresh action.

## UI direction

### Timeline

- Make **Update Timeline** the canonical scheduling action.
- Keep **Resource levelling** as an option for Update Timeline.
- Remove or hide **Level current timeline** from the normal workflow unless it is deliberately kept as an experimental optimiser.
- Make stale-state messaging deterministic: inputs changed, so update the timeline.

### Resource Counts / Scheduling Capacity

Keep this panel simple:

- role;
- count;
- hours/day;
- capacity basis summary.

Move detailed named-resource capacity profile editing out of the compact Resource Counts table.

### Capacity Profile editor

Create a clearer editor for:

- fixed FTE;
- start/end availability windows;
- segmented capacity over time;
- Squad Planner generated profiles;
- manual edits.

### Resource Profile

Resource Profile should explain staffing and assignment:

- role summary;
- capacity profile;
- assigned work;
- commercial context where useful.

Use plain labels such as **Capacity profile**, **Assigned work**, **Assigned days**, **Named person**, and **Planned resource**.

### Commercial

Commercial should explain pricing:

- planning basis, for context;
- billing basis;
- billable days;
- rate;
- subtotal.

Commercial should not look like the owner of planning capacity or assignment.

## Resource Profile export requirements

The export must be understandable to SOW and resourcing users.

It should distinguish:

- role;
- named person vs planned resource vs role-level capacity;
- capacity profile;
- assigned work;
- billing basis;
- billable days.

It should not use internal headers such as `SyntheticSlot`, `PricingModel`, or `ActualAllocatedDays`.

Example handover row wording:

```text
Role: Principal Consultant - Security
Resource: Security Consultant 1
Resource identity: Planned resource
Capacity profile: W1-W4 50%; W5-W10 100%; W11-W14 25%
Assignment method: Demand-following
Assigned days: 52.8
Billing basis: Bill actual scheduled days
Billable days: 52.8
```

## Implementation slices

1. **Documentation update** — update domain docs and user-facing terminology.
2. **UI language cleanup** — rename confusing labels without changing behaviour.
3. **Timeline workflow cleanup** — address #310 and make Update Timeline canonical.
4. **Resource Counts cleanup** — address #311 and split simple capacity from detailed profile editing.
5. **Export cleanup** — redesign Resource Profile export around plain-English handover sections.
6. **First-class capacity profiles** — add segmented capacity profile model and editor.
7. **Squad Planner alignment** — make Squad Planner generate editable capacity profiles.

## Open decisions

- Should capacity profiles always affect scheduling, or only when selected as the capacity source?
- Should role-level capacity profiles be allowed without planned resources?
- Should Squad Planner generate role-level profiles first, then let users map them to planned resources?
- Should billing basis be editable only in Commercial?
- Do we need a legacy resource-profile export during transition?
- Should Quick schedule be renamed to Update Timeline in the first implementation slice?
