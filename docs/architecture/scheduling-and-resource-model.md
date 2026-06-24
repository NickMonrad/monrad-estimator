# Scheduling and Resource Model

This guide explains how Monrad Estimator turns backlog effort into a scheduled timeline, weekly resource demand, named-resource assignments, resource profile summaries, commercial totals, and document/export outputs.

It is intentionally architecture-focused rather than user-guide focused. Use it when investigating mismatches between Timeline, Resource Profile, Commercial, CSV, and PDF output.

## Source-of-truth boundaries

The app deliberately separates four related but different concepts:

| Concept | Primary source | Owned by | Notes |
|---|---|---|---|
| Delivery effort | `Task.hoursEffort`, `Task.durationDays`, task `resourceTypeId` | Backlog / Effort Review | This is the estimated work required to deliver the scoped backlog. |
| Scheduling reality | `TimelineEntry`, `StoryTimelineEntry`, `Project.weeklyDemandCache` | Timeline Planner | This is where work lands over time after dependencies, manual overrides, and optional resource levelling. |
| Resource capacity / staffing shape | `ResourceType`, `NamedResource`, `CapacityPlan*` | Resource Profile / planning controls | This describes which role/person/slot capacity is available by week. |
| Commercial pricing | `ResourceType.dayRate`, `NamedResource.pricingModel`, `ProjectOverhead`, `ProjectDiscount`, tax fields | Commercial / Resource Profile presentation | Pricing may use scheduled actual days, pro-rata allocation, full-project allocation, discounts, or overheads. It should not be treated as identical to effort or capacity. |

```mermaid
flowchart LR
  subgraph Backlog[Backlog / Effort Inputs]
    Epic[Epic]
    Feature[Feature]
    Story[UserStory]
    Task[Task effort<br/>hoursEffort + durationDays + resourceType]
    Epic --> Feature --> Story --> Task
  end

  subgraph Capacity[Resource Capacity / Staffing]
    RT[ResourceType<br/>count + hoursPerDay + dayRate]
    NR[NamedResource<br/>mode + percent + windows]
    CP[CapacityPlan<br/>period headcount]
    RT --> NR
    CP --> RT
  end

  subgraph Timeline[Timeline / Planning Reality]
    Sched[runScheduler]
    TE[TimelineEntry<br/>feature start/duration]
    STE[StoryTimelineEntry<br/>story start/duration]
    Cache[Project.weeklyDemandCache<br/>scheduler demand cache]
    Sched --> TE
    Sched --> STE
    Sched --> Cache
  end

  subgraph Shared[Shared Planning Read Model]
    PRM[buildProjectPlanningModel]
    Demand[weeklyDemand]
    Assign[derived named-resource assignments]
    WCap[weeklyCapacity]
  end

  subgraph Outputs[Consumers]
    Gantt[Timeline Gantt]
    Histogram[Resource Demand histogram]
    Profile[Resource Profile]
    Commercial[Commercial totals]
    Docs[CSV / PDF / Documents]
  end

  Task --> Sched
  RT --> Sched
  NR --> Sched
  CP --> Sched
  TE --> PRM
  STE --> PRM
  Cache --> PRM
  RT --> PRM
  NR --> PRM
  CP --> PRM
  PRM --> Demand
  PRM --> WCap
  PRM --> Assign
  Demand --> Histogram
  Demand --> Profile
  Assign --> Gantt
  Assign --> Profile
  Assign --> Commercial
  WCap --> Histogram
  TE --> Gantt
  STE --> Gantt
  Profile --> Docs
  Commercial --> Docs
```

## Core entity relationship diagram

This ERD focuses on the scheduling/resource-planning domain. It omits unrelated auth, organisation, customer, template, and generated-document details except where they materially affect planning or commercial calculations.

