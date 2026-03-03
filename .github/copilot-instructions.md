# Copilot Instructions — Monrad Estimator

## Project Overview

**Monrad Estimator** is a full-stack project estimation tool replacing a manual spreadsheet process. It produces scoped backlogs, effort summaries, resource profiles, timelines, and eventually SOW documents.

**Repo:** `NickMonrad/monrad-estimator`

## Agent Working Model

This project uses a **Sonnet-orchestrates, Codex-implements** pattern:

| Role | Agent | Responsibility |
|------|-------|----------------|
| **Orchestrator** | Sonnet (this session) | Analysis, planning, coordination, decisions, PR descriptions |
| **Implementor** | `codex-developer` | All code changes — features, bug fixes, refactors, server tests |
| **Test writer** | `playwright-test-engineer` | All Playwright E2E test creation and fixes |

### Rules
- **Sonnet never writes code directly** — all implementation is delegated to `codex-developer`
- **Playwright tests are always delegated** to `playwright-test-engineer`, never written inline
- **Both agents can run in parallel** when a task requires both code changes AND new tests
- Sonnet reviews agent output, spots-checks critical changes, and raises PRs
- If an agent fails twice, Sonnet may attempt the task directly as a fallback

### Typical workflow for a feature/bug fix
```
1. Sonnet: analyse issue, explore codebase, form plan
2. Sonnet: delegate code changes → codex-developer (background if tests also needed)
3. Sonnet: delegate Playwright tests → playwright-test-engineer (parallel with step 2)
4. Sonnet: review both outputs, spot-check, commit & push, raise PR
```

## Stack

| Layer | Technology |
|---|---|
| Client | React + Vite + TypeScript + Tailwind CSS |
| Server | Node.js + Express + TypeScript |
| ORM | Prisma 7 (driver adapter mode) |
| Database | PostgreSQL (Docker: `westpac-pg`, port 5432, db `monrad_estimator`) |
| Auth | JWT (server-side, `Authorization: Bearer <token>`) |
| Testing | Vitest + supertest (server), Vitest + React Testing Library (client) |

## Monorepo Structure

```
/client        React + Vite app
/server        Express + Prisma API
/server/prisma schema.prisma + migrations
```

Root `package.json` has workspaces for both. Run server from `/server`, client from `/client`.

## Dev Servers

### Starting servers (correct procedure)

**Prerequisites — run once after cloning or after `npm ci`:**
```bash
cd /path/to/monrad-estimator
npm install        # installs root devDeps including concurrently
```

**Start both servers together (recommended):**
```bash
cd monrad-estimator
npm run dev        # uses concurrently → API on :3001, Vite on :5173
```

This runs:
- **API:** `tsx watch src/index.ts` on `:3001` (auto-reloads on server changes)
- **Client:** `vite` on `:5173` (HMR, no rebuild needed)

**When using Copilot CLI bash tool — always use detach mode:**
```
mode: "async", detach: true
cd monrad-estimator && npm run dev > logs/dev-servers.log 2>&1
```

**Verify servers are up:**
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:5173   # should be 200
curl -s http://localhost:3001/api/auth/login -X POST -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}' | head -c 20
```

**Killing servers:**
```bash
# Find PIDs
ps aux | grep "tsx\|vite" | grep monrad | grep -v grep | awk '{print $2}'
# Kill each PID individually (pkill is not permitted):
kill <PID1> <PID2> ...
```

### Important notes
- **`npm run dev` requires `concurrently`** — if missing, run `npm install` from the repo root first
- **`nohup ... &` alone is NOT enough** — the process is killed when the shell session exits unless `disown $!` is also called
- **After code changes** always restart: kill old PIDs then run `npm run dev` again
- **Port conflicts:** stale Vite processes pile up on 5173, 5174, etc — always kill by PID before restarting
- After client dep changes clear Vite cache: `rm -rf client/node_modules/.vite`

## Prisma 7 Specifics

- No `url=` in datasource block — connection string goes in `prisma.config.ts` via `PrismaPg` adapter
- Requires `@prisma/adapter-pg` and `previewFeatures = ["driverAdapters"]`
- After schema changes: `npx prisma migrate dev --name <name>` then `npx prisma generate`
- JSON fields (e.g. `BacklogSnapshot.snapshot`) require `as unknown as T` cast when reading back
- When adding new Prisma models or methods, update the global mock in `server/src/test/setup.ts`

## Data Model Hierarchy

```
Project
└── Epic
    └── Feature
        └── UserStory (appliedTemplateId? links to FeatureTemplate)
            └── Task (resourceTypeId? — optional)

ResourceType (project-scoped, links to GlobalResourceType)
GlobalResourceType (global catalog)

FeatureTemplate
└── TemplateTask (order, hoursSmall/Medium/Large/XL, resourceTypeName)

BacklogSnapshot (projectId, snapshot JSON, trigger, label)
```

## Branching & PR Standards

- Default branch: `main`
- Feature branches: `feature/<short-name>` (e.g. `feature/csv-import-export`)
- **Always branch from `main`**, never chain branches
- **Copilot raises PRs, the repo owner merges** — never auto-merge
- PR body must include `Closes #N` for the relevant GitHub issue
- Use `.github/pull_request_template.md` as the PR body structure

