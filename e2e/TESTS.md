# Playwright E2E Test Suite

> Auto-generated from `/e2e/tests/`. **Update this file whenever tests are added, removed, or changed.**

## Running Tests

```bash
# From repo root
npm run test:e2e              # headless (use for CI / pre-PR check)
npm run test:e2e:headed       # with browser visible (debugging)
npm run test:e2e:report       # open last HTML report

# From /e2e directory
npx playwright test                        # all tests
npx playwright test auth.spec.ts           # single file
npx playwright test --grep "CSV import"    # filter by name
npx playwright test --ui                   # interactive UI mode
```

**Prerequisites:** Both dev servers must be running:
- API: `node dist/index.js` on `:3001`
- Client: `npx vite` on `:5173`

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

---

### `projects.spec.ts` — Projects (4 tests)

| Test | Description |
|------|-------------|
| projects page loads | Authenticated user sees Projects heading |
| can create a new project | New Project button → form → project card appears |
| can open a project backlog | Clicking project card navigates to `/projects/:id` |
| can search/filter projects | Search input filters visible projects (skipped if input absent) |

---

### `backlog.spec.ts` — Backlog (11 tests)

#### `Backlog` describe block (8 tests)

| Test | Description |
|------|-------------|
| backlog page loads with Add epic button | Backlog nav link → "Add epic" button visible |
| can add an epic | Fill epic name form → epic appears in list |
| CSV import button is visible | "⬆ Import CSV" button present on Backlog page |
| CSV export button is visible | "⬇ Export CSV" button present on Backlog page |
| CSV import modal opens and shows template download link | Modal opens → "Download blank CSV template" link visible |
| CSV import shows parse errors on bad file | Uploading malformed CSV shows error/validation message |
| History button toggles history panel | "🕐 History" button reveals Backlog History panel |
| drag handle is visible on epics for reordering | Hovering an epic row reveals the ⠿ drag handle for DnD reorder |

#### `CSV redesign — Type column and status fields` describe block (3 tests)

| Test | Description |
|------|-------------|
| export includes Type column and status columns at end | Seeds data via old-format CSV import, then exports and verifies: `Type` is column 0; `EpicStatus`, `FeatureStatus`, `StoryStatus` are the last 3 columns; all 4 row types (Epic/Feature/Story/Task) are present; the Epic row has `active` in `EpicStatus` and empty `FeatureStatus`/`StoryStatus` |
| import with status columns — inactive epic/feature visible after import | Imports a new-format CSV with `EpicStatus=inactive`, `FeatureStatus=inactive`, `StoryStatus=active`, and a plain Task row; asserts the backlog renders the imported epic (inactive items shown with strikethrough but still visible) |
| staging warns when EpicStatus is set on a Task row (wrong type) | Uploads a CSV with a Task row that has `EpicStatus=inactive`; after automatic staging, verifies the yellow warning panel appears with text "Warnings (import will still proceed):" and the message "EpicStatus is only applied on Epic rows" |

---

### `timeline.spec.ts` — Timeline (4 tests)

| Test | Description |
|------|-------------|
| start date persists after navigation (bug #44) | Sets a start date, navigates away, returns — date is still present |
| auto-schedule shows projected end date | Create project with epic+feature, run Auto-schedule, assert "Projected end:" appears |
| sequential/parallel toggle is visible on epic rows | After scheduling, the mode-toggle button is rendered on every epic header row in the Gantt |
| feature dependency section visible in inline edit panel | Clicking a feature label opens the inline panel which contains the "Depends on" section and the add-dependency select |

---

### `gantt.spec.ts` — Gantt Chart (4 tests)

Selectors target the SVG-based Gantt introduced after the CSS-grid rewrite. Each test calls `setupTimeline()` which logs in, creates a project with 1 epic + 1 feature, navigates to the Timeline page, fills the start date, runs Auto-schedule, and waits for the "X features scheduled" footer.

| Test | Description |
|------|-------------|
| auto-schedule renders feature bars in the Gantt grid | After auto-schedule the SVG contains at least one `<rect>` element (feature bar) |
| epic feature-mode button toggles between sequential and parallel | Clicks the button with `aria-label="sequential"`, asserts it switches to `aria-label="parallel"` |
| clicking a feature bar opens the inline edit panel | Clicks `[title="{featureName}"]` (a `<span>`), asserts Start week + duration inputs appear |
| saving a manual start week shows the ✏ override indicator | Sets start week to 2, saves, asserts the "↺ Reset to auto" button appears (only rendered when `isManual=true`) |

---

### `resource-profile.spec.ts` — Resource Profile & Commercial (7 tests)

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
import { login, createProject, TEST_EMAIL, TEST_PASSWORD } from './helpers'

// login(page)           — navigates to / and signs in, waits for /projects
// createProject(page, name) — clicks New Project, fills name, submits
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