```mermaid
erDiagram
  PROJECT ||--o{ EPIC : owns
  EPIC ||--o{ FEATURE : owns
  FEATURE ||--o{ USER_STORY : owns
  USER_STORY ||--o{ TASK : owns

  PROJECT ||--o{ RESOURCE_TYPE : scopes
  RESOURCE_TYPE ||--o{ TASK : estimates
  RESOURCE_TYPE ||--o{ NAMED_RESOURCE : has
  RESOURCE_TYPE ||--o{ PROJECT_OVERHEAD : prices
  RESOURCE_TYPE ||--o{ PROJECT_DISCOUNT : discounts

  FEATURE ||--o| TIMELINE_ENTRY : scheduled_by
  USER_STORY ||--o| STORY_TIMELINE_ENTRY : scheduled_by
  PROJECT ||--o{ TIMELINE_ENTRY : has
  PROJECT ||--o{ STORY_TIMELINE_ENTRY : has

  EPIC ||--o{ EPIC_DEPENDENCY : dependent
  EPIC ||--o{ EPIC_DEPENDENCY : predecessor
  FEATURE ||--o{ FEATURE_DEPENDENCY : dependent
  FEATURE ||--o{ FEATURE_DEPENDENCY : predecessor
  USER_STORY ||--o{ STORY_DEPENDENCY : dependent
  USER_STORY ||--o{ STORY_DEPENDENCY : predecessor

  PROJECT ||--o{ CAPACITY_PLAN : has
  CAPACITY_PLAN ||--o{ CAPACITY_PLAN_PERIOD : has
  CAPACITY_PLAN_PERIOD ||--o{ CAPACITY_PLAN_ENTRY : has
  RESOURCE_TYPE ||--o{ CAPACITY_PLAN_ENTRY : plans

  PROJECT ||--o{ PROJECT_OVERHEAD : has
  PROJECT ||--o{ PROJECT_DISCOUNT : has

  PROJECT {
    string id PK
    float hoursPerDay
    int onboardingWeeks
    int bufferWeeks
    datetime startDate
    json weeklyDemandCache "derived scheduler cache"
    float taxRate
    string taxLabel
  }

  EPIC {
    string id PK
    string projectId FK
    int order
    string featureMode
    string scheduleMode
    int timelineStartWeek
    boolean isActive
  }

  FEATURE {
    string id PK
    string epicId FK
    int order
    string featureMode
    int timelineStartWeek
    string timelineColour
    boolean isActive
  }

  USER_STORY {
    string id PK
    string featureId FK
    int order
    boolean isActive
  }

  TASK {
    string id PK
    string userStoryId FK
    string resourceTypeId FK
    float hoursEffort
    float durationDays
    int order
  }

  RESOURCE_TYPE {
    string id PK
    string projectId FK
    string name
    string category
    int count
    float hoursPerDay
    float dayRate
    string allocationMode
    float allocationPercent
    float allocationStartWeek
    float allocationEndWeek
  }

  NAMED_RESOURCE {
    string id PK
    string resourceTypeId FK
    string name
    int startWeek
    int endWeek
    int allocationPct
    string allocationMode
    float allocationPercent
    float allocationStartWeek
    float allocationEndWeek
    string pricingModel
  }

  TIMELINE_ENTRY {
    string id PK
    string projectId FK
    string featureId FK "unique"
    float startWeek
    float durationWeeks
    boolean isManual
  }

  STORY_TIMELINE_ENTRY {
    string id PK
    string projectId FK
    string storyId FK "unique"
    float startWeek
    float durationWeeks
    boolean isManual
  }

  EPIC_DEPENDENCY {
    string epicId FK
    string dependsOnId FK
  }

  FEATURE_DEPENDENCY {
    string featureId FK
    string dependsOnId FK
  }

  STORY_DEPENDENCY {
    string storyId FK
    string dependsOnId FK
  }

  CAPACITY_PLAN {
    string id PK
    string projectId FK
    string name
    int targetWeeks
    int periodWeeks
    int maxDelta
    boolean isActive
    float totalCost
    float deliveryWeeks
  }

  CAPACITY_PLAN_PERIOD {
    string id PK
    string planId FK
    int periodIndex
    int startWeek
    int endWeek
  }

  CAPACITY_PLAN_ENTRY {
    string id PK
    string periodId FK
    string resourceTypeId FK
    float headcount
    float demandFTE
    float utilisationPct
  }

  PROJECT_OVERHEAD {
    string id PK
    string projectId FK
    string resourceTypeId FK
    string type
    float value
  }

  PROJECT_DISCOUNT {
    string id PK
    string projectId FK
    string resourceTypeId FK
    string type
    float value
  }
```