## Commit Message Format

```
type(#issue): short description

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

## Before Raising a PR

1. `npm test` passes in `/server` (58 passing; 36 pre-existing failures are known and unrelated)
2. `npx tsc --noEmit` passes in `/server`
3. `npx tsc --noEmit` passes in `/client`
4. `npm run test:e2e` passes from the repo root — requires both dev servers running (API on :3001, Vite on :5173)

## E2E Tests (Playwright)

Tests live in `/e2e/tests/`. Run from repo root:

```bash
npm run test:e2e            # headless (CI)
npm run test:e2e:headed     # with browser window
npm run test:e2e:report     # open last HTML report
```

## E2E Tests (Playwright)

Tests live in `/e2e/tests/`. Run from repo root:

```bash
npm run test:e2e            # headless (CI)
npm run test:e2e:headed     # with browser window
npm run test:e2e:report     # open last HTML report
```

**Test files:**
- `auth.spec.ts` — login, register, sign out
- `projects.spec.ts` — create project, open backlog
- `backlog.spec.ts` — add epic, CSV import/export, history panel
- `templates.spec.ts` — template library, CSV export/import

**Config:** `e2e/playwright.config.ts` — base URL defaults to `http://localhost:5173`, override with `BASE_URL` env var.

**Credentials:** Default test user `test@example.com` / `password123`. Override with `TEST_EMAIL` / `TEST_PASSWORD` env vars.

**When raising a PR:**
1. Add a matching Playwright test to the relevant spec file (or create a new `*.spec.ts`)
2. **Update `e2e/TESTS.md`** — add a row to the table and update the test count
3. Run `npm run test:e2e` and **paste the output into the PR description** under the "E2E Tests" section
4. List each test added or modified by name in the PR description

Full Playwright authoring conventions are in `.github/instructions/playwright.instructions.md` — this file is auto-loaded by Copilot when working in the `e2e/` directory.

## Code Conventions

- **Express routes:** register specific routes (e.g. `/:id/tasks/reorder`) BEFORE parameterised routes (e.g. `/:id/tasks/:taskId`) to avoid param capture
- **TypeScript imports:** use `import type { ... }` for type-only imports — especially `@dnd-kit` types like `DragEndEvent` which are not runtime exports
- **Auth middleware:** all protected routes use `authenticate` from `server/src/middleware/auth.ts`; public routes (e.g. `GET /templates`) skip it
- **Ownership checks:** API routes verify project ownership via `ownedProject(projectId, userId)` before operating
- **Client API calls:** all calls go through `client/src/lib/api.ts` (axios instance with JWT interceptor) — never use raw `fetch` or direct API URLs
- **Nullable fields:** when making schema fields optional (e.g. `resourceTypeId String?`), update all TypeScript types, Maps, and route handlers that assumed non-null

## UI Conventions

- Design system: red (`red-600`) as primary action colour, gray tones for secondary/borders
- Buttons: `bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium` (primary), `border border-gray-200 text-gray-600` (secondary)
- No external UI component libraries — hand-rolled Tailwind components only
- Modals use `fixed inset-0 bg-black/40 flex items-center justify-center z-50`
- Always show loading states and empty states
- Toast/inline feedback preferred over `alert()`

## README

`README.md` is the human-facing project overview. **Keep it current:**

- After any PR is merged to `main`, update `README.md`:
  - Add the enhancement to the "Shipped Enhancements" table with its PR number
  - Update phase status (`🚧` → `✅`) if a phase is completed
  - Keep the "Open Issues & Backlog" table current (remove closed, add new)
- Commit the README update as `docs: update README for <feature>` on the feature branch before raising the PR, or as a follow-up commit to `main` after merge.

## GitHub Issues

- Phases are tracked as issues labelled `phase`
- Future features are labelled `backlog`
- Close issues in PR body with `Closes #N`
- When a feature request is raised mid-session, create a GitHub issue for it

## Known Gotchas

- **Restart local servers after code changes:** After making significant changes (e.g. before/after raising a PR), always restart the local dev servers so the running code reflects the latest changes. Stale server processes will keep serving old code. Check for existing processes with `ps aux | grep tsx` and `ps aux | grep vite`, then restart: `cd server && npx tsx src/index.ts &` and `cd client && npx vite &`.
- **Port conflicts:** stale Vite processes pile up on 5173, 5174, etc. — kill by PID before restarting
- **macOS lsof:** port 3001 shows as `redwood-broker` in lsof output — this is normal
- **Snapshot JSON rollback:** deletes all epics (cascade) then recreates from JSON; re-matches resource types by name; timeline entries are NOT restored
- **`csv-parse` import:** use `from 'csv-parse/sync'` and `from 'csv-stringify/sync'` for synchronous API
- **BacklogSnapshot.createdById:** required field — must be included when creating snapshots
