# Westpac Estimator — Implementation Plan

## Problem
Replace a spreadsheet-based estimation process with a structured web application that manages project backlogs, resource profiling, scheduling, and generates customer-facing documents.

## Tech Stack
- **Frontend**: React + TypeScript, Vite, Tailwind CSS, React Query, React Router
- **Backend**: Node.js + Express + TypeScript
- **Database**: PostgreSQL + Prisma ORM
- **Auth**: JWT-based (users per organisation)
- **Export**: `@react-pdf/renderer` or Puppeteer (PDF), `docx` npm package (Word)

---

## Data Model

### Project
- id, name, description, customer, status, created_at, updated_at
- owner (user)

### Backlog Hierarchy
```
Epic
  └── Feature
        └── User Story
              └── Task
                    ├── resource_type (FK → ResourceType)
                    ├── hours_effort
                    ├── description
                    └── assumptions
```

### Feature Template
- id, name, category, description
- TemplateTask: task_name, resource_type, hours by complexity (S/M/L/XL)

### ResourceType
- id, name (e.g. "Developer", "BA", "Tech Lead", "PM", "Tech Governance")
- category: engineering | governance | project_management

### Timeline
- Sprint/period blocks with assigned backlog items
- Dependencies between items (blocking/blocked-by)

### ResourceProfile
- Per-project profile with:
  - Engineering effort (days, auto-derived from backlog)
  - Technical governance overlay (% or fixed days)
  - PM overlay (% or fixed days)
  - Total profile by week/period

---

## Application Modules

### 1. Project Management
- Create / list / archive projects
- Project overview dashboard (status, totals by resource type)

### 2. Backlog Builder
- Tree view: Epic → Feature → User Story → Task
- **Manual entry**: add any item at any level, fill in effort, resource type, description, assumptions
- **Template-based entry**: pick a Feature Template + complexity (S/M/L/XL) → auto-creates tasks with standard effort
- Inline editing, reordering, drag-and-drop hierarchy

### 3. Template Library
- Manage pre-defined feature templates
- Per-template, per-complexity task sets with default hours
- Admin screen to create/edit templates

### 4. Effort Review
- Summary table: resource type × effort (hours + days)
- Filter by Epic/Feature
- Highlight under/over-estimated items
- Editable override for individual task hours

### 5. Timeline Planner
- Define timeframe (start date, end date, sprint length)
- Define number of resources per type
- Assign backlog items to periods
- Dependency manager: mark dependencies, flag violations
- Visual Gantt-style view (per resource type)

### 6. Resource Profile Builder
- Auto-calculate engineering days from backlog
- Layer on technical governance (% of engineering or fixed days/period)
- Layer on PM (% of engineering or fixed days/period)
- Output: weekly/period resource profile table + chart
- Exportable as data

### 7. Document Generation
- **Scope Document**: project overview, list of epics/features/stories, assumptions, exclusions
- **Statement of Work**: scope, resource profile, timeline, cost basis (optional)
- Both exported as PDF and Word (.docx)
- Configurable cover page, branding, section toggles

---

## Phased Build Plan

### Phase 1 — Foundation
- Repo setup (monorepo: `/client`, `/server`)
- Vite + React + TypeScript + Tailwind (client)
- Express + TypeScript + Prisma + PostgreSQL (server)
- DB schema + migrations
- Auth (JWT login/register)
- Project CRUD

### Phase 2 — Backlog
- Backlog hierarchy data model + API
- Backlog tree UI (Epic/Feature/Story/Task)
- Manual item creation/editing
- Resource type management

### Phase 3 — Templates
- Feature Template data model + API
- Template Library UI (admin)
- Template-based backlog generation (select template + complexity → creates tasks)

### Phase 4 — Effort Review
- Effort summary API (grouped by resource type)
- Effort Review UI (table + charts)
- Hour override support

### Phase 5 — Timeline Planner
- Timeline/sprint data model + API
- Timeline Planner UI
- Dependency management
- Gantt/period view

### Phase 6 — Resource Profile
- Resource profile calculation engine
- Governance + PM overlay configuration
- Resource profile table + chart UI
- Export as CSV/Excel

### Phase 7 — Document Generation
- Scope document template (PDF + Word)
- Statement of Work template (PDF + Word)
- Document config UI (section toggles, branding)

### Phase 8 — Cost Basis & Rate Cards
- Global default hourly rates per resource type (admin-managed)
- Per-project rate overrides (locked at project level, versioned)
- Per-resource-type discounts applied to P×Q subtotals
- Project-level discounts (value threshold, duration threshold, manual) — additive, applied to subtotal or grand total
- Cost summary: hours × rate per resource type → subtotals → discount lines → net total
- Cost section added to SOW document output

### Phase 9 — AI Backlog Generator
- Configurable AI provider (OpenAI GPT-4o and Anthropic Claude, switchable)
- API key management (server-side env config)
- "Generate from brief" flow: paste customer brief → AI returns structured draft backlog (Epics/Features/Stories/Tasks with hours + resource types)
- Preview and edit generated backlog before importing
- "Suggest templates" feature: AI reads brief → recommends Feature Templates at appropriate S/M/L/XL complexity

---

## Key Decisions / Notes
- Hours are stored at Task level; days are derived (assume configurable hours/day, default 8)
- Multiple projects are fully isolated
- Template library is shared across all projects (global)
- Resource types are project-scoped but seeded from a global default set
- SOW cost basis: per-resource discounts on P×Q subtotals; project-level discounts (value/duration/manual) are additive on subtotal or grand total
- AI provider is configurable (OpenAI GPT-4o or Anthropic Claude), API keys stored server-side
