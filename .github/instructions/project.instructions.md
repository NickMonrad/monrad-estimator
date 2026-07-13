---
applyTo: "**"
---

# Monrad Estimator Agent Instructions

## Authority and precedence

This file is the canonical repository-wide instruction contract for implementation, testing, review, and pull-request work in Monrad Estimator.

- Path-scoped files under `.github/instructions/` may add rules for their area, but must not contradict this file.
- Custom agent definitions under `.github/agents/` describe capabilities only; they inherit these rules and must not duplicate volatile project facts.
- `.github/copilot-instructions.md` is a Copilot entry point, not a second source of project rules.
- A direct user instruction overrides repository guidance only for the requested task and only when it is safe.
- When two repository files conflict, follow this file and report the conflict.

## Project summary

Monrad Estimator is a full-stack estimation application that produces scoped backlogs, effort summaries, resource profiles, delivery timelines, commercial estimates, and document outputs.

### Stack

- Client: React, Vite, TypeScript, Tailwind CSS
- Server: Node.js, Express, TypeScript
- Data: Prisma 7 in driver-adapter mode with PostgreSQL
- Authentication: JWT bearer tokens
- Unit/integration tests: Vitest, React Testing Library, supertest
- End-to-end tests: Playwright

### Repository layout

```text
client/          React application
server/          Express API and server tests
server/prisma/   Prisma schema and migrations
e2e/             Playwright tests
scripts/         Cross-platform repository utilities
```

The root `package.json` owns workspace-wide commands.

## Capability-based working model

Do not assume a particular model, orchestrator, or named sub-agent exists.

An implementation agent may analyse, modify code, add appropriate tests, update documentation, and prepare a pull request. Specialist agents may be used when available, but their absence must never block ordinary repository work.

For each task:

1. Read the issue, relevant code, tests, and applicable path-scoped instructions.
2. Identify the current source of truth and affected API/data/UI contracts.
3. Prefer the smallest correct change that fully satisfies the acceptance criteria.
4. Add focused tests at the lowest useful level and E2E coverage when user-visible behaviour changes.
5. Run the relevant validation commands and report exact results.
6. Update documentation that became inaccurate because of the change.
7. Prepare the branch and pull request for human review.

Do not ask for guidance on routine implementation choices that can be resolved from existing patterns. Escalate genuine ambiguity, destructive data impact, security trade-offs, or scope that materially exceeds the issue.

## Git and human-review safety

Agents must never:

- push directly to `main`
- merge a pull request
- enable auto-merge
- approve their own pull request
- close the tracked issue manually when the PR should close it
- force-push or rewrite shared history without explicit user approval
- discard unrelated worktree changes
- bypass failing required checks

Branch from current `main` and use:

- `feature/<issue>-<slug>` for features and planned improvements
- `fix/<issue>-<slug>` for defects
- `docs/<issue>-<slug>` for documentation-only work

Commit messages use:

```text
type(#issue): short description
```

Valid types include `feat`, `fix`, `refactor`, `docs`, `test`, and `chore`.

Do not add a hard-coded Copilot co-author trailer. Attribution must reflect the actual authoring workflow.

Every implementation PR must include `Closes #N`, use the PR template, and end in a reviewable state. The final handoff must say: **Do not merge — wait for review.**

## Simplicity and review discipline

Follow `.github/instructions/simplicity-review.instructions.md` for all implementation and review work.

- Correctness and safety come first.
- Prefer direct code and existing platform capabilities over new abstractions or dependencies.
- Do not create generic frameworks for a single current use case.
- Keep calculation logic and state in the owning domain rather than mirroring it elsewhere.
- Every review has a correctness pass followed by a simplicity/over-engineering pass.

## Domain ownership boundaries

| Domain | Owns |
|---|---|
| Timeline | Scheduling, dependencies, onboarding weeks, buffer planning, duration calculations |
| Resource Profile | Resource demand aggregation, capacity and allocation views, utilisation summaries |
| Commercial | Rates, pricing, discounts, commercial impacts, budget totals |
| Document generation | Rendering SOWs, proposals, and exports from shared source data; never duplicate calculation logic |

When multiple screens consume the same concept, fix or extend the owning domain and expose a shared result. Do not independently reproduce scheduling, effort, resource, or commercial calculations in UI components.

## Security and API conventions

- Protected routes use `authenticate` from `server/src/middleware/auth.ts`.
- Project-scoped operations verify ownership with `ownedProject(projectId, userId)` or the established equivalent.
- Global administration routes enforce the correct global-admin permission explicitly.
- Validate API and form inputs and return actionable errors.
- Register specific Express routes before parameterised routes to avoid parameter capture.
- All client API requests go through `client/src/lib/api.ts`; do not introduce raw `fetch` calls or hard-coded API URLs.
- Use `import type` for type-only imports.
- When nullable schema fields change, audit server DTOs, client types, calculations, maps, and route handlers that previously assumed non-null values.
- Surface failures through toast or inline feedback; never silently ignore failed writes.

## Prisma and data safety

Before any Prisma schema migration or other operation that can alter stored data:

1. Identify the configured database from `DATABASE_URL` or the selected environment file (`MONRAD_ENV_FILE`, default `server/.env`) and any explicit backup-tool overrides. Confirm whether PostgreSQL is running in the default Docker container or directly on the host.
2. Run `npm run db:backup` from the repository root.
3. Confirm the command backed up the configured database and produced a non-empty timestamped dump in `backups/`.
4. Record the backup method and output path in the implementation handoff or PR description.
5. Only then run the required migration command.

The repository backup tooling is a safety boundary and must:

