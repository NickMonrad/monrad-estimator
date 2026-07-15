# Playwright E2E Test Suite

> Auto-generated from `/e2e/tests/`. **Update this file whenever tests are added, removed, or changed.**

## Running Tests

```bash
# From repo root
npm run test:e2e              # headless (use for CI / pre-PR check)
npm run test:e2e:headed       # with browser visible (debugging)
# Local Windows/dev runner starts isolated API/Vite servers and chooses free ports
npm run test:e2e:local
npm run test:e2e:report       # open last HTML report

# From /e2e directory
npx playwright test                        # all tests
npx playwright test auth.spec.ts           # single file
npx playwright test --grep "CSV import"    # filter by name
npx playwright test --ui                   # interactive UI mode
```

**Prerequisites:**
- `npm run test:e2e:local` starts isolated API/Vite servers itself, chooses free ports, and is preferred for local Windows/dev validation.
- `npm run test:e2e`, `npm run test:e2e:headed`, and direct `npx playwright test` expect the app/dev servers to already be running, unless CI/workflow automation starts them separately.

**Credentials:** `TEST_EMAIL` / `TEST_PASSWORD` env vars (default: `test@example.com` / `password123`)

---

## Test Files

### `auth.spec.ts` — Authentication (5 tests)

| Test | Description |
|------|-------------|
| shows login page at root when unauthenticated | Root URL shows sign-in form when no token |
| shows error on invalid credentials | Invalid email/password shows error message |
| can register a new account | New user can register and land on Projects page |
| can sign in with valid credentials | Valid credentials redirect to `/projects` |
| sign out returns to login | Sign Out button clears session and shows login |

#### `Security hardening` describe block (4 tests — `feature/security-sprint-1`)

Tests run in `serial` mode to avoid interleaving concurrent login attempts.

Tests run in `serial` mode to avoid interleaving concurrent login attempts.

| Test | Description |
|------|-------------|
| security headers are present on API responses | POSTs a dummy request to `/api/auth/login` via the `request` fixture and asserts that Helmet's `x-frame-options`, `x-content-type-options`, and `x-dns-prefetch-control` headers are all set on the response |
| registering with an existing email returns success (no enumeration) | Registers a unique user, signs out, then re-registers with the same email. Asserts no "already in use" error is shown and the app lands on the Projects page — confirming the server returns HTTP 200 instead of 409 |
| GET /api/projects returns 401 when no Authorization header is provided | Direct API request (no JWT) via the `request` fixture — asserts HTTP 401 |
| one failed login attempt followed by correct credentials still succeeds | Submits wrong password once (asserts error message), then immediately uses correct credentials — asserts successful login, confirming the rate limit (5/15 min) is not triggered by a single bad attempt |

#### `Security hardening — Sprint 2` describe block (4 tests — `feature/security-sprint-2`)

API-level tests using the `request` fixture. No browser UI involved.

| Test | Description |
|------|-------------|
| document generation rejects path traversal in format field | Logs in to get a JWT, fetches the first project, then POSTs to `/api/documents/generate` with `format: '../../../etc/passwd'` — asserts HTTP 400 |
| GET /api/templates returns 401 when unauthenticated | Direct API request with no Authorization header — asserts HTTP 401 |
| GET /api/global-resource-types returns 401 when unauthenticated | Direct API request with no Authorization header — asserts HTTP 401 |
| POST /api/global-resource-types returns 403 for non-admin user | Logs in as the standard test user (non-admin) and attempts to create a global resource type — asserts HTTP 403 |

---

### `projects.spec.ts` — Projects (4 tests)

| Test | Description |
|------|-------------|
| projects page loads | Authenticated user sees Projects heading |
| can create a new project | New Project button → form → project card appears |
| can open a project backlog | Clicking project card navigates to `/projects/:id` |
| can search/filter projects | Search input filters visible projects (skipped if input absent) |

---

### `backlog.spec.ts` — Backlog (13 tests)

#### `Backlog` describe block (8 tests)

