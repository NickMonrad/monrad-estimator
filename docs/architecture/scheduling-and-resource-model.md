# Scheduling and Resource Model

This guide explains how Monrad Estimator turns backlog effort into a scheduled timeline, weekly resource demand, named-resource assignments, resource profile summaries, commercial totals, and document/export outputs.

It is intentionally architecture-focused rather than user-guide focused. Use it when investigating mismatches between Timeline, Resource Profile, Commercial, CSV, and PDF output.

## Plain-English glossary

A quick reference for terms used throughout this guide:

| Term | What it means |
|---|---|
| **Backlog effort** | The estimated work to do — stored as hours and days on each Task, grouped by resource type. |
| **Schedule / timeline** | When the work happens — feature and story start weeks and durations, plus optional manual pinning. |
| **Capacity** | Who or what role is available in each week — defined by resource type *count* × *hoursPerDay*, optionally shaped by named resources or a capacity plan. |
| **Demand** | How much work each role needs to do each week — produced by the scheduler and cached in `weeklyDemandCache`. |
| **Named resource** | A real person or named staffing slot attached to a resource type. Has its own allocation mode, percentage, and optional window. |
| **Weekly demand cache** | A saved week-by-week breakdown of demand from the last scheduler run. Consumers use it instead of falling back to a rough uniform spread. |
| **Read model** | A combined view built from multiple source records for use by screens and exports. Not a new source of truth — just a query helper. |
| **Derived** | Calculated from other data rather than manually entered. Named-resource assignments, weekly capacity, and the demand cache are all derived. |

## Source-of-truth boundaries

The app deliberately separates four related but different concepts:

| Concept | Primary source | Owned by | Notes |
|---|---|---|---|
| Delivery effort | `Task.hoursEffort`, `Task.durationDays`, task `resourceTypeId` | Backlog / Effort Review | This is the estimated work required to deliver the scoped backlog. |
| Scheduling reality | `TimelineEntry`, `StoryTimelineEntry`, `Project.weeklyDemandCache` | Timeline Planner | This is where work lands over time after dependencies, manual overrides, and optional resource levelling. |
| Resource capacity / staffing shape | `ResourceType`, `NamedResource` | Resource Profile / planning controls | This describes which role/person/slot capacity is available by week. `CapacityPlan` is turned into week-by-week staffing numbers and named-resource windows for the response/shared planning read model, but is **not** passed directly into `runScheduler`. The scheduler currently receives raw `ResourceType.count` values. |
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
    Mat[Capacity plan →<br/>week-by-week staffing facts]
    RT --> NR
    CP --> Mat
  end

  subgraph Timeline[Timeline / Planning Reality]
    Sched[runScheduler]
    TE[TimelineEntry<br/>feature start/duration]
    STE[StoryTimelineEntry<br/>story start/duration]
    Cache[Project.weeklyDemandCache<br/>saved week-by-week demand]
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
  TE --> PRM
  STE --> PRM
  Cache --> PRM
  RT --> PRM
  NR --> PRM
  Mat --> PRM
  Mat --> Profile
  Mat --> Commercial
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

This section is mainly for developers. It shows the database records involved in scheduling and resource planning.

The ERD focuses on the scheduling/resource-planning domain. It omits unrelated auth, organisation, customer, template, and generated-document details except where they materially affect planning or commercial calculations.
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

The schedule endpoint is one focused command (`scheduleProject`), which:

1. **Verify and validate** — ownership check (missing/unauthorised project → 404), planning state guard (NEEDS_REPLAN → 409 REPLAN_REQUIRED), and request input validation (400 on a malformed start date).
2. **Load** the project settings, active backlog, dependencies, manual overrides, resource types, named resources, and the active capacity plan.
3. **Run the scheduler** (`runScheduler`) to decide each feature's start week and duration, each story's placement, and the weekly demand per resource type.
4. **Save atomically** — feature and story `TimelineEntry`/`StoryTimelineEntry` upserts, removal of inactive/superseded generated entries, the applicable project start-date change, and the week-by-week demand cache (`Project.weeklyDemandCache`) all commit in one Prisma transaction. Any failure rolls back the entire update and leaves the previous persisted schedule and cache intact.
5. **Reload** the canonical planning read model (`buildProjectPlanningModel`) and return it, so the post-schedule response is produced by exactly the same derivation and DTO mapping path as `GET /timeline`.