### Source records vs derived/cache records

| Record | Classification | Why it matters |
|---|---|---|
| `Task`, `Epic`, `Feature`, `UserStory` | Source | Owns scope and effort input. |
| `ResourceType`, `NamedResource`, `CapacityPlan*` | Source | Owns capacity/staffing configuration. |
| `ProjectOverhead`, `ProjectDiscount`, rate/tax fields | Source | Owns commercial adjustments. |
| `TimelineEntry`, `StoryTimelineEntry` | Persisted scheduler output | Stores the current schedule, including manual pins. These are planning outputs, not original effort. |
| `Project.weeklyDemandCache` | Derived/cache | Stores scheduler weekly consumption so consumers do not fall back to an approximate uniform spread when resource levelling produced a more specific demand shape. |
| `ProjectPlanningModel` | Read model only | Not persisted. It merges source records, timeline outputs, cache, and fallback calculations for consumers. |
| Named-resource assignments from `deriveNamedResourceAssignments` | Derived | Not persisted. They map weekly demand onto real/synthetic named resources for Timeline, Resource Profile, and Commercial presentation. |

## Scheduling data flow

```mermaid
flowchart TD
  Request[POST /api/projects/:id/timeline/schedule]
  Project[Load Project<br/>hoursPerDay, startDate, buffer/onboarding]
  Backlog[Load active Epics, Features, Stories, Tasks]
  Deps[Load EpicDependency + FeatureDependency + StoryDependency]
  Manual[Load manual TimelineEntry + StoryTimelineEntry]
  ResourceTypes[Load ResourceType + NamedResource]
  CapacityPlan[Load active CapacityPlan + periods + entries]
  Materialize[materializeCapacityPlanResources]
  SchedulerInput[SchedulerInput]
  Scheduler[runScheduler]
  FeatureSchedule[featureSchedule]
  StorySchedule[storySchedule]
  Consumption[weeklyConsumptionMap]
  Persist[Upsert TimelineEntry + StoryTimelineEntry<br/>write Project.weeklyDemandCache]
  Response[buildResponse / buildProjectPlanningModel]
  Consumers[Timeline UI + Resource Profile + Commercial + CSV/PDF]

  Request --> Project
  Project --> Backlog
  Project --> Deps
  Project --> Manual
  Project --> ResourceTypes
  Project --> CapacityPlan
  CapacityPlan --> Materialize
  Backlog --> SchedulerInput
  Deps --> SchedulerInput
  Manual --> SchedulerInput
  ResourceTypes --> SchedulerInput
  Materialize --> SchedulerInput
  SchedulerInput --> Scheduler
  Scheduler --> FeatureSchedule
  Scheduler --> StorySchedule
  Scheduler --> Consumption
  FeatureSchedule --> Persist
  StorySchedule --> Persist
  Consumption --> Persist
  Persist --> Response
  ResourceTypes --> Response
  Materialize --> Response
  Response --> Consumers
```

## Scheduler sequence

