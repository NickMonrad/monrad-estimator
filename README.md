# Monrad Estimator

A full-stack project estimation tool that replaces a manual spreadsheet process. It produces scoped backlogs, effort summaries, resource profiles, timelines, and eventually SOW documents.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite + TypeScript + Tailwind CSS |
| Backend | Node.js + Express + TypeScript |
| ORM | Prisma 7 (driver adapter mode) |
| Database | PostgreSQL |
| Auth | JWT (Bearer token) |
| Testing | Vitest + Supertest (server), Vitest + React Testing Library (client), Playwright (E2E) |

---

## Project Structure

```
/client        React + Vite frontend
/server        Express + Prisma API
  /prisma      Schema + migrations
  /scripts     Utility scripts (e.g. e2e:cleanup)
/e2e           Playwright E2E tests
/docs          Documentation
  /architecture  Planning architecture guide
  user-guide.md  End-user workflow guide
```

📖 **Architecture docs:** [`docs/architecture/scheduling-and-resource-model.md`](docs/architecture/scheduling-and-resource-model.md) — explains scheduling, resource levelling, named-resource allocation, capacity plans, commercial/resource-profile derivation, and cross-surface consistency.

👤 **User guide:** [`docs/user-guide.md`](docs/user-guide.md) — explains the estimator workflow in plain English: backlog effort, Timeline, resources, capacity plans, Resource Profile, Commercial, and exports.

---

## Getting Started

### Prerequisites

- Node.js 24+
- PostgreSQL reachable from `DATABASE_URL`, or Docker for the optional development/test container workflow

### 1. Configure PostgreSQL

Use an existing host PostgreSQL server or start a development container:

```bash
docker run -d --name monrad-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:15
```

Set `DATABASE_URL` in `server/.env` after installing dependencies.

`db:setup` reads shell variables first, then `server/.env` (or `MONRAD_ENV_FILE`), creates only the configured development database when it is absent, and runs `prisma migrate deploy` plus `prisma generate`. It never resets, drops, or overwrites that database. It supports a host PostgreSQL installation; Docker is optional for development setup.

### 2. Install dependencies

```bash
npm install
```

This installs all workspace dependencies and automatically:
- Creates the `logs/` directory
- Downloads the Puppeteer-managed Chrome browser (~170 MB) used for server-side PDF generation

> **Note:** Chrome is cached to `~/.cache/puppeteer` and only downloaded once. If you're offline or the download fails, PDF generation won't work until you run `npm run install:chrome` manually.

> **Windows:** `npm install` should work out of the box on Windows. Native bindings for
> Vite (rolldown, lightningcss, esbuild) and Tailwind CSS Oxide are declared as root
> `optionalDependencies` and are automatically installed on Windows. The postinstall script
> verifies these bindings are present and prints a warning if any are missing.

### 3. Configure environment

```bash
cp server/.env.example server/.env
npm run db:setup
```

`server/.env.example` contains sensible defaults for local development. Edit it if your PostgreSQL credentials differ from the Docker command above.

> **JWT_SECRET:** The example file includes a dev-only secret (`local-dev-jwt-secret-at-least-32-chars!!`) that works for local development. **Replace it with a secure random string in production** (e.g. `openssl rand -hex 32`). The server rejects values shorter than 32 characters or the placeholder `change-me-in-production`.

#### Email / SMTP (optional)

Email is used for password reset links and org invite emails. Without SMTP configured, both flows still work — the email content and link are printed to the server console instead.

To enable real email delivery, add the following to `server/.env`:

```env
SMTP_HOST="smtp-relay.brevo.com"   # or your provider's SMTP host
SMTP_PORT="587"
SMTP_USER="your-smtp-login"
SMTP_PASS="your-smtp-key-or-password"
SMTP_FROM="Monrad Estimator <you@yourdomain.com>"
CLIENT_URL="http://localhost:5173"  # base URL used in email links
```

**Recommended free providers:**