The Mermaid diagram below shows the same flow in more detail.

```mermaid
flowchart TD
  Request[POST /api/projects/:id/timeline/schedule]
  Guard[scheduleProject: ownership + planning state + input validation]
  Project[Load Project<br/>hoursPerDay, startDate, buffer/onboarding]
  Backlog[Load active Epics, Features, Stories, Tasks]
  Deps[Load EpicDependency + FeatureDependency + StoryDependency]
  Manual[Load manual TimelineEntry + StoryTimelineEntry]
  ResourceTypes[Load ResourceType + NamedResource]
  CapacityPlan[Load active CapacityPlan + periods + entries]
  Resolve[resolveSchedulerCapacity — profile-first DTOs]
  SchedulerInput[SchedulerInput]
  Scheduler[runScheduler]
  FeatureSchedule[featureSchedule]
  StorySchedule[storySchedule]
  Consumption[weeklyConsumptionMap]
  Tx[One Prisma transaction: upsert feature + story entries,<br/>remove inactive entries, project start date, weeklyDemandCache]
  Reload[buildProjectPlanningModel = loadProjectPlanningInputs + deriveProjectPlanningModel]
  Response[mapPlanningModelToTimelineResponse]
  Consumers[Timeline UI + Resource Profile + Commercial + CSV/PDF]

  Request --> Guard
  Guard --> Project
  Project --> Backlog
  Project --> Deps
  Project --> Manual
  Project --> ResourceTypes
  Project --> CapacityPlan
  CapacityPlan --> Resolve
  ResourceTypes --> Resolve
  Backlog --> SchedulerInput
  Deps --> SchedulerInput
  Manual --> SchedulerInput
  Resolve --> SchedulerInput
  SchedulerInput --> Scheduler
  Scheduler --> FeatureSchedule
  Scheduler --> StorySchedule
  Scheduler --> Consumption
  FeatureSchedule --> Tx
  StorySchedule --> Tx
  Consumption --> Tx
  Tx --> Reload
  Reload --> Response
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

`loadProjectPlanningInputs` + `deriveProjectPlanningModel` (composed by `buildProjectPlanningModel`) is the single place where Timeline, Resource Profile, Commercial, and exports get the same calculated planning view. The pure derivation (`deriveProjectPlanningModel`) imports no Prisma or Express and computes the planning window, weekly demand, weekly capacity, named-resource assignments, and planning warnings from plain inputs; database loading is a thin adapter. The post-schedule response reuses the exact same derivation and DTO mapping path as `GET /timeline`. It does not own commercial pricing rules and it does not change the backlog effort source records.

```mermaid
flowchart TD
  Load[loadProjectPlanningInputs<br/>project, resource types, capacity, entries, deps]
  TimelineEntries[TimelineEntry + StoryTimelineEntry]
  Cache[Project.weeklyDemandCache]
  Fallback[Fallback demand from feature entries<br/>buildFallbackWeeklyDemand]
  Convert[convertWeeklyDemandCache<br/>ID/name compatible]
  Merge[mergeWeeklyDemand<br/>cache wins over fallback horizon]
  Capacity[computeWeeklyCapacity]
  Assign[deriveNamedResourceAssignments]
  Model[ProjectPlanningModel]

  Load --> TimelineEntries
  Load --> Cache
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

Consumers should prefer this read model or its helpers instead of duplicating demand/capacity derivation. Timeline and Resource Profile map the same canonical model into their own DTOs.

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

This is calculated display data. It should not be confused with persisted named-resource configuration.

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
| Transactional scheduling command | `server/src/lib/scheduleProject.ts` |
| Shared planning read model | `server/src/lib/projectPlanningModel.ts` (`loadProjectPlanningInputs` / `deriveProjectPlanningModel` / `buildProjectPlanningModel`) |
| Capacity-plan materialisation | `server/src/lib/capacityPlanMaterialisation.ts` |
| Named-resource assignment derivation | `server/src/lib/namedResourceAssignments.ts` |
| Resource profile/commercial calculations | `server/src/routes/resourceProfile.ts` |
| Timeline UI rendering | `client/src/pages/TimelinePage.tsx`, `client/src/components/timeline/*` |
| Database schema | `server/prisma/schema.prisma` |