```mermaid
sequenceDiagram
  participant Route as timeline.ts /schedule
  participant DB as Prisma
  participant Scheduler as runScheduler
  participant Cap as getWeeklyCapacity
  participant Store as Timeline tables + weeklyDemandCache

  Route->>DB: Load project, active backlog, resource types, manual entries, dependencies
  Route->>Scheduler: Build SchedulerInput(resourceLevel flag)
  Scheduler->>Scheduler: Flatten active features and stories
  Scheduler->>Scheduler: Build manual feature/story lookup maps
  Scheduler->>Scheduler: Compute parallel-epic minimum span floor
  Scheduler->>Scheduler: Build feature dependency graph
  Scheduler->>Scheduler: Add sequential feature edges where epic.featureMode = sequential
  Scheduler->>Scheduler: Add inter-epic schedule edges where scheduleMode = sequential
  Scheduler->>Scheduler: Add explicit FeatureDependency and EpicDependency edges
  Scheduler->>Scheduler: Topological sort with deterministic order priority
  Scheduler->>Scheduler: Calculate feature duration by bottleneck resource type
  Scheduler->>Scheduler: Preserve manual feature pins
  alt resourceLevel = true
    Scheduler->>Cap: Read weekly capacity by resource type/week
    Scheduler->>Scheduler: Simulate work in 0.2-week steps
    Scheduler->>Scheduler: Allocate small/nearly-done work greedily to avoid sparse tails
    Scheduler->>Scheduler: Emit weeklyConsumptionMap
  else resourceLevel = false
    Scheduler->>Scheduler: Use topological schedule without simulated weekly consumption
  end
  Scheduler->>Scheduler: Generate story schedule inside feature windows
  Scheduler->>Scheduler: Compute parallel warnings
  Scheduler-->>Route: featureSchedule, storySchedule, weeklyConsumptionMap, warnings
  Route->>Store: Upsert non-manual feature/story entries and preserve manual ones
  Route->>Store: Save weeklyDemandCache from weeklyConsumptionMap
  Route-->>Route: Build response / planning read model
```

## Feature duration and dependency rules

The functional shortcut `sum(task days) / 5` is no longer sufficient to describe current scheduling.

Current feature duration is driven by the bottleneck resource type:

1. Active stories only are considered.
2. Tasks are grouped by `resourceTypeId`.
3. Each task's effective days are calculated from `durationDays` when present, otherwise from `hoursEffort / effectiveHoursPerDay`.
4. For each resource type, person-days are divided by the configured resource type `count`.
5. The largest resource-type duration becomes the feature duration floor, with a minimum of `0.2` weeks.
6. For parallel epics, a shared-resource minimum-span floor is applied so parallel features cannot complete faster than total demand divided by available weekly capacity.

```mermaid
flowchart TD
  Tasks[Active tasks in feature]
  Group[Group tasks by resourceTypeId]
  EffectiveDays[Calculate effective days<br/>durationDays override or hoursEffort / hoursPerDay]
  Divide[Divide each RT demand by ResourceType.count]
  Bottleneck[Take max RT days]
  Weeks[Convert days to weeks<br/>max 0.2 minimum]
  Parallel{Parent epic featureMode = parallel?}
  Floor[Apply parallel epic shared-resource min span]
  Duration[Feature durationWeeks]

  Tasks --> Group --> EffectiveDays --> Divide --> Bottleneck --> Weeks --> Parallel
  Parallel -- yes --> Floor --> Duration
  Parallel -- no --> Duration
```

Dependency handling is layered:

| Dependency type | Effect |
|---|---|
| Sequential features within an epic | Adds edges from previous feature to next feature, unless the predecessor is manually pinned. |
| Inter-epic sequential mode | Adds edges from features in earlier epics to the first/current target features in later epics unless the later epic is explicitly parallel or pinned. |
| `FeatureDependency` | Adds explicit feature-to-feature hard constraints. |
| `EpicDependency` | Adds hard constraints from every feature in the predecessor epic to every feature in the dependent epic. |
| `StoryDependency` | Respected when story bars are scheduled/rendered inside feature windows. |
| Manual feature entries | Start/duration are preserved. The scheduler does not move them. |
| Manual story entries | Story start is preserved. |

## Resource capacity calculation

`getWeeklyCapacity` returns capacity in hours for one resource type in one week. Consumers usually convert it back to days by dividing by the resource type's effective hours/day.