| Provider | Free tier | Notes |
|---|---|---|
| [Brevo](https://brevo.com) | 300 emails/day | SMTP login = account email, password = generated SMTP key |
| [Resend](https://resend.com) | 3,000 emails/month | Requires a verified domain |
| [SendGrid](https://sendgrid.com) | 100 emails/day | Industry standard |

For **Brevo**: generate an SMTP key at *Settings → SMTP & API → SMTP*, then verify a sender address at *Senders & IPs → Add a sender*.

### 4. Back up before schema changes

Run the repository backup command before any Prisma migration or other destructive database change:

```bash
npm run db:backup
```

`DATABASE_URL` is the source of truth. The command reads it from the process environment first, then `server/.env` (or the path set by `MONRAD_ENV_FILE`), and writes a verified non-empty custom-format dump to `backups/`. Host mode is the default and uses the host `pg_dump`; Docker mode requires `MONRAD_DB_MODE=docker`. `MONRAD_DB_CONTAINER` only overrides the container name while Docker mode is active, with `monrad-pg` as the default. Set `MONRAD_DB_MODE=host` to force host mode explicitly.

Authority passwords are removed from the URI, and raw query-string `password` fields are removed without reserialising unrelated libpq query options. The effective credential is passed through the child `PGPASSWORD` environment variable, never through command arguments. Conflicting authority/query passwords or multiple query-string passwords fail before invoking `pg_dump`, and failures do not reveal the URL or credentials.

Backup regression tests cover credential handling, mode selection, configuration precedence, atomic no-overwrite finalisation, output verification, cleanup, and representative host and Docker failure paths. The backup suite runs in both Linux and Windows CI and is also included in the root `npm test` and `npm run validate` commands.

### 5. Update the development schema

```bash
npm run db:setup
```

Run `npm run db:backup` before a schema migration that changes persistent data. `prisma migrate reset` remains prohibited without explicit approval.

### 6. Start development servers

```bash
npm run dev          # API on :3001 + Vite on :5173 (concurrently)
```

Server logs are written to `logs/dev-servers.log` when running in the background. The `logs/` directory is created automatically by `npm install`.

> **Troubleshooting:** If `npm run dev` exits immediately with no output, ensure the
> `logs/` directory exists (`npm install` creates it automatically; you can also create it
> manually with `mkdir logs` in bash or `New-Item -ItemType Directory logs` in PowerShell).
> Also verify that the Puppeteer Chrome browser was downloaded successfully
> (`npm run install:chrome` retries the download).

> **Windows native bindings:** If the postinstall script reports that Windows native
> bindings are missing, first try running `npm install` again — the root
> `optionalDependencies` should install them on Windows. If they still fail, run the
> `npm install` command printed by postinstall (e.g.
> `npm install @rolldown/binding-win32-x64-msvc`). This is caused by a known npm issue
> ([npm/cli#4828](https://github.com/npm/cli/issues/4828)) where nested optional dependencies
> with native binaries may be skipped on Windows.

### Validate and run tests

```bash
# Complete client/server validation: lint, typecheck, builds, unit tests, and backup regression tests
npm run validate

# PostgreSQL-backed integration suites use one disposable database per run.
# They prefer host PostgreSQL and are designed to fall back to a unique
# postgres:15 container when no host server is reachable (not yet live-tested).
npm run test:integration:local

# E2E provisions the same disposable database before cleanup, seed, API, Vite, and Playwright.
# It never targets the configured persistent development database.

npm run test:e2e:local
# Externally managed test database (migrations, seed, and cleanup are destructive):
# MONRAD_TEST_DATABASE_URL="postgresql://user@host:5432/db_name" MONRAD_ALLOW_EXTERNAL_TEST_DATABASE=1 npm run test:integration:local
# When set, MONRAD_TEST_DATABASE_URL IS the exact externally managed database —
# migrations, seed, and cleanup run directly against it; it is never auto-created
# or auto-dropped. Both variables are required for opt-in.

Temporary test databases are named uniquely per worktree/run, connections are
terminated before dropping them, and cleanup runs after success or failure. If
an interrupted process leaves a temporary database or container behind, inspect
the leftover resources first — list databases with
`SELECT datname FROM pg_database WHERE datname LIKE 'monrad_test_%'` and
containers with `docker ps -a --filter name=monrad_pg_` — then verify the exact
name against the configured `DATABASE_URL` (the persistent database is never a
cleanup target), terminate connections, and drop or force-remove each one.
**Never delete by prefix without inspection** — the `monrad_test_` prefix alone
does not prove a candidate is safe to drop. Only comparing the exact name
against the configured `DATABASE_URL` and confirming the lifecycle module owns
the candidate makes cleanup safe. The sample default (`monrad_estimator`) is a
common persistent-development-database name, but any name may be configured.

---

## Phases & Progress

### ✅ Phase 1 — Foundation
Repo setup, Vite + React + TypeScript + Tailwind, Express + Prisma, DB schema, JWT auth, project CRUD.

### ✅ Phase 2 — Backlog Builder
Backlog hierarchy (Epic → Feature → Story → Task), tree view UI, manual entry, resource type management, bidirectional hours/days input. CSV export/import with 3-step staging workflow, upsert-by-hierarchy re-import, status columns (EpicStatus/FeatureStatus/StoryStatus), and Template link on stories.

### ✅ Phase 3 — Template Library
Feature Template data model + API, Template Library UI, template-based backlog generation (select template + complexity → creates tasks). Globally unique template names enforced. Templates linkable to stories via CSV import/export.

### ✅ Phase 4 — Effort Review
Effort summary API grouped by resource type and epic. Summary view with expandable epic sub-rows, cost columns (day rate + estimated cost, conditional on rate data), and category subtotals. Detail view with Excel-like column filters (Epic, Feature, Story, Resource Type dropdowns + task name text search), cascading filter dropdowns, cost per task, and totals rows. Active-scope toggle to focus on in-scope items only.

### ✅ Phase 5 — Timeline Planner
Timeline data model + API with dependency-aware auto-scheduler, proportional pool resource levelling, and fractional-week durations. SVG Gantt chart with feature and story bars, drag-and-drop manual scheduling with override indicators, inter-feature dependency arrows, sequential/parallel epic mode toggle, resource demand histogram, custom feature colours (colour picker saved to `Feature.timelineColour`), over-allocation indicators (red dot on Gantt bars in over-allocated weeks), and onboarding/buffer zone visualisation (amber onboarding zone at chart start, indigo buffer zone at chart end). Inline edit panel for start week, duration, and feature dependencies. CSV export (Gantt + resource demand + named resources) and full-width PNG export (dark-mode aware).

### ✅ Phase 6 — Resource Profile
Per-resource hours/days/cost aggregation with epic → feature → story drill-down, configurable overhead items (% of task days, fixed total days, days per week × project duration), stacked bar chart, FTE calculation, dual CSV exports (resource profile + full project zip). Per-resource `hoursPerDay` and `dayRate` overrides support multi-locale teams (e.g. AU 7.6h vs NZ 8h). Onboarding/buffer weeks panel: onboarding weeks allocated to Full Project and Overhead resources before delivery begins; buffer weeks appended at project end. Allocation mode-aware named resource bars on Timeline (FULL_PROJECT spans full project; TIMELINE uses derived or manual range; T&M shows demand bars). Cost Summary Period column shows mode-correct date ranges. See [#6](https://github.com/NickMonrad/monrad-estimator/issues/6).

### ✅ Phase 7 — Document Generation
Server-side PDF scope document via Puppeteer (headless Chrome). TipTap rich text editor on all description/assumptions fields (Epic, Feature, Story, Task, Project). Sections: Cover, Overview, Scope Summary, Effort Breakdown, Gantt Chart (server-side SVG), Timeline Summary, Resource Profile, Assumptions — all toggleable. Document grid with metadata cards (label, sections pills, date, author). Timezone-aware document labels and filenames. HTML preserved in CSV export for lossless round-trip. Phase 7a shipped in [#129](https://github.com/NickMonrad/monrad-estimator/pull/129); v2 (Puppeteer + TipTap) in [#166](https://github.com/NickMonrad/monrad-estimator/pull/166). See [#7](https://github.com/NickMonrad/monrad-estimator/issues/7).

### 🚧 Phase 8 — Cost Basis & Rate Cards *(partially started)*
Day rates per resource type (global defaults + project overrides) and cost columns in Effort Review are shipped. Remaining: per-resource-type discounts, project-level discounts (value/duration/manual), cost summary UI, cost section in SOW. See [#8](https://github.com/NickMonrad/monrad-estimator/issues/8).

### 🚧 Phase 9 — AI Backlog Generator *(not started)*
"Generate from brief" using OpenAI or Claude, AI-suggested templates at appropriate complexity. See [#9](https://github.com/NickMonrad/monrad-estimator/issues/9).

---

## Screenshots

| Projects | Backlog |
|---|---|
| ![Projects](docs/screenshots/projects.png) | ![Backlog](docs/screenshots/backlog.png) |

| Timeline | Templates |
|---|---|
| ![Timeline](docs/screenshots/timeline.png) | ![Templates](docs/screenshots/templates.png) |

| Resource Profile | Effort Review |
|---|---|
| ![Resource Profile](docs/screenshots/resource-profile.png) | ![Effort Review](docs/screenshots/effort-review.png) |

> Screenshots are auto-generated by running `npm run screenshots` from the repo root.

---

## Shipped Enhancements (post-phase)

| Enhancement | PR |
|---|---|
| Global resource type catalog + project instances | #27 |
| Configurable hours/day per project + project settings | #20 |
| Resource type propagation + referential integrity | #32 |
| Backlog UX — auto-expand after creation | #31 |
| Template task reorder, refresh from template, backlog version history | #36 |
| Backlog CSV export/import with 3-step staging workflow | #37 |
| Backlog drag-and-drop reorder (all levels + cross-parent moves) | #40 |
| XS (extra small) complexity level | #40 |
| DurationDays auto-calculated from hoursEffort across all creation paths | #40 |
| Nullable resource type on tasks (CSV import resilience) | #51 |
| Per-resource hoursPerDay + dayRate; snapshot rollback perf | #54 |
| Phase 6: Resource Profile — FTE, overhead, cost, chart, CSV exports | #55 |
| README Phase 6 status + resource-profile screenshot | #63 |
| Phase 7 CI pipeline, timeline dependency scheduler, resource levelling, fractional weeks | #95 |
| Deactivate epics/features/stories to mark as out of scope | #100 |
| SVG Gantt overhaul: story bars, drag-and-drop, dependency arrows, proportional pool scheduler, resource histogram, clear-all-overrides, tooltip enhancements | #106 |
| Backlog CSV export removes complexity-tier columns (HoursXS–XL); import retains backwards compat | #107 |
| Backlog CSV redesign: Type column, per-level status (EpicStatus/FeatureStatus/StoryStatus), Template link on stories, upsert-by-hierarchy import, unique template names, export filename includes client/project/date, DurationDays precision fix | #110 |
| Resource Profile: fix inherited global day rates not applied to cost calculation | #111 |
| Effort Review: active-scope filter toggle, cost columns (day rate + total), expandable epic sub-rows in summary, Excel-like column filters in detail view, cost + totals in detail | #112 |
| Effort Review enhancements — cost columns, active filter, epic breakdown, detail column filters | #113 |
| Resource Profile & Commercial overhaul — named resources, rate cards, discounts, GST | #118 |
| Remove Westpac branding references | #120 |
| Effort Review CSV export (summary + detail, respects active filter and hasCost flag) | #120 |
| Fix new project resource type seeding (was hardcoded, now uses live global catalog) | #122 |
| Project-level resource type management screen — add/remove/override rates per project | #122 |
| Fix CSV import 413 payload-too-large error on large backlogs | #127 |
| Per-named-resource allocation modes (Full Project / Timeline / Custom) + Commercial tab overhaul | #131 |
| Resource period start/end dates, buffer weeks indicators, commercial double-count fix, allocation label fix, CSV epic/feature descriptions + assumptions, Epic.assumptions field, document assumptions section, LAB3 colour scheme, PDF heading fixes | #132 |
| PDF cover page: generated-by username, generation time, document label, projected end date; backlog CSV fix for epic/feature descriptions; commercial tab removes aggregate row; auto-create person on resource type creation; assumptions exclude out-of-scope items | #135 |
| Comprehensive dark mode theming across all pages and components; standardised headers with M icon, ThemeToggle, and breadcrumb nav on all global and project pages; SVG dark mode (Gantt, histogram, named resources) via `useIsDark` hook; epic/feature/story colour hierarchy in dark mode | #143 |
| Document generator: normalise customer data for PDF rendering, harden cover-page layout, and replace fragile scope summary table layout with long-content-safe rendering | #155 |
| Timeline & Resource Profile enhancements — person-first model, over-allocation indicators, custom feature colours, onboarding/buffer zones, PNG/CSV export, allocation mode-aware named resources | #164 |
| Doc Generator v2 — Puppeteer server-side PDF, TipTap rich text editor (all description/assumptions fields), Overview section in scope doc, timezone-aware timestamps on document label and filename | #166 |
| Doc Generator v2 (continued) — redesigned Documents page (generation panel + document grid), Gantt chart section (server-side SVG), sections metadata on document cards, project name in label/filename, HTML preserved in CSV export for round-trip fidelity | #166 |
| Quick wins — dark mode description contrast, project settings tax/onboarding fields, backlog feature mode (sequential/parallel) badges, scope toggle pill redesign, CSV import row colouring, unrated resource warning improvements; Gantt PDF sanitize-html fix + landscape page; pin axios to 1.14.0 (supply chain safety) | #220 |
| Backlog dependency tracking — EpicDependency schema + API (circular dep detection), epic dep hard constraints in timeline scheduler, epic dep arrows on Timeline Gantt, dep selector UI on backlog epic/feature rows, EpicDependsOn/FeatureDependsOn columns in CSV import/export | #228 |
| Timeline scale toggle (week/month/quarter/year), cross-epic FeatureDependsOn in CSV, TemplateSize column in backlog CSV for template task auto-expand; Year scale (H1/H2 top row, Q1–Q4 bottom row); allocation mode/% + timeline start/end weeks in Resource Counts; Expand All / Collapse All toggle; dep picker search filter; top scrollbar mirror; full-width Gantt layout; named resource per-person T&M histogram; onboarding/buffer zone calc fix; auto-reschedule prevention on resource changes | #231 |
| Document export — paginate Project Timeline Gantt across multiple A4-landscape pages so all epics and features are visible on large projects (previously clipped to the first ~3-4 epics) | #238 |
| Resource Optimiser — Phase 4 frontend drawer with mode selector (speed/utilisation/balanced), per-RT count constraints, optional budget/duration ceilings, ranked candidate cards with KPI deltas, and apply-with-snapshot rollback | #239 |
| Timeline workflow cleanup — canonical Update timeline CTA, hidden Level current timeline action, advanced planning copy updates | #314 |
| Resource Counts allocation controls — stable named-resource columns, clearer planning-basis labels, preserved mode switching/start/end/allocation updates, and stale-banner behaviour | #315 |
| Squad Planner profile-first boundary — legacy-state adoption, persisted profile authority, atomic undo, capacity-plan snapshot v3, cross-surface parity, and regression coverage | #374 |
| Windows E2E local runner — unified env loading (server/.env + shell), cleanup-before-seed, resolved env across all processes | #354 |
---

## Open Issues & Backlog

### 🐛 Bugs
| # | Title |
|---|---|
| [#67](https://github.com/NickMonrad/monrad-estimator/issues/67) | Investigate and fix two flaky Playwright tests (backlog.spec.ts) |

### 🔧 Near-term enhancements
| # | Title |
|---|---|
| [#108](https://github.com/NickMonrad/monrad-estimator/issues/108) | docs: comprehensive functional specification (`docs/FUNCTIONAL_SPEC.md`) |

### 🚀 Feature ideas
| # | Title |
|---|---|
| [#35](https://github.com/NickMonrad/monrad-estimator/issues/35) | Backlog version history — diff UI and compare view (snapshots + rollback already shipped) |
| [#70](https://github.com/NickMonrad/monrad-estimator/issues/70) | Locale and currency settings (default AU/AUD) |
| [#71](https://github.com/NickMonrad/monrad-estimator/issues/71) | Public holiday calendars for resource/cost modelling by locale |
| [#72](https://github.com/NickMonrad/monrad-estimator/issues/72) | Timezone setting per account (default AEST) |
| [#73](https://github.com/NickMonrad/monrad-estimator/issues/73) | Project financial tracking — upload actuals CSV, project over/under-spend |
| [#74](https://github.com/NickMonrad/monrad-estimator/issues/74) | Terms of use page + required acceptance checkbox at signup |
| [#75](https://github.com/NickMonrad/monrad-estimator/issues/75) | Support contact form + footer links (FAQ, How-to) |
| [#76](https://github.com/NickMonrad/monrad-estimator/issues/76) | Export backlog to Azure DevOps Boards |
| [#24](https://github.com/NickMonrad/monrad-estimator/issues/24) | Per-resource overhead configuration |
| [#22](https://github.com/NickMonrad/monrad-estimator/issues/22) | Project sharing / multi-user collaboration |
| [#10](https://github.com/NickMonrad/monrad-estimator/issues/10) | Password reset flow |
| [#114](https://github.com/NickMonrad/monrad-estimator/issues/114) | Cross-project dashboard with summary analytics |


### 🏭 Productionisation
| # | Title |
|---|---|
| [#77](https://github.com/NickMonrad/monrad-estimator/issues/77) | Productionisation tracking issue |
| [#78](https://github.com/NickMonrad/monrad-estimator/issues/78) | Security review — application code |
| [#79](https://github.com/NickMonrad/monrad-estimator/issues/79) | Azure architecture design (non-prod + prod) |
| [#80](https://github.com/NickMonrad/monrad-estimator/issues/80) | Infrastructure as code (Bicep or Terraform) |
| [#81](https://github.com/NickMonrad/monrad-estimator/issues/81) | Security review — infrastructure design |
| [#82](https://github.com/NickMonrad/monrad-estimator/issues/82) | Deployment pipeline — infrastructure |
| [#83](https://github.com/NickMonrad/monrad-estimator/issues/83) | CI pipeline on main branch merge |
| [#84](https://github.com/NickMonrad/monrad-estimator/issues/84) | Branching strategy / GitOps approach |
| [#85](https://github.com/NickMonrad/monrad-estimator/issues/85) | Deployment pipeline — application code |
| [#86](https://github.com/NickMonrad/monrad-estimator/issues/86) | Penetration testing |
| [#87](https://github.com/NickMonrad/monrad-estimator/issues/87) | Resiliency, availability, and scalability |
| [#88](https://github.com/NickMonrad/monrad-estimator/issues/88) | Alerting and monitoring |
| [#89](https://github.com/NickMonrad/monrad-estimator/issues/89) | Entra ID / OIDC authentication provider |

### 🎉 Fun
| # | Title |
|---|---|
| [#34](https://github.com/NickMonrad/monrad-estimator/issues/34) | Geocities theme |
| [#90](https://github.com/NickMonrad/monrad-estimator/issues/90) | Use issues backlog as screenshot test data |
| [#91](https://github.com/NickMonrad/monrad-estimator/issues/91) | Custom profile picture upload |

---

## E2E Tests

Playwright tests are documented in [`e2e/TESTS.md`](e2e/TESTS.md). See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to run them and what's required before raising a PR.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for branching strategy, PR process, commit message format, and testing standards.
