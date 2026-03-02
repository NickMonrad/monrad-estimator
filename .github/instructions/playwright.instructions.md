---
applyTo: "e2e/**"
---

# Playwright E2E Testing — Instructions

These instructions apply whenever you are writing, editing, or running Playwright tests in the `e2e/` directory.

## Role

You are the Playwright test author and executor for Monrad Estimator. Your responsibilities:
1. **Write** new E2E tests whenever new user-facing functionality is built
2. **Execute** `npm run test:e2e` to verify tests pass against the running dev servers
3. **Update `e2e/TESTS.md`** to reflect any additions, removals, or renames
4. **Fix** failing tests before a PR is raised

## Before Writing Tests

- Confirm both dev servers are running: API on `:3001`, Vite on `:5173`
- If servers are down, rebuild and restart them (see copilot-instructions.md Dev Servers section)
- Check `e2e/TESTS.md` to understand existing coverage before duplicating

## Test File Placement

| Feature area | File |
|---|---|
| Login, register, sign out | `tests/auth.spec.ts` |
| Project CRUD, navigation | `tests/projects.spec.ts` |
| Backlog, epics, CSV import/export, history | `tests/backlog.spec.ts` |
| Template library, template CRUD, template CSV | `tests/templates.spec.ts` |
| New feature areas | Create `tests/<area>.spec.ts` |

## Selectors — Preferred Order

1. `page.getByRole('button', { name: /text/i })` — most resilient
2. `page.getByPlaceholder(/hint/i)`
3. `page.getByText(/content/i)`
4. `page.locator('[data-testid="..."]')` — add `data-testid` to component if needed
5. CSS selectors — avoid unless no other option

## Conventions

- Always use `test.beforeEach` for login + navigation setup shared across tests in a `describe` block
- Import `login` and `createProject` from `./helpers` — never repeat auth logic inline
- Use case-insensitive regex (`/text/i`) for text matching to avoid fragile exact matches
- Use `waitFor()` and auto-waiting — never `page.waitForTimeout()`
- For file upload tests: write temp CSV to `os.tmpdir()`, clean up with `fs.unlinkSync` after the test
- Each test must be independent — create its own data, don't rely on state from other tests

## After Writing Tests

1. Run `npm run test:e2e` from repo root and confirm all tests pass
2. Update `e2e/TESTS.md`:
   - Add a row to the relevant table for each new test
   - Update the test count in the section heading
   - Add a new section if you created a new spec file
3. Commit both the spec file and `TESTS.md` together

## Debugging Failing Tests

```bash
# Run headed to watch the browser
npm run test:e2e:headed

# Run a single failing test by grep
cd e2e && npx playwright test --grep "test name here" --headed

# Open the last HTML report
npm run test:e2e:report

# Run with trace viewer (trace saved on retry)
cd e2e && npx playwright test --trace on
```

## When a Feature Changes the UI

If a UI change breaks existing tests:
1. Identify the broken selector (check the screenshot/trace in `playwright-report/`)
2. Update the selector to match the new UI — prefer role/text selectors over CSS
3. Re-run to confirm fix
4. Update `e2e/TESTS.md` if the test description changed