| Test | Description |
|------|-------------|
| backlog page loads with Add epic button | Backlog nav link → "Add epic" button visible |
| can add an epic | Fill epic name form → epic appears in list |
| CSV import button is visible | "⬆ Import CSV" button present on Backlog page |
| CSV export button is visible | "⬇ Export CSV" button present on Backlog page |
| CSV import modal opens and shows template download link | Modal opens → "Download blank CSV template" link visible |
| CSV import shows parse errors on bad file | Uploading malformed CSV shows error/validation message |
| History button toggles history panel | "🕐 History" button reveals the Snapshot History panel |
| drag handle is visible on epics for reordering | Hovering an epic row reveals the ⠿ drag handle for DnD reorder |

#### `CSV redesign — Type column and status fields` describe block (3 tests)

| Test | Description |
|------|-------------|
| export includes Type column and status columns at end | Seeds data via old-format CSV import, then exports and verifies: `Type` is column 0; `EpicStatus`, `FeatureStatus`, `StoryStatus` are the last 3 columns; all 4 row types (Epic/Feature/Story/Task) are present; the Epic row has `active` in `EpicStatus` and empty `FeatureStatus`/`StoryStatus` |
| import with status columns — inactive epic/feature visible after import | Imports a new-format CSV with `EpicStatus=inactive`, `FeatureStatus=inactive`, `StoryStatus=active`, and a plain Task row; asserts the backlog renders the imported epic (inactive items shown with strikethrough but still visible) |
| staging warns when EpicStatus is set on a Task row (wrong type) | Uploads a CSV with a Task row that has `EpicStatus=inactive`; after automatic staging, verifies the yellow warning panel appears with text "Warnings (import will still proceed):" and the message "EpicStatus is only applied on Epic rows" |

#### `Dependencies` describe block (2 tests — PR #228 / issue #226)

| Test | Description |
|------|-------------|
| CSV export includes EpicDependsOn and FeatureDependsOn columns | Seeds a project with one epic + feature via CSV import, exports the backlog CSV, and asserts that both `EpicDependsOn` and `FeatureDependsOn` column headers are present in the exported file |
| epic rows on backlog page show Add dep button | Creates a project, adds one epic via the UI, and asserts the `＋ dep` button (`title="Add epic dependency"`) is visible on the epic row — confirming the dependency UI is rendered on the Backlog page |

---

### `timeline.spec.ts` — Timeline (14 tests)

#### `Timeline` describe block (4 tests)

