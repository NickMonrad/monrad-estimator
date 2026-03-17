# Monrad Estimator — Functional Specification

> **Status:** Living document. Update alongside feature releases.  
> **Last updated:** March 2026 (reflects all features shipped through PR #155)

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Projects](#projects)
4. [Backlog Builder](#backlog-builder)
5. [CSV Import / Export](#csv-import--export)
6. [Template Library](#template-library)
7. [Effort Review](#effort-review)
8. [Resource Profile](#resource-profile)
9. [Timeline Planner](#timeline-planner)
10. [Document Generation](#document-generation)
11. [Project Settings](#project-settings)
12. [Resource Types (Global & Project)](#resource-types-global--project)
13. [Rate Cards](#rate-cards)
14. [Organisations & Customers](#organisations--customers)
15. [Backlog History & Snapshots](#backlog-history--snapshots)
16. [Themes & UI](#themes--ui)
17. [Navigation Reference](#navigation-reference)
18. [Data Model Summary](#data-model-summary)
19. [Behavioural Rules](#behavioural-rules)

---

## Overview

Monrad Estimator is a full-stack project estimation tool that replaces a manual spreadsheet process. It supports the complete workflow from initial scoping through to client-ready deliverables:

1. **Backlog** — structure work into Epics → Features → Stories → Tasks with effort estimates
2. **Effort Review** — summarise effort by resource type with costs
3. **Timeline** — auto-schedule and manually tune a Gantt chart
4. **Resource Profile** — model headcount, overhead, discounts, and GST
5. **Documents** — generate a PDF Scope Document for client delivery

The application is single-user by default (each user owns their own projects) with optional organisation-level sharing.

---

## Authentication

### Registration & Login

| Field | Notes |
|---|---|
| Email | Unique per user |
| Name | Display name |
| Password | Minimum 8 characters; stored as bcrypt hash |

- JWT issued on registration and login; valid for **7 days**
- Token stored in `localStorage` under key `token`
- All private API routes require `Authorization: Bearer <token>`
- User object stored in `localStorage` under key `user`

### Password Reset

1. User enters email on **Forgot Password** page (`/forgot-password`)
2. Server generates a reset token (expires in 1 hour) and sends an email via SMTP
3. User clicks link in email → arrives at **Reset Password** page (`/reset-password?token=...`)
4. User sets a new password; token is invalidated on use

### Routes

| Route | Access | Purpose |
|---|---|---|
| `/login` | Public | Sign in |
| `/register` | Public | Create account |
| `/forgot-password` | Public | Request password reset email |
| `/reset-password` | Public | Set new password via token |
| `/accept-invite` | Public | Accept an organisation invitation |

---

## Projects

### Projects List (`/`)

- Displays all projects owned by the logged-in user
- **Search:** client-side filter by project name
- **Status filter:** filter by project status (DRAFT, ACTIVE, REVIEW, COMPLETE, ARCHIVED)
- **Sort:** by updated date (most recent first)
- Soft-deleted (archived) projects hidden by default; togglable "Show archived" view

### Creating a Project

| Field | Type | Notes |
|---|---|---|
| Name | Text (required) | Project display name |
| Customer | Select | Optional link to a Customer entity |
| Description | Textarea | Optional free text |
| Status | Enum | DRAFT / ACTIVE / REVIEW / COMPLETE / ARCHIVED |
| Hours per day | Number | Default 7.6; configurable 1–24 |

On creation, the project is **automatically seeded** with all current global resource types as project-scoped resource type instances.

### Project Actions

| Action | Notes |
|---|---|
| Open | Navigate to Project Detail hub |
| Clone | Copies project structure (epics/features/stories/tasks) with a new name |
| Archive | Soft-delete — sets status to ARCHIVED, hidden from default list |
| Restore | Un-archive a soft-deleted project |

### Project Detail Hub (`/projects/:id`)

Acts as a navigation hub with tiles linking to each sub-page:
- Backlog
- Effort Review
- Timeline
- Resource Profile
- Resource Types (project-scoped)
- Documents
- Settings

---

## Backlog Builder

### Hierarchy

```
Epic
└── Feature
    └── User Story
        └── Task
```

All levels support full CRUD (create, read, update, delete) and drag-and-drop reordering.

### Epic Fields

| Field | Notes |
|---|---|
| Name | Required |
| Description | Optional free text |
| Assumptions | Optional free text |
| Feature mode | `sequential` or `parallel` — controls how features are scheduled relative to each other (not visible in Backlog, but can be modified in Timeline) |
| isActive | Toggle in/out of scope |

### Feature Fields

| Field | Notes |
|---|---|
| Name | Required |
| Description | Optional free text |
| Assumptions | Optional free text |
| isActive | Toggle in/out of scope |

### User Story Fields

| Field | Notes |
|---|---|
| Name | Required |
| Description | Optional free text |
| Assumptions | Optional free text |
| Applied template | Optional link to the FeatureTemplate used to generate it |
| isActive | Toggle in/out of scope |

### Task Fields

| Field | Notes |
|---|---|
| Name | Required |
| Description | Optional free text |
| Assumptions | Optional free text |
| Hours effort | Numeric input |
| Duration days | Auto-calculated from hours ÷ hoursPerDay; can be manually overridden |
| Resource type | Optional link to a project-scoped resource type |

### Drag-and-Drop Reordering

- Epics, Features, Stories, and Tasks can each be reordered within their parent via drag-and-drop
- Cross-parent moves are supported (e.g. drag a Feature from one Epic to another)
- Order is persisted immediately via `POST /reorder` endpoints

### Deactivate / Reactivate

- Each Epic, Feature, and Story has an **active toggle** (filled/outline circle icon)
- Inactive items are displayed with strikethrough text and reduced opacity
- Inactive items are **excluded from**:
  - Effort Review totals (when active filter is on)
  - Timeline scheduling
  - Resource Profile calculations
  - Document output

### Hours ↔ Days Bidirectional Calculation

- Entering **hours** → duration days auto-calculated as `hours ÷ project.hoursPerDay`
- Entering **duration days** manually overrides the auto-calculated value
- Both values are stored on the Task record
- Displayed precision: 2 decimal places

### Backlog History Panel

- Accessible from the Backlog page
- Shows a list of named snapshots with timestamp, trigger, and optional label
- Snapshot triggers: `manual`, `csv_import`
- Click any snapshot to **preview** the historical state
- **Rollback** button restores the backlog to the selected snapshot (auto-saves a pre-rollback snapshot first)

---

## CSV Import / Export

### Export

**File naming:** `{CustomerName} - {ProjectName} - {YYYY-MM-DD}.csv`

**Column structure (13 columns):**

| Column | Description |
|---|---|
| `Type` | Row type: `Epic`, `Feature`, `Story`, or `Task` |
| `Epic` | Epic name |
| `Feature` | Feature name |
| `Story` | Story name |
| `Task` | Task name |
| `Template` | Applied template name (Story rows only) |
| `ResourceType` | Resource type name (Task rows only) |
| `HoursEffort` | Numeric hours (Task rows only) |
| `DurationDays` | Numeric days (Task rows only) |
| `Description` | Description text for the row type |
| `Assumptions` | Assumptions text for the row type |
| `EpicStatus` | `active` or `inactive` (Epic rows only) |
| `FeatureStatus` | `active` or `inactive` (Feature rows only) |
| `StoryStatus` | `active` or `inactive` (Story rows only) |

**Notes:**
- Rows are exported in hierarchy order (Epic → Features → Stories → Tasks)
- Epic/Feature/Story cells are populated on the row they own; sub-levels leave parent cells blank (carry-forward on re-import)

### Import — 3-Step Workflow

**Step 1 — Upload & Stage**
- User uploads a CSV file
- Server parses and validates every row; returns a staged list with per-row errors and warnings
- **Validation errors** (blocking): missing required name for the row's `Type`; blank `Task` name on a Task row
- **Warnings** (non-blocking): unrecognised resource type; unrecognised template name; status value applied to wrong row type

**Step 2 — Review**
- Modal displays all staged rows
- Rows with errors shown in red; rows with warnings shown in amber
- User can proceed only if there are no errors

**Step 3 — Import**
- Auto-snapshot taken before import begins (trigger: `csv_import`)
- Upsert by hierarchy — see [Upsert Behaviour](#upsert-behaviour) below

### Carry-Forward Logic

Excel-style blank cell inheritance:
- If a cell in `Epic`, `Feature`, or `Story` column is blank, it inherits the last non-blank value in that column above it
- Allows a single Epic to span multiple rows without repeating the name

**Example:**
```
Type,    Epic,       Feature,    Story,    Task
Epic,    My Epic,    ,           ,
Feature, ,           My Feature, ,
Story,   ,           ,           My Story,
Task,    ,           ,           ,         Task A
Task,    ,           ,           ,         Task B
```
All rows belong to `My Epic → My Feature → My Story`.

### Upsert Behaviour

Rows are matched by their full ancestry path (Epic name → Feature name → Story name → Task name within that scope). If a matching row exists, it is **updated**; otherwise it is **created**.

- Epic: matched by name
- Feature: matched by (Epic name, Feature name)
- Story: matched by (Epic name, Feature name, Story name)
- Task: matched by (Epic name, Feature name, Story name, Task name)

Updates apply: `hoursEffort`, `durationDays`, `resourceType`, `isActive` (from status columns), `description`, `assumptions`, `appliedTemplate`.

### Backwards Compatibility

- Files exported before the `Type` column was introduced are still accepted
- Rows without a `Type` column default to `Task` type

---

## Template Library

### What is a Template?

A **Feature Template** is a reusable set of tasks that can be applied to any User Story at a chosen complexity level. It represents a pattern of work (e.g. "Frontend Component", "API Endpoint with tests") that your team does repeatedly.

### Template Fields

| Field | Notes |
|---|---|
| Name | Globally unique across all users |
| Category | Optional grouping label |
| Description | Optional free text |

### Template Task Fields

| Field | Notes |
|---|---|
| Name | Required |
| Resource type name | Text label matched to project resource types at apply time |
| Hours (XS) | Extra-small complexity hours |
| Hours (S) | Small complexity hours |
| Hours (M) | Medium complexity hours |
| Hours (L) | Large complexity hours |
| Hours (XL) | Extra-large complexity hours |
| Order | Drag-drop position within the template |

### Applying a Template to a Story

1. In the Backlog, open the **Apply Template** action on a Feature
2. Select a template from the library
3. Choose a complexity: **XS / S / M / L / XL**
4. Optionally enter a custom story name (defaults to template name)
5. A new User Story is created under the Feature, with one Task per template task
6. Each task's `hoursEffort` is taken from the chosen complexity tier
7. Tasks are auto-matched to project resource types by name (case-insensitive); unmatched tasks have no resource type assigned
8. The story records `appliedTemplateId` for future refresh

### Refreshing from Template

- Available on any story with an `appliedTemplateId`
- Compares the story's current tasks against the template's tasks by name
- **Matching tasks:** hours, duration days, and resource type are updated from the template
- **New template tasks:** added to the story
- **Tasks not in template:** left untouched (not deleted)
- Auto-snapshot is taken before the refresh

### Template CSV Export

**Column structure:**

| Column | Description |
|---|---|
| `TemplateName` | Template name |
| `Category` | Template category |
| `TaskName` | Task name within template |
| `ResourceTypeName` | Resource type name string |
| `HoursExtraSmall` | Hours for XS complexity |
| `HoursSmall` | Hours for S complexity |
| `HoursMedium` | Hours for M complexity |
| `HoursLarge` | Hours for L complexity |
| `HoursExtraLarge` | Hours for XL complexity |

### Template CSV Import

1. **Preview** (`POST /templates/import-csv/preview`): parses CSV, returns diff of new/updated templates with any errors
2. **Commit** (`POST /templates/import-csv`): upserts templates by name; recreates all tasks for each template in the file

### Template History (Snapshots)

- Each template has its own snapshot history panel
- Snapshots can be taken manually or are triggered automatically on CSV import
- Rollback restores template tasks to the snapshotted state

---

## Effort Review

### Views

**Summary View (default)**

Grouped by resource type, sorted by category, then resource type name.

| Column | Description |
|---|---|
| Resource Type | Name of the resource type |
| Category | ENGINEERING / GOVERNANCE / PROJECT_MANAGEMENT |
| Total Hours | Sum of task hours |
| Total Days | Hours ÷ hoursPerDay |
| Day Rate | From resource type (if configured) |
| Est. Cost | Days × day rate |
| % of Total | Cost as % of total project cost |

- Category subtotals row shown below each group
- Expandable epic sub-rows: click any resource type row to see hours broken down by epic

**Detail View**

Line-by-line view of every task, showing:
- Category, Resource Type, Epic, Feature, Story, Task name
- Hours, Days, Day Rate, Est. Cost

**Column filters:** dropdown filters for Epic, Feature, Story, Resource Type; text search for task name. Filters cascade (selecting an Epic limits available Features, etc.).

### Active Scope Filter

Toggle: **All items** vs **Active items only**

When "Active items only" is on, tasks from inactive epics/features/stories are excluded from all totals and rows.

### CSV Export

Two exports available:

- **Summary CSV** — mirrors the Summary View (one row per resource type)
- **Detail CSV** — mirrors the Detail View (one row per task)

Both exports respect the active filter and include cost columns only when day rates are configured.

**Filename format:** `{ProjectName} - Effort Summary|Detail - {YYYY-MM-DD}.csv`

---

## Resource Profile

### Named Resources

Each project-scoped resource type can have one or more named resources assigned to it.

| Field | Notes |
|---|---|
| Name | Person's name or role label |
| Start week | Week number when this person joins (null = project start) |
| End week | Week number when this person leaves (null = project end) |
| Allocation % | What fraction of their time is on this project (0–100) |
| Allocation mode | `EFFORT` / `TIMELINE` / `FULL_PROJECT` (see [Allocation Modes](#allocation-modes)) |

**Allocation Modes:**

| Mode | Description |
|---|---|
| `EFFORT` | Cost calculated from actual task hours assigned to this resource type |
| `TIMELINE` | Cost calculated from the span of the project timeline × allocation % |
| `FULL_PROJECT` | Cost calculated as full project duration regardless of individual start/end |

### Overhead Items

Overhead items add non-task cost to a project.

| Field | Notes |
|---|---|
| Label | Display name |
| Type | `PERCENTAGE`, `FIXED_DAYS`, or `DAYS_PER_WEEK` |
| Value | Percentage, number of days, or days per week |
| Resource type link | Optional — applies overhead to a specific resource type only |
| Order | Display sequence |

**Overhead Type Behaviour:**

| Type | Calculation |
|---|---|
| `PERCENTAGE` | `value%` of total task days (for linked RT, or all task days) |
| `FIXED_DAYS` | Flat addition of `value` days |
| `DAYS_PER_WEEK` | `value × project duration in weeks` |

### Discounts

| Field | Notes |
|---|---|
| Label | Display name |
|Type | `PERCENTAGE` or `FIXED_AMOUNT` |
| Value | Percentage or dollar amount |
| Resource type link | Optional — applies to specific resource type only |
| Order | Display sequence |

### GST / Tax

- Configurable tax rate (%) and label (e.g. "GST") per project
- Applied to the total commercial cost in the Resource Profile
- Ex-tax and inc-tax totals displayed

### FTE Calculation

**FTE (Full Time Equivalent):** how many full-time engineers the planned work represents over the project duration.

```
FTE = total_task_days / (project_duration_weeks × 5_work_days_per_week)
```

Displayed per resource type in the Resource Profile.

### Stacked Bar Chart

Weekly demand visualisation:
- X-axis: week numbers
- Y-axis: days of work
- Stacked bars per resource type (colour-coded by category)
- Computed from TimelineEntry data — reflects the actual scheduled timeline

### CSV Exports

- **Resource Profile CSV** — summary of named resources, rates, overhead, cost breakdown
- **Full Project ZIP** — combined export including effort CSV, resource profile CSV, and project metadata

---

## Timeline Planner

### Auto-Scheduler

The scheduler places features on a timeline automatically using a **dependency-aware topological sort** and **proportional pool simulation**:

1. Features within an Epic are ordered by their `order` field
2. Epic `featureMode` determines whether features run **sequentially** (end-to-end) or **in parallel** (overlapping)
3. Resource levelling: if multiple features need the same resource type simultaneously, their durations are spread proportionally to keep weekly demand within capacity
4. Features with manual overrides (`isManual = true`) are placed at their fixed `startWeek` and are not moved by the scheduler
5. Feature dependencies (`FeatureDependency`) ensure a feature cannot start before all its dependencies complete
6. Story-level dependencies (`StoryDependency`) are also respected for story bars

### Feature Duration Calculation

```
feature_duration_weeks = Σ(task.durationDays) / (hoursPerDay × 5)
```
Fractional weeks are preserved.

### Manual Overrides

- Click any feature bar in the Gantt to open the **Inline Edit Panel**
- Toggle **Manual** to fix the feature's position
- Set `startWeek` and `durationWeeks` directly
- Manual features show an indicator icon on the bar
- **Clear All Overrides** button resets all features to auto-scheduled positions

### Gantt Chart

- SVG-based chart with:
  - One row per Feature (showing feature duration bars)
  - Story bars within each feature row (proportional to story effort)
  - Inter-feature **dependency arrows** (line from end of dependency to start of dependent)
  - Epic colour bands (each epic gets a distinct colour)
  - Week header row with sequential week numbers
  - Projected end date marker

### Resource Histogram

Below the Gantt chart, a weekly bar chart shows:
- Demand: total days consumed per resource type per week
- Capacity: available days per resource type per week (from named resources × allocation %)
- Over-allocation highlighted visually

### Epic Feature Modes

Each Epic has two mode settings editable from the Gantt:

| Mode | Values | Effect |
|---|---|---|
| Feature mode | sequential / parallel | Features within this epic scheduled sequentially or in parallel |
| Schedule mode | sequential / parallel | Epic itself scheduled after previous epics (seq) or allowed to overlap (parallel) |

### Inline Edit Panel

Opens when clicking a feature bar. Shows:
- Feature name (editable)
- Start week (editable when manual)
- Duration weeks (editable when manual)
- Manual toggle
- Resource breakdown: days by resource type for this feature
- Estimated cost (if day rates configured)
- Feature dependencies selector (choose which other features must complete first)

### Start Date

- Set project start date from the Timeline page
- All week numbers are relative to this start date
- Projected end date is calculated as `startDate + projectedEndWeek × 7 days`

---

## Document Generation

### Documents Page (`/projects/:id/documents`)

Generates a **PDF Scope Document** using React PDF rendered client-side.

### Sections (all toggleable)

| Section | Contents |
|---|---|
| **Cover Page** | Project name, customer name, document label (optional), prepared date, start date, projected end date |
| **Scope Summary** | In-scope epics/features with descriptions and assumptions; out-of-scope items listed separately |
| **Effort Breakdown** | Table: epic → feature → resource type, hours and days; governance & overhead items table; total row |
| **Timeline Summary** | Projected project dates, feature schedule table (feature name, resource types, start week, duration weeks, est. end) |
| **Resource Profile** | Named resources, day rates, overhead items, discount items, cost summary with GST |

### Download

- **Download PDF** button saves the generated document to disk
- **Document label** field (optional) is included on the cover page and appended to the filename
- Filename format: `{ProjectName} - Scope Document - {YYYY-MM-DD}.pdf`

### Auto-save to Server

After generating, the document metadata (label, filename, sections enabled) is saved to the project via `POST /projects/:id/documents`. Previously generated documents are listed on the page.

---

## Project Settings

### Editable Fields

| Field | Notes |
|---|---|
| Name | Project display name |
| Customer | Optional Customer entity link |
| Description | Optional free text |
| Status | DRAFT / ACTIVE / REVIEW / COMPLETE / ARCHIVED |
| Hours per day | Configurable 1–24 (default 7.6) — affects all hours ↔ days calculations across the project |
| Tax rate | Percentage (e.g. 10 for 10% GST) |
| Tax label | Display label (e.g. "GST") |

---

## Resource Types (Global & Project)

### Global Resource Types (`/resource-types`)

The global catalog of roles/disciplines used across all projects.

| Field | Notes |
|---|---|
| Name | Unique display name |
| Category | ENGINEERING / GOVERNANCE / PROJECT_MANAGEMENT |
| Default hours/day | Overrides project-level hours/day for this role |
| Default day rate | Default billing rate for this role |
| Description | Optional |
| Is default | Whether to include in new project seeding |

### Project Resource Types (`/projects/:id/resource-types`)

Each project has its own scoped copy of the resource types it uses.

| Field | Notes |
|---|---|
| Name | Copied from global; editable per-project |
| Category | Inherited from global |
| Hours per day | Override for this role on this project |
| Day rate | Override billing rate for this project |
| Global link | Reference to the global resource type it was seeded from |

**Actions:**
- Add resource type (from global catalog, or custom)
- Edit name, hoursPerDay, dayRate per project
- Remove a resource type (blocked if tasks are assigned to it)
- Apply Rate Card — bulk-updates day rates from a rate card

---

## Rate Cards

### Global Rate Cards (`/rate-cards`)

Rate cards define a named set of day rates for resource types.

| Field | Notes |
|---|---|
| Name | Display name |
| Is default | Only one rate card can be default |
| Entries | One entry per global resource type: resource type → day rate |

### Applying a Rate Card to a Project

- From the Project Resource Types page, choose **Apply Rate Card**
- Selects from all global rate cards
- Updates the `dayRate` on every matching project resource type
- Match is by global resource type link

---

## Organisations & Customers

### Organisations (`/orgs`)

An Organisation is a shared workspace for multiple users.

| Field | Notes |
|---|---|
| Name | Organisation display name |
| Members | Users with roles: OWNER, ADMIN, MEMBER |

**Actions:**
- Create organisation
- Invite a user by email — sends an invitation email with an accept link
- Accept invite (`/accept-invite?token=...`) — joins the org as a MEMBER
- Change member role (OWNER/ADMIN only)
- Remove member (OWNER/ADMIN only)
- Leave organisation

**Organisation Projects:**
- Projects can be linked to an organisation (`orgId` field)
- Organisation members can see each other's projects linked to the shared org

### Customers (`/customers`)

A Customer is a client entity that can be linked to projects.

| Field | Notes |
|---|---|
| Name | Required |
| Description | Optional free text |
| Account code | Optional (e.g. CRM account number) |
| CRM link | Optional URL to external CRM record |
| Organisation | Optional link to an Org (groups customers under an org) |

**Actions:**
- Create, edit, delete customers
- Link a customer to a project (via Project Settings or on project create)
- Filter customers by organisation

---

## Backlog History & Snapshots

### Snapshot Model

A snapshot captures the complete backlog state (all epics, features, stories, tasks, and their fields) as a JSON blob at a point in time.

| Field | Notes |
|---|---|
| Label | Optional user-provided name |
| Trigger | `manual`, `csv_import`, `rollback` |
| Created at | Timestamp |
| Created by | User who triggered the snapshot |

### Auto-Snapshot Triggers

| Trigger | When it fires |
|---|---|
| `csv_import` | Immediately before a CSV import is committed |
| `rollback` | Immediately before a rollback is applied (captures pre-rollback state) |
| `manual` | User clicks "Save snapshot" button in History panel |

### Rollback Behaviour

1. Auto-snapshot of current state created (trigger: `rollback`)
2. All existing Epics (and their cascade: Features → Stories → Tasks) are **deleted**
3. Epics, Features, Stories, and Tasks are **recreated** from the snapshot JSON
4. Resource types are re-matched by name to the project's current resource types
5. Timeline entries are **not** restored — the timeline will be re-generated from the restored backlog

### Diff View

Selecting a snapshot shows a diff against the current backlog:
- Items **added** since the snapshot (in current but not in snapshot)
- Items **removed** since the snapshot (in snapshot but not in current)
- Diff is computed at the flattened task level

---

## Themes & UI

### LAB3 Theme

- Primary action colour: **red-600** (`#dc2626`)
- Secondary / borders: gray tones
- No external UI component library — hand-rolled Tailwind components

### Dark Mode

- Toggle available in the top navigation header (sun/moon icon)
- Persisted in `localStorage`
- Applied via `dark:` Tailwind variants across all pages and components

### Geocities Easter Egg

- Hidden easter egg activated by clicking the logo a specific number of times
- Activates a retro "Geocities" theme with animated GIFs and wild CSS
- A banner appears when the Geocities threshold is reached (lowered after the first activation)

---

## Navigation Reference

### Global Navigation

| Route | Page | Access |
|---|---|---|
| `/` | Projects list | Private |
| `/templates` | Template Library | Private |
| `/resource-types` | Global Resource Types | Private |
| `/rate-cards` | Rate Cards | Private |
| `/orgs` | Organisations | Private |
| `/customers` | Customers | Private |

### Per-Project Navigation

| Route | Page |
|---|---|
| `/projects/:id` | Project Detail (nav hub) |
| `/projects/:id/backlog` | Backlog Builder |
| `/projects/:id/effort` | Effort Review |
| `/projects/:id/timeline` | Timeline Planner |
| `/projects/:id/resource-profile` | Resource Profile |
| `/projects/:id/resource-types` | Project Resource Types |
| `/projects/:id/documents` | Document Generation |
| `/projects/:id/settings` | Project Settings |

### Public Routes

| Route | Page |
|---|---|
| `/login` | Login |
| `/register` | Register |
| `/forgot-password` | Forgot Password |
| `/reset-password` | Reset Password |
| `/accept-invite` | Accept Organisation Invite |

---

## Data Model Summary

```
User
├── Project (many, owned by user)
│   ├── Epic (many, ordered)
│   │   └── Feature (many, ordered)
│   │       └── UserStory (many, ordered)
│   │           └── Task (many, ordered)
│   ├── ResourceType (many, project-scoped)
│   │   └── NamedResource (many)
│   ├── ProjectOverhead (many)
│   ├── ProjectDiscount (many)
│   ├── BacklogSnapshot (many)
│   ├── TimelineEntry (one per Feature)
│   └── GeneratedDocument (many)
├── Customer (many, owned by user)
└── OrganisationMember (many, via orgs)

GlobalResourceType (global catalog)
└── ResourceType (many, project instances)

FeatureTemplate (global, unique name)
└── TemplateTask (many, ordered)
    └── TemplateSnapshot (many)

RateCard (global)
└── RateCardEntry (one per GlobalResourceType)

Organisation
├── OrganisationMember (many)
├── OrganisationInvite (many)
├── Project (many, optional)
└── Customer (many, optional)

FeatureDependency (Feature → Feature)
StoryDependency (UserStory → UserStory)
```

### Key Enumerations

| Enum | Values |
|---|---|
| `ProjectStatus` | DRAFT, ACTIVE, REVIEW, COMPLETE, ARCHIVED |
| `ResourceCategory` | ENGINEERING, GOVERNANCE, PROJECT_MANAGEMENT |
| `OverheadType` | PERCENTAGE, FIXED_DAYS, DAYS_PER_WEEK |
| `AllocationMode` | EFFORT, TIMELINE, FULL_PROJECT |
| `OrgRole` | OWNER, ADMIN, MEMBER |

---

## Behavioural Rules

### Hours ↔ Days Calculation

```
durationDays = hoursEffort / project.hoursPerDay
```

- `hoursPerDay` defaults to **7.6** (configurable per project in Settings)
- Changing hours recalculates days; manually overriding days stores the override value
- All effort totals in Effort Review and Resource Profile use this formula

### CSV Carry-Forward

Empty parent cells inherit the last non-empty value in the same column reading top-to-bottom. This means a single Epic spanning 10 rows only needs the Epic name in row 1; rows 2–10 leave it blank and the importer fills it in.

### Template Complexity Tiers

Five tiers: XS (Extra Small), S (Small), M (Medium), L (Large), XL (Extra Large). Hours for each tier are stored independently on each TemplateTask. Applying a template at a given tier uses only that tier's hours; the other tiers are ignored.

### Refresh from Template (Additive, Non-destructive)

Refreshing a story from its template:
1. **Matches** existing tasks to template tasks by exact name comparison
2. **Updates** matched tasks: `hoursEffort`, `durationDays`, resource type name
3. **Adds** any new tasks present in the template but not in the story
4. **Does not delete** tasks in the story that are not in the template

This allows manual customisation of a story to survive a refresh as long as task names differ from template task names.

### Snapshot Rollback (Cascade Delete + Recreate)

Rollback is destructive to the current state:
1. Auto-snapshot of current state (so rollback itself is reversible)
2. Cascade-delete all epics (removes features, stories, tasks, timeline entries)
3. Recreate entire hierarchy from snapshot JSON
4. Resource types re-matched by name — if a resource type was renamed since the snapshot, tasks for that type will have no resource type after rollback
5. Timeline entries are **not** restored; the Gantt will regenerate from the restored backlog structure

### Inactive Items

`isActive = false` on any level excludes that level and all its children from:
- Timeline scheduling (features/stories not placed on the Gantt)
- Effort Review totals (when "Active items only" filter is on)
- Resource Profile cost calculations
- Scope Document "In Scope" section (shown in "Out of Scope" instead)

The item remains visible in the Backlog with visual de-emphasis (strikethrough, reduced opacity).

### Auto-Scheduling (Timeline)

The scheduler runs whenever the timeline is loaded or data changes:
1. Features with `isManual = true` are pinned to their saved `startWeek`/`durationWeeks`
2. All other features are auto-placed via topological sort respecting `FeatureDependency` edges
3. Epic `featureMode = sequential` → features placed end-to-end within the epic's time window
4. Epic `featureMode = parallel` → features can overlap; resource levelling redistributes load
5. Resource levelling uses a proportional pool: if demand exceeds capacity in a week, feature durations are extended proportionally until weekly load fits

### Unique Template Names

Template names are enforced as globally unique across all users. Attempting to create or rename a template to an already-existing name returns a 409 error. This enables reliable CSV import matching by name.