```mermaid
flowchart TD
  RT[ResourceType<br/>count, hoursPerDay]
  Week[Week number]
  Named[NamedResource list]
  Each[For each named resource]
  Window{week within<br/>startWeek/endWeek?}
  Mode{allocationMode}
  Effort[EFFORT<br/>100% capacity]
  Full[FULL_PROJECT<br/>allocationPercent all weeks in window]
  Timeline[TIMELINE<br/>allocationPercent only inside allocationStart/End if set]
  CapPlan[CAPACITY_PLAN<br/>capacity from materialized plan]
  SumNamed[Sum named capacity hours]
  Phantom[Phantom slots<br/>max(0, ResourceType.count - namedResources.length) * hpd * 5]
  Total[Weekly capacity hours]

  RT --> Named --> Each --> Window
  Week --> Window
  Window -- no --> SumNamed
  Window -- yes --> Mode
  Mode --> Effort --> SumNamed
  Mode --> Full --> SumNamed
  Mode --> Timeline --> SumNamed
  Mode --> CapPlan --> SumNamed
  RT --> Phantom
  SumNamed --> Total
  Phantom --> Total
```

Important details:

- `ResourceType.count` is the effective headcount for scheduling capacity.
- Named resources are availability/allocation overlays for known people/slots.
- If `count` is greater than the number of named resources, the scheduler treats the extra slots as full-availability phantom staff.
- `CAPACITY_PLAN` mode can materialize capacity-plan periods into slot windows and weekly headcount. If persisted named resources do not match the active plan, capacity-plan fallback creates synthetic slots for planning/read-model consumers.

## Resource levelling and contention

When `resourceLevel` is enabled, `runScheduler` simulates work in small time steps and writes actual weekly consumption into `weeklyConsumptionMap`. This is what later becomes `Project.weeklyDemandCache`.

```mermaid
flowchart LR
  subgraph Input[Competing work]
    A[Feature A<br/>same RT<br/>large remaining effort]
    B[Feature B<br/>same RT<br/>small remaining effort]
  end

  Capacity[Weekly RT capacity]
  Sim[0.2 week simulation step]
  Sort[Sort competing features<br/>by remaining hours ascending]
  Greedy[Allocate each feature up to remaining step capacity]
  Packed[Dense weekly demand<br/>small work finishes quickly]
  Cache[weeklyDemandCache]

  A --> Sim
  B --> Sim
  Capacity --> Sim
  Sim --> Sort --> Greedy --> Packed --> Cache
```

The sparse-sliver regression from #283 came from proportional allocation leaving tiny remnants spread across many later weeks. PR #290 changed the simulation so smaller/nearly-done competing work is packed greedily within available step capacity. PR #291 separately fixed Timeline named-resource window rendering so EFFORT-mode dashed windows fall back to actual allocation ranges instead of implying broad continuous assignment.

## Shared planning read model

`buildProjectPlanningModel` is the canonical read model for planning-derived facts. It does not own commercial pricing rules and it does not change the backlog effort source records.

```mermaid
flowchart TD
  TimelineEntries[TimelineEntry + StoryTimelineEntry]
  Cache[Project.weeklyDemandCache]
  Fallback[Fallback uniform demand<br/>from entries if cache missing]
  Convert[convertWeeklyDemandCache<br/>ID/name compatible]
  Merge[mergeWeeklyDemand<br/>cache wins over fallback horizon]
  Capacity[computeWeeklyCapacity]
  Assign[deriveNamedResourceAssignments]
  Model[ProjectPlanningModel]

  TimelineEntries --> Fallback
  Cache --> Convert
  Convert --> Merge
  Fallback --> Merge
  Merge --> Capacity
  Merge --> Assign
  Capacity --> Model
  Assign --> Model
  TimelineEntries --> Model
```

Consumers should prefer this read model or its helpers instead of duplicating demand/capacity derivation.

## Named-resource assignment derivation

`deriveNamedResourceAssignments` converts weekly demand rows into per-named-resource actual allocations.

```mermaid
flowchart TD
  Demand[Weekly demand by resource type]
  RT[ResourceType + NamedResource records]
  CP[Materialized capacity plan]
  Effective[Build effective named resources]
  Synthetic[Add synthetic resources when count exceeds named resources]
  WeeklyCap[Calculate named resource capacity per week]
  Allocate[Allocate demand to resources<br/>prefer continuing previous-week assignment,<br/>then real before synthetic,<br/>then least allocated]
  Segments[Build actualAllocationSegments]
  Output[Derived named-resource assignment map]

  Demand --> Allocate
  RT --> Effective
  CP --> Effective
  Effective --> Synthetic --> WeeklyCap --> Allocate --> Segments --> Output
```