- work on Windows, macOS, and Linux without POSIX-only shell syntax
- support host PostgreSQL and Docker PostgreSQL via the documented explicit mode
- default to host-mode `pg_dump` when `MONRAD_DB_MODE` is unset
- select Docker mode only when `MONRAD_DB_MODE=docker`; any other non-empty mode is a safe configuration error
- derive the database connection from repository configuration rather than silently assuming the default database, user, or host
- allow `MONRAD_DB_CONTAINER` to override only the Docker container name after Docker mode is selected
- allow `MONRAD_ENV_FILE` as a test/developer override for the `.env` path
- fail clearly when Docker, `pg_dump`, credentials, or the configured database are unavailable
- pass authority and query-string database passwords through the `PGPASSWORD` environment variable in host mode rather than through process arguments
- remove query-string password fields without reserialising unrelated libpq query options
- report only the backup mode, executable, and exit/spawn status on command failure; never print a credential-bearing `DATABASE_URL`
- finalize verified dumps with an exclusive no-overwrite operation so concurrent runs cannot replace an existing backup
- never report success after backing up a different database from the one the application is configured to use

If `npm run db:backup` cannot back up the configured database, stop. Do not migrate, skip the backup, or substitute an unverified empty dump. Fix the backup configuration or tooling first.

Rules:

- Never run `prisma migrate reset` without explicit user approval. It destroys data.
- Do not use `prisma db push` as a substitute for a reviewed migration on shared or persistent data.
- Prefer backward-compatible schema and data migrations.
- After schema changes, run `npx prisma migrate dev --name <name>` and `npx prisma generate` from `server/`.
- When adding Prisma models or methods used in tests, update the global mock in `server/src/test/setup.ts`.
- JSON fields may require an explicit `unknown` cast before conversion to an application type.
- Explain destructive or irreversible migration behaviour in the PR description.

## UI and accessibility conventions

- Primary actions use LAB3 navy (`#1d245b`, `bg-lab3-navy`).
- LAB3 blue (`#2c60f6`, `bg-lab3-blue`) is used for hover states and accents.
- Use established gray and dark-mode tokens for secondary controls, borders, and surfaces.
- Reuse existing hand-rolled Tailwind patterns; do not add a UI component library without explicit approval.
- Preserve keyboard navigation, visible focus, screen-reader labels, semantic roles, and sufficient colour contrast.
- Always provide loading and meaningful empty states for asynchronous/list UI.
- Prefer toast or inline feedback over `alert()`.
- Avoid changing unrelated visual styling while implementing functional work.

## Validation contract

Do not record hard-coded expected test counts. Test totals change over time.

Run from the repository root:

```bash
npm run validate
```

This must cover:

- client and server lint
- client and server type-checking
- client and server builds
- client and server unit/integration tests
- backup regression tests (Linux and Windows CI)

A failure may only be described as pre-existing after reproducing the same failure on the merge base or current `main`. Unexplained failures are blockers. A new CI gate must not be merged in a permanently failing state, even when it exposes an older failure; either remediate the failure in the same PR or track and complete the prerequisite remediation before enabling the gate.

Repository-facing setup and contribution documentation must present `npm run validate` as the primary complete client/server validation command. Lower-level workspace commands may be documented for targeted diagnosis, but must not replace or contradict the root validation contract.

### End-to-end testing

Add or update Playwright coverage when the change affects user-visible behaviour, navigation, permissions, persistence, or a critical cross-domain workflow.

For local agent validation, prefer:

```bash
npm run test:e2e:local
```

The local runner owns database migration/seed, test-data cleanup, dynamic ports, API/Vite startup, Playwright execution, and child-process shutdown. Do not require manually running or killing dev servers around it.

Documentation-only, internal refactors with unchanged behaviour, or narrowly scoped server changes may mark E2E as not applicable, but the PR must state why and identify the focused tests used instead.

When E2E tests change, follow `.github/instructions/playwright.instructions.md` and update `e2e/TESTS.md`.

If a required validation command cannot run because an external prerequisite is unavailable, report the exact blocker and run every remaining check. Do not claim a check passed when it did not run.

## Local development

Start both watch-mode servers with:

```bash
npm run dev
```

- API: `http://localhost:3001`
- Vite: `http://localhost:5173`

`tsx watch` and Vite HMR reload normal source changes. Restart only after dependency, environment, startup-configuration, Prisma client, or process-health changes make it necessary.

Do not use platform-specific process commands as the default workflow. Prefer repository scripts that work on Windows, macOS, and Linux.

## Documentation and screenshots

Update documentation when behaviour, setup, architecture, commands, or supported workflows change.

- Keep `README.md`, `CONTRIBUTING.md`, and domain documentation accurate.
- Documentation must be correct before the PR is marked ready for review.
- README database guidance must describe the same Docker and non-Docker backup behaviour implemented by `npm run db:backup`.
- README test guidance must use `npm run validate` as the complete client/server validation workflow.
- When a README table requires a PR number, add it after the PR exists; do not invent or predict a number.
- Regenerate screenshots for new pages or material layout changes with `npm run screenshots` and commit only intentional image changes.
- Do not mechanically edit roadmap or shipped-enhancement tables when the change does not affect them.

## Pull-request handoff

The PR description must explain:

- what changed and why
- the tracked issue
- important design or migration decisions
- validation commands and exact results
- E2E tests added/updated, or why E2E is not applicable
- risks, limitations, and follow-up work

After every push, check required CI and report its current state. Do not merge even when all checks pass.

## Optional local accelerators

Smart Memory, CodeGraphContext, language-server MCP tools, and other workstation-specific helpers may be used when installed and useful.

- Their absence must not block implementation, testing, review, or PR preparation.
- Do not assume fixed paths under a user's home directory exist.
- Repository code, tests, issues, and committed documentation remain the source of truth.
- Do not store secrets, customer data, or transient implementation details in external memory systems.