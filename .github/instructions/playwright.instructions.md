---
applyTo: "e2e/**"
---

# Playwright E2E Testing Instructions

These rules apply when writing, editing, or running Playwright tests under `e2e/`. They extend `.github/instructions/project.instructions.md`.

## When E2E coverage is required

Add or update Playwright tests when a change affects:

- user-visible behaviour or navigation
- form validation, permissions, or authentication
- persistence across pages or sessions
- critical Timeline, Resource Profile, Commercial, or document workflows
- a bug whose regression is best observed through the browser or public API

Documentation-only changes, internal refactors with unchanged behaviour, and narrowly scoped server changes may use focused lower-level tests instead. Record why E2E is not applicable in the PR.

## Preferred local runner

For local agent validation, run from the repository root:

```bash
npm run test:e2e:local
```

The local runner owns:

- loading the local server environment
- applying migrations and generating Prisma
- cleaning and seeding E2E data
- selecting available API and client ports
- starting API and Vite processes
- running Playwright with screenshots excluded
- shutting down child processes on Windows, macOS, and Linux

Pass Playwright filters after `--`:

```bash
npm run test:e2e:local -- --grep "test name"
```

Do not manually start, kill, or reuse dev servers around the isolated runner.

`npm run test:e2e`, `npm run test:e2e:headed`, and direct `npx playwright test` expect suitable servers to already be running and should be used only when that process lifecycle is intentionally owned by the caller or CI.

## Before writing tests

- Read `e2e/TESTS.md` and the relevant existing specs before adding coverage.
- Inspect the live component and API contract so selectors and expected behaviour match the implementation.
- Prefer extending the nearest feature spec over creating a new file for one test.
- Use existing helpers from `tests/helpers.ts` rather than duplicating authentication or project setup.

## Test file placement

| Feature area | Preferred file |
|---|---|
| Login, registration, sign out, auth hardening | `tests/auth.spec.ts` |
| Project CRUD and project navigation | `tests/projects.spec.ts` |
| Backlog, hierarchy, CSV, snapshots, dependencies | `tests/backlog.spec.ts` |
| Timeline and scheduling behaviour | `tests/timeline.spec.ts` or `tests/gantt.spec.ts` |
| Resource Profile and Commercial behaviour | the existing resource-profile/allocation spec |
| Template library and template CSV | `tests/templates.spec.ts` |
| New substantial feature area | `tests/<area>.spec.ts` |

## Selector order

Prefer selectors in this order:

1. `page.getByRole()` with an accessible name
2. `page.getByLabel()`
3. `page.getByPlaceholder()`
4. `page.getByText()` for stable content assertions
5. `page.getByTestId()` when semantic selectors are not practical
6. narrowly scoped CSS selectors only as a last resort

Add accessible names or labels to the product before adding brittle selectors. Do not use selectors tied to generated class names or DOM position when a semantic contract is available.

## Test conventions

- Each test creates or identifies its own data and must not depend on another test's side effects.
- Use `test.beforeEach` for shared setup within a describe block.
- Reuse `login`, `createProject`, `createTestUser`, and `createUserAndLogin` from `tests/helpers.ts`.
- Prefer Playwright auto-waiting and web-first assertions.
- Never add `page.waitForTimeout()` to hide a race; wait for the actual UI, response, or state transition.
- Use case-insensitive regex only when case is not part of the contract.
- Keep exact text assertions when the wording itself is a required UX or accessibility contract.
- File-upload tests write temporary files under `os.tmpdir()` and remove them in cleanup.
- API-level tests may use Playwright's `request` fixture when browser interaction adds no value.
- Avoid broad serial mode; use it only when shared rate limits or unavoidable global state require it.

## Validation and documentation

After changing tests:

1. Run the smallest relevant filtered test while developing.
2. Run the complete local E2E suite with `npm run test:e2e:local` when prerequisites are available.
3. Update `e2e/TESTS.md` for added, removed, renamed, or materially changed tests.
4. Record the exact command and result in the PR description.
5. List each added or modified test by spec and test name.

Do not report a hard-coded expected suite count. Report the actual result from the completed run.

## Direct-run cleanup

The isolated local runner cleans E2E data before seeding. When tests are run directly against a persistent dev server/database, clean test data when appropriate with:

```bash
cd server
npm run e2e:cleanup
```

Do not clean a shared or non-development database.

## Debugging

```bash
npm run test:e2e:local -- --grep "test name"
npm run test:e2e:headed
cd e2e && npx playwright test --grep "test name" --trace on
npm run test:e2e:report
```

Use traces, screenshots, network responses, and the current component source to identify the real failure. Do not immediately weaken assertions or add retries when the product is incorrect.