Assignment output includes:

- `actualAllocatedDays`
- `actualAllocationStartWeek`
- `actualAllocationEndWeek`
- `actualAllocatedWeeks`
- `actualAllocationSegments`
- `unallocatedDays` by resource type

This is derived presentation data. It should not be confused with persisted named-resource configuration.

## Cross-surface consistency trace

```mermaid
flowchart LR
  Task[Task effort<br/>source]
  Scheduler[runScheduler<br/>planning engine]
  Entries[TimelineEntry / StoryTimelineEntry<br/>schedule output]
  Demand[weeklyDemandCache / weeklyDemand<br/>resource demand output]
  Assign[Derived named-resource assignments]
  Timeline[Timeline Gantt<br/>bars + warnings]
  Histogram[Resource Demand histogram<br/>demand vs capacity]
  Profile[Resource Profile<br/>FTE, days, cost summaries]
  Commercial[Commercial<br/>pricing basis, discounts, GST]
  Export[CSV / PDF / Documents]

  Task --> Scheduler
  Scheduler --> Entries
  Scheduler --> Demand
  Entries --> Timeline
  Demand --> Histogram
  Demand --> Assign
  Assign --> Timeline
  Assign --> Profile
  Assign --> Commercial
  Profile --> Export
  Commercial --> Export
  Timeline --> Export
```

### Where mismatches usually enter

| Symptom | Likely boundary to inspect |
|---|---|
| Timeline bars move but Resource Profile/Commercial does not change | Query invalidation or a consumer bypassing `ProjectPlanningModel`. |
| Resource Demand differs from named-resource bars | `weeklyDemandCache`, fallback weekly demand, or `deriveNamedResourceAssignments`. |
| Commercial totals differ from actual scheduled days | Pricing basis (`ACTUAL_DAYS` vs `PRO_RATA`), allocation mode, or overhead/discount path. |
| Named resource appears allocated across empty weeks | Rendering using broad start/end windows instead of `actualAllocationSegments` or actual allocation start/end. |
| Over-capacity weeks remain despite spare adjacent capacity | Resource levelling simulation, dependency constraints, manual overrides, or capacity windows. |
| Cloned/copied project loses planning state | Clone path missing dependencies, timeline entries, capacity plans, or `weeklyDemandCache`. |

## Behavioural checklist for changes

When changing scheduling/resource code, verify the following path explicitly:

1. Does the change alter effort source records (`Task`, `hoursEffort`, `durationDays`, `resourceTypeId`)?
2. Does the change alter scheduling outputs (`TimelineEntry`, `StoryTimelineEntry`, `weeklyDemandCache`)?
3. Does the change alter capacity (`ResourceType.count`, `NamedResource`, `CapacityPlan*`, allocation mode/window/percent)?
4. Does the change alter pricing (`dayRate`, `pricingModel`, overheads, discounts, tax)?
5. Are Timeline, Resource Profile, Commercial, CSV, and PDF consuming the same planning facts?
6. Are manual overrides preserved?
7. Are inactive epics/features/stories excluded consistently?
8. Are cache invalidation and fallback demand behaviour still correct?

## Implementation map

| Area | Main files |
|---|---|
| Pure scheduler | `server/src/lib/scheduler.ts` |
| Greedy leveller / optimiser support | `server/src/lib/leveller.ts`, `server/src/lib/optimiser.ts` |
| Timeline API and persistence | `server/src/routes/timeline.ts` |
| Shared planning read model | `server/src/lib/projectPlanningModel.ts` |
| Capacity-plan materialisation | `server/src/lib/capacityPlanMaterialisation.ts` |
| Named-resource assignment derivation | `server/src/lib/namedResourceAssignments.ts` |
| Resource profile/commercial calculations | `server/src/routes/resourceProfile.ts` |
| Timeline UI rendering | `client/src/pages/TimelinePage.tsx`, `client/src/components/timeline/*` |
| Database schema | `server/prisma/schema.prisma` |
