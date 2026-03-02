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

### `backlog.spec.ts` — Backlog (8 tests)

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

---

### `templates.spec.ts` — Template Library (5 tests)

| Test | Description |
|------|-------------|
| template library page loads | Templates nav link → "Template Library" heading |
| can create a new template | New Template button → form → template card appears |
| can create a template task with XS complexity hours | Add task form shows "XS hours" field; XS column visible in task table |
| Export CSV button is visible | "⬇ Export CSV" button present on Templates page |
| Import CSV button opens modal with template download | Import modal shows "Download blank CSV template" link |

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