## Profile-first scheduler-capacity resolution

Issue #362 introduced `server/src/lib/schedulerCapacityResolver.ts` — the single shared
boundary for loading and resolving project capacity into scheduler-facing DTOs.
All scheduler consumers (Timeline schedule/GET, Optimiser, Squad Planner,
named-resource assignments) use the same resolved capacity through this adapter.

### Precedence order

For each physical capacity owner (role-level or named/planned resource):

1. **Persisted owner-specific `CapacityProfile`** (`resolutionSource: 'PROFILE'`) — authoritative.
2. **Active Capacity Plan materialisation** (`resolutionSource: 'ACTIVE_CAPACITY_PLAN`) —
   fallback when no valid persisted profile applies.
3. **Legacy compatibility fields** (`resolutionSource: 'LEGACY'`) — final fallback
   from `ResourceType`/`NamedResource` columns.

A valid persisted profile wins even when legacy compatibility fields disagree.

### Segments and gaps

Capacity segments are ordered and preserve:
- exact percentage boundaries per week;
- zero-capacity gaps between segments;
- fractional discontinuous periods.

Capacity is never flattened into a scalar start/end/percentage window.
Legacy allocation fields (`startWeek`, `endWeek`, `allocationPercent`) are consulted
only for `LEGACY`-source resources.

### Squad Planner composition rule

Squad Planner apply persists two representations of the same active plan capacity:

- **Aggregate `ROLE` profile** with `source: 'squadPlanner'` — total headcount.
- **`PLANNED_RESOURCE` profiles** with `source: 'squadPlanner'` — individual
  trajectories (one per planned-resource slot).

The resolver treats both as `PROFILE` source. To avoid double-counting
(adding aggregate role capacity on top of the same planned-resource trajectories),
when an aggregate Squad Planner ROLE profile AND Squad Planner planned-resource
profiles coexist for the same resource type, the aggregate ROLE profile is
**not** exposed as `roleSegments` for scheduler capacity computations.
The planned-resource trajectories remain the schedulable representation.

This affects only scheduler-facing capacity (`schedulerCapacityResolver.ts`).
The aggregate persistred ROLE profile is preserved for Resource Profile,
export, compatibility and other non-scheduler consumers.

A standalone role profile (manual source, no overlapping planned-resource profiles)
continues to contribute `roleSegments` normally.

### Trajectory-to-resource ordering

Persistenced named resources are ordered by `[{ createdAt: 'asc' }, { id: 'asc' }]` to
match the Squad Planner writer ordering. Resources with identical `createdAt`
timestamps (created in the same batch) are tiedbroken by stable ID, ensuring
deterministic trajectory-to-resource mapping and consistent results across
repeated resolution.

### Ownership and composition

| Concern | Behaviour |
|---|---|
| `ResourceType.count` | Remains independent role/headcount metadata. Unchanged by profile resolution. |
| Phantom slots | `max(0, count − namedResources.length)` full-time slots. Used only when no `roleSegments` are present. |
| Role profile | When authoritative, replaces phantom-slot calculation with segment capacity. |
| Named-resource profiles | Per-resource capacity independent of count or phantom slots. |
| Planned-resource profiles | Treated as named resources with `resourceIdentity: 'PLANNED_RESOURCE'`. Individual trajectory capacity. |
| Fractional `Capacity Plan` | Headcount is quantised (0.25 FTE units) and distributed into trajectories. |
| Discontinuous periods | Zero-capacity periods between plan periods are preserved as gaps. |

### Follow-up issues

- **#363** owns first-class profile editing in the UI/API.
- **#364** owns retirement of legacy allocation compatibility fields.
- **#387** owns broader planning-model and transactional scheduling consolidation.

The profile-first resolver does not implement these work items. It only
centralises capacity loading so migrated consumers resolve the same facts.