| Test | Description |
|------|-------------|
| start date persists after navigation (bug #44) | Sets a start date, navigates away, returns — date is still present |
| quick schedule shows projected end date | Create project with epic+feature, run Quick schedule, assert "Projected end:" appears |
| sequential/parallel toggle is visible on epic rows | After scheduling, the mode-toggle button is rendered on every epic header row in the Gantt |
| feature dependency section visible in inline edit panel | Clicking a feature label opens the inline panel which contains the "Depends on" section and the add-dependency select |

#### `Starting Team Finder drawer — open and close` describe block (1 test — Phase 4, issue #233)

| Test | Description |
|------|-------------|
| open and close the drawer | Navigates to a Timeline page, clicks `🔧 Starting Team Finder`, asserts the drawer dialog with accessible name and heading "Starting Team Finder" is visible, clicks the Close (×) button, asserts drawer is removed from the DOM |

#### `Starting Team Finder drawer — with resources` describe block (2 tests — Phase 4, issue #233)

`beforeEach` seeds a project with Developer + Tech Lead tasks via CSV import, navigates to Timeline, and runs Quick schedule. Each test has a 90 s timeout.

| Test | Description |
|------|-------------|
| run optimiser and see results | Opens drawer, clicks `Find starting teams`, waits up to 30 s for the search-stats footer (`Evaluated X team options in Ys`), asserts the baseline card ("Current starting point"), the exact `Starting team options` section label, and at least one candidate card with an `Apply directly` button are visible |
| apply button is present on candidate cards, dialog is dismissed without mutation | Runs the finder, asserts the exact `Starting team options` section label and that candidate cards expose `Apply directly` buttons, clicks the first one, dismisses the browser `confirm()` dialog, and asserts the drawer remains open (no snapshot was created) |

#### `Timeline — Resource-counts layout` describe block (3 tests — issue #369)

`beforeEach` seeds a project with Developer + Tech Lead tasks via CSV import (`CACHE_INV_CSV`), navigates to Timeline, and runs Quick schedule via the `quickSchedule(page)` helper (clicks "Update timeline"). After scheduling, it waits for the `\d+ features scheduled` completion signal, asserts one unique Developer-type resource card via the `devCard(page)` helper (`filter({ has: addButton })` with `toHaveCount(1)`), and waits for the `Add named resource to Developer` button. All mutations install both a response waiter for the mutation's HTTP method and a gated `createEligibleMatcher` Timeline GET watcher before each action; `gate()` enables Timeline-request eligibility immediately before the action. Tests have a 90–120 s timeout.

| Test | Description |
|------|-------------|
| desktop: add named resource, change basis, edit values, verify persistence after reload, remove | At 1440×900, calls `addNamedResourceAndWait` (POST + gated Timeline GET). Asserts server-default availability pattern is **TIMELINE**. Uses `setNamedResourceBasisAndWait` (PATCH + gated Timeline GET) to transition to EFFORT, re-acquires and asserts EFFORT, then same helper transitions back to TIMELINE. Each subsequent PATCH (allocation % → 80, start week → 2, end week → 10) installs both PATCH response and gated-Timeline-GET waiters before the action, then waits for both responses and re-acquires locators. Reloads the page, re-acquires controls, and asserts all four values persisted (TIMELINE, 80, 2, 10) via string `toHaveValue`. Before removal: asserts document scroll-fit + `expectElementToFit` on `resource-counts` panel and `named-resource-row-{nrId}`. Calls `removeNamedResource` (concurrent dialog acceptance, DELETE response, gated Timeline GET); asserts `named-resource-row-{id}` count zero. Post-delete: document fit + `expectElementToFit` on panel only. |
| narrow viewport: column headers and named-resource controls visible, no overflow | At 820×900, verifies column headers (Named resource, Availability pattern, Available %, Available from, Available to) remain visible above `sm` breakpoint via `named-resource-headers` test ID. Calls `addNamedResourceAndWait` (POST + gated Timeline GET). Asserts server-default basis is **TIMELINE**, uses `setNamedResourceBasisAndWait` to transition to EFFORT then back to TIMELINE. Verifies allocation/start/end controls become enabled. Before removal: `expectElementToFit` on panel and `named-resource-row-{nrId}`. Calls `removeNamedResource` (concurrent dialog/DELETE/Timeline GET); asserts row test ID count zero. Post-delete: document fit + `expectElementToFit` on panel. |
| mobile viewport: desktop column headers hidden, inline labels visible, controls reachable, resource-counts panel and rows fit | At 390×844, verifies desktop column headers are **not** visible via stable `named-resource-headers` test ID (below `sm` breakpoint). Calls `addNamedResourceAndWait` (POST + gated Timeline GET). Asserts inline mobile labels (Pattern:, Avail:, Avail from:, Avail to:) via row-scoped `named-resource-row-{id}` test ID. Asserts server-default basis is **TIMELINE**, uses `setNamedResourceBasisAndWait` to transition to EFFORT then back to TIMELINE. Verifies allocation/start/end controls become enabled. Before removal: `expectElementToFit` on panel and `named-resource-row-{nrId}`. Proves vertical stacking order using parent-group bounding boxes (`locator('..')` from each label to its field-group `div`) with 2 px bottom-based group-tolerance (alloc `y ≥ basis·bottom − 2`, start `y ≥ alloc·bottom − 2`, end `y ≥ start·bottom − 2`). Calls `removeNamedResource` (concurrent dialog/DELETE/Timeline GET); asserts row test ID count zero. Post-delete: `expectElementToFit` on panel. |

#### `Timeline — cache invalidation` describe block (1 test)

`beforeEach` seeds a project with Developer + Tech Lead tasks via CSV import (`CACHE_INV_CSV`), navigates to Timeline, and runs Quick schedule via the `quickSchedule(page)` helper.

| Test | Description |
|------|-------------|
| manual feature override clears demand cache | Seeds Developer + Tech Lead tasks via CSV, schedules, manually overrides a feature's start week, navigates to Resource Profile — asserts both resource type rows render with formatted person-day values and Commercial tab cost summary loads (regression: stale `weeklyDemandCache` would cause error/blank page) |

#### `Resource Profile allocation` describe block (3 tests — issue #311)

`beforeEach` seeds a project with Developer + Tech Lead tasks via CSV import (`CACHE_INV_CSV`), navigates to Resource Profile, and verifies the Resource Profile page heading.

| Test | Description |
|------|-------------|
| allocation mode dropdown changes from Timeline to Fixed for whole project | Clicks the allocation badge for the Developer row to open the inline editor; changes mode to `FULL_PROJECT` and sets FTE % to 50; clicks Save |
| Fixed for selected weeks mode shows start/end week inputs and persists | Opens the Developer allocation editor; selects Fixed for selected weeks (TIMELINE); fills start week 2 and end week 10; clicks Save |
| Available % input persists independently | Opens the Developer allocation editor; changes to Fixed for whole project (FULL_PROJECT); sets FTE % to 75; saves and re-opens to verify the 75% value persists |


---

### `gantt.spec.ts` — Gantt Chart (4 tests)

Selectors target the SVG-based Gantt introduced after the CSS-grid rewrite. Each test calls `setupTimeline()` which logs in, creates a project with 1 epic + 1 feature, navigates to the Timeline page, fills the start date, runs Quick schedule, and waits for the "X features scheduled" footer.

| Test | Description |
|------|-------------|
| quick schedule renders feature bars in the Gantt grid | After Quick schedule the SVG contains at least one `<rect>` element (feature bar) |
| epic feature-mode button toggles between sequential and parallel | Clicks the button with `aria-label="sequential"`, asserts it switches to `aria-label="parallel"` |
| clicking a feature bar opens the inline edit panel | Clicks `[title="{featureName}"]` (a `<span>`), asserts Start week + duration inputs appear |
| saving a manual start week shows the ✏ override indicator | Sets start week to 2, saves, asserts the "↺ Reset to auto" button appears (only rendered when `isManual=true`) |

---

### `resource-profile.spec.ts` — Resource Profile & Commercial (8 tests)

#### `Resource Profile` describe block (1 test — original)

| Test | Description |
|------|-------------|
| can edit count for non-engineering resource types | Seeds a task with resource type "Project Manager" via CSV import, navigates to Resource Profile, and asserts the Count cell for that row is an editable `<input type="number">` (only rendered for GOVERNANCE/PROJECT_MANAGEMENT categories) |

#### `Resource Profile — enhanced` describe block (5 tests)

| Test | Description |
|------|-------------|
| resource profile page loads with resource types | Seeds backlog with Developer + Tech Lead tasks via CSV, navigates to `/projects/:id/resource-profile`, verifies "Resource Profile" heading and Developer resource type row appear |
| tab bar shows Resource Profile and Commercial tabs | Verifies both "Resource Profile" and "Commercial" tab buttons are visible; clicks Commercial → asserts "Cost Summary" heading; clicks back → asserts "Summary" heading |
| resource count display shows formatted values | Checks that the Developer resource type row text contains values formatted with 2 decimal places (e.g. `24.00`) |
| named resources — add person | Clicks the Developer resource name to expand the named resources panel; verifies "Named Resources" heading appears; clicks "+ Add person" button; asserts a new input with value "New person" appears |
| commercial tab — discount management | Switches to Commercial tab; verifies "Cost Summary" and "Project Discounts" headings; clicks "+ Add Discount"; asserts the discount form appears with label input and type dropdown |

#### `Resource Profile — cache invalidation from Timeline` describe block (1 test)

| Test | Description |
|------|-------------|
| both resource types show fallback demand after manual feature override | Seeds Developer + Tech Lead via CSV, schedules on Timeline, manually overrides feature start week, navigates to Resource Profile — asserts both resource type rows render with formatted hours and Commercial tab cost summary loads (regression: per-RT cache horizon bug would suppress one RT's fallback) |

#### `Rate Cards` describe block (1 test)

| Test | Description |
|------|-------------|
| rate cards page loads with create button | Navigates to `/rate-cards`; verifies "Rate Cards" heading and "+ Create Rate Card" button are visible |

---

| Test | Description |
|------|-------------|
| template library page loads | Templates nav link → "Template Library" heading |
| can create a new template | New Template button → form → template card appears |
| can create a template task with XS complexity hours | Add task form shows "XS hours" field; XS column visible in task table |
| Export CSV button is visible | "⬇ Export CSV" button present on Templates page |
| Import CSV button opens modal with template download | Import modal shows "Download blank CSV template" link |

---

### `resource-allocation.spec.ts` — Resource Allocation (5 tests)

All tests log in, create a fresh project, import a CSV with Tech Lead + Project Manager tasks, navigate to Resource Profile, and switch to the Commercial tab before running assertions.

| Test | Description |
|------|-------------|
| commercial tab shows allocation badge | Verifies at least one allocation badge is visible in the Commercial table, and its text matches `As needed`, `Fixed for selected weeks`, `Fixed for whole project`, or `Varies by week` |
| allocation editor opens on badge click | Clicks the first allocation badge → asserts the inline editor appears with a "Availability pattern" label, "FTE %" label, mode `<select>`, FTE number input, and Save/Cancel buttons |
| changing FTE % updates allocated days | Opens the editor, sets FTE % to 50, clicks Save → asserts the editor closes and the badge is still present (row remains intact after save) |
| cancel closes editor without changing mode badge | Opens editor, switches mode to Fixed for whole project, clicks Cancel → asserts editor is gone and badge text is unchanged |
| summary tab shows Availability pattern column | Navigates back to Resource Profile tab → asserts the `<th>` with text "Availability pattern" is visible in the summary table |

---

### `effort-review.spec.ts` — Effort Review (7 tests)

| Test | Description |
|------|-------------|
| effort review page loads with summary and detail tabs | Navigates to `/projects/:id/effort`; asserts "Effort Review" heading, Summary/Detail tab buttons, and Active scope toggle are all visible |
| active-scope toggle switches label | Default shows "Active scope"; clicking once switches to "All tasks"; clicking again reverts to "Active scope" |
| summary view shows resource type rows | After seeding data via CSV import, confirms the "Developer" resource type row appears in the summary table |
| clicking a resource type row in summary expands epic sub-rows | Clicks the Developer row; asserts at least one italic epic sub-row (Alpha Epic or Beta Epic) becomes visible |
| detail view filter bar renders correctly | Switches to Detail view; confirms the epic select dropdown and "Showing X of Y tasks" text are visible |
| detail view epic filter cascades to feature dropdown | Selects "Alpha Epic" in the epic filter; asserts Feature dropdown contains "Alpha Feature" but not "Beta Feature" |
| detail view task name filter works | Types "Alpha" in the task name input; asserts "Beta Task" is hidden and the showing count reads "Showing 1 of 2 tasks" |

---


### `global-admin-auth.spec.ts` — Global Admin Auth (16 tests — issue #258)

#### `Global admin auth — regular user` describe block (2 tests — serial)

Creates a fresh regular user via API + DB to verify read-only UX.

| Test | Description |
|------|-------------|
| Resource Types page shows read-only state for regular user | Navigates to `/resource-types` as a fresh regular user; asserts "Global resources can only be edited by a global admin." notice is visible; asserts "+ Add resource type" button is absent; asserts table headers include `Access` column; asserts body rows show "Read only" badge |
| Rate Cards page shows read-only state for regular user | Navigates to `/rate-cards` as a fresh regular user; asserts "Rate cards can only be edited by a global admin." notice is visible; asserts "+ Create Rate Card" button absent; asserts rate card list items show "Read only" badge |

#### `Global admin auth — API guards for regular user` describe block (6 tests — serial)

Creates a fresh regular user via API. Tests run as direct API `request` calls (no browser).

| Test | Description |
|------|-------------|
| POST /api/global-resource-types returns 403 for regular user | Attempts to create a global resource type — asserts HTTP 403 |
| PUT /api/global-resource-types/:id returns 403 for regular user | Attempts to update a global resource type — asserts HTTP 403 |
| DELETE /api/global-resource-types/:id returns 403 for regular user | Attempts to delete a global resource type — asserts HTTP 403 |
| POST /api/rate-cards returns 403 for regular user | Attempts to create a rate card — asserts HTTP 403 |
| PUT /api/rate-cards/:id returns 403 for regular user | Attempts to update a rate card — asserts HTTP 403 |
| DELETE /api/rate-cards/:id returns 403 for regular user | Attempts to delete a rate card — asserts HTTP 403 |

#### `Global admin auth — admin user` describe block (2 tests — serial)

Creates a fresh admin user (via API registration + DB role update). Tests browser UI flows.

| Test | Description |
|------|-------------|
| Resource Types page shows admin controls and allows CRUD | Navigates to `/resource-types` as admin; asserts admin controls visible; creates a uniquely named resource type; edits it (changes name and description); deletes it; asserts each step's result visible |
| Rate Cards page shows admin controls and allows creation | Navigates to `/rate-cards` as admin; asserts "+ Create Rate Card" button visible; creates a rate card via modal (name + Developer entry at $1100/day); asserts it appears in the list; optionally sets as default and verifies badge |

#### `Global admin auth — API success for admin user` describe block (6 tests — serial)

Creates a fresh admin user (via API registration + DB role update). Tests run as direct API `request` calls (no browser).

| Test | Description |
|------|-------------|
| POST /api/global-resource-types succeeds for admin | Creates a global resource type — asserts HTTP 201 and name match |
| PUT /api/global-resource-types/:id succeeds for admin | Updates the created resource type — asserts HTTP 200 |
| DELETE /api/global-resource-types/:id succeeds for admin | Deletes the created resource type — asserts HTTP 204 |
| POST /api/rate-cards succeeds for admin | Creates a rate card with a Developer entry — asserts HTTP 201 and name match |
| PUT /api/rate-cards/:id succeeds for admin | Updates the created rate card name — asserts HTTP 200 |
| DELETE /api/rate-cards/:id succeeds for admin | Deletes the created rate card — asserts HTTP 204 |

---

## Adding New Tests

1. Add tests to the relevant spec file (or create a new `*.spec.ts` if the feature area is new)
2. Use helpers from `tests/helpers.ts` (`login`, `createProject`) to avoid repeating auth setup
3. Update this file — add a row to the relevant table and update the test count in the section heading
4. Run `npm run test:e2e` to verify before raising a PR

### Test writing conventions

- Use `page.getByRole()` and `page.getByPlaceholder()` over CSS selectors — they're more resilient
- Use `page.getByText()` for content assertions
- Use `test.beforeEach` to handle common setup (login, navigation)
- Avoid hardcoded `page.waitForTimeout()` — use `waitFor()` or built-in auto-waiting instead
- Tests that depend on pre-existing data should create their own data in `beforeEach`
- File upload tests: write a temp file to `os.tmpdir()` and clean up with `fs.unlinkSync` after

### Helper reference

```ts
import { login, createProject, createTestUser, createUserAndLogin, TEST_EMAIL, TEST_PASSWORD } from './helpers'

// login(page)                       — navigates to / and signs in with seed user, waits for /projects
// createProject(page, name)         — clicks New Project, fills name, submits
// createTestUser(role?)             — creates unique test user (USER/ADMIN) via API + optional DB role update
// createUserAndLogin(page, role?)   — creates test user and logs in via browser UI
```

---

## Config Reference (`playwright.config.ts`)

| Option | Value |
|--------|-------|
| Test directory | `./tests` |
| Base URL | `process.env.BASE_URL ?? 'http://localhost:5173'` |
| Timeout | 30 seconds per test |
| Retries | 1 (on failure) |
| Browser | Chromium (headless) |
| Trace | Saved on first retry |
| Screenshots | Saved on failure only |
| Report | HTML → `playwright-report/` |
