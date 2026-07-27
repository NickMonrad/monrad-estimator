---
applyTo: "**"
---

# Monrad Estimator Agent Instructions

## Authority and precedence

This file is the canonical repository-wide instruction contract for implementation, testing, review, and pull-request work in Monrad Estimator.

- Path-scoped files under `.github/instructions/` add rules for their area and must not contradict this file.
- Custom agent definitions under `.github/agents/` and harness-specific adapters describe capabilities or runtime behaviour only. They inherit these rules and must not duplicate volatile project facts.
- `.github/copilot-instructions.md` is a Copilot entry point, not a second source of project rules.
- A direct user instruction overrides repository guidance only for the requested task and only when it is safe.
- When repository instructions conflict, follow this file and report the conflict.

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

## Direct-first working model

Do not assume a particular model, orchestrator, or named sub-agent exists.

Work inline by default for one coherent implementation, defect, remediation, or review task. Multi-file work does not by itself require delegation. The active agent owns the top-level interpretation, scope, design decisions, integrated diff, validation, final review, and pull-request handoff.

Do not:

- spawn a generic planner to reinterpret an issue that already has acceptance criteria or an approved design
- create separate research, implementation, testing, documentation, and review agents as a routine pipeline
- delegate routine tests or documentation caused by an implementation
- nest delegation by default

Use a specialist only when the user explicitly requests specialist or parallel work, or when at least two genuinely independent workstreams can proceed concurrently without first requiring the same unresolved decision. Specialist output is advisory or contributory; the active agent remains responsible for integration and correctness.

For each task:

1. Read the issue or PR, acceptance criteria, approved design, agreed exclusions, relevant code and tests, and every matching path-scoped instruction.
2. Identify the current source of truth and affected API, data, and UI contracts.
3. Prefer the smallest correct change that fully satisfies the acceptance criteria.
4. Add focused tests at the lowest useful level and browser coverage when required by the applicable instructions.
5. Run relevant validation and report exact results.
6. Update documentation that became inaccurate because of the change.
7. Review the complete final diff against the original issue and acceptance criteria.
8. Commit and push the intended changes to the correct issue or existing PR branch and prepare the PR for human review.

Do not ask for guidance on routine choices that existing patterns resolve. Escalate genuine ambiguity, destructive data impact, security trade-offs, or scope that materially exceeds the issue.

## Implementation task briefs

A complete implementation brief should contain:

- the exact objective
- the source issue or existing PR
- relevant context not already present in repository instructions
- explicit in-scope and out-of-scope boundaries
- required observable behaviour and acceptance criteria
- affected areas when known, while still requiring inspection of the current implementation
- focused automated tests and realistic manual validation
- an instruction to inspect repository conventions rather than assume them
- a requirement to report deviations and genuine blockers
- **Do not merge — wait for review.**

A task brief should not:

- paste this canonical contract or other repository instructions
- repeat the full stack unless directly relevant
- prescribe every file read, command, or tool call
- require a lengthy planning phase when the issue is implementation-ready
- request competing designs when one design is approved
- introduce unrelated future-proofing or optional cleanup
- split one coherent issue among several agents by default
- restate detailed database, UI, test-lifecycle, or Playwright procedures already owned by path-scoped instructions

The brief must be concrete about scope, behaviour, validation, and non-goals while leaving implementation discretion within the approved design.

## Git, worktree, and human-review safety

Agents must never:

- push directly to `main`
- merge a pull request
- enable auto-merge
- approve their own pull request
- close the tracked issue manually when the PR should close it
- force-push or rewrite shared history without explicit user approval
- discard unrelated worktree changes
- modify, clean, reset, delete, or otherwise disturb another agent's worktree
- bypass failing required checks

Implementation and PR remediation must use a dedicated Git worktree. Before editing, verify the worktree path, current branch, tracked issue, and whether the task is new work or existing-PR remediation. Reuse an existing dedicated worktree when it already owns the branch and leave it clean after intended changes are committed and pushed.

For new issue work, branch from current `main`:

- `feature/<issue>-<slug>` for features and planned improvements
- `fix/<issue>-<slug>` for defects
- `docs/<issue>-<slug>` for documentation-only work

For existing-PR remediation, fetch and inspect the latest PR head and continue on that PR's existing branch in its dedicated worktree. Do not create a replacement branch, retarget the PR, rebase, force-push, or rewrite shared history unless explicitly instructed.

Commit messages use:

```text
type(#issue): short description
```

Valid types include `feat`, `fix`, `refactor`, `docs`, `test`, and `chore`. Do not add a hard-coded Copilot co-author trailer.

Every implementation PR must include `Closes #N`, use the PR template, and end in a reviewable state. Work is incomplete while intended changes are incomplete, uncommitted, or unpushed. The final handoff must report the pushed commit SHA, PR URL, worktree and branch, validation and CI state, and confirmation that the worktree is clean. It must say: **Do not merge — wait for review.**

## Simplicity and review discipline

Follow `.github/instructions/simplicity-review.instructions.md` as the source of truth for implementation and review procedure.

- Correctness and safety come first.
- Prefer direct code and existing platform capabilities over new abstractions or dependencies.
- Do not create generic frameworks for one current use case.
- Keep calculation logic and state in the owning domain rather than mirroring it elsewhere.
- Stop once approved scope is correctly implemented, adequately tested, and acceptably maintainable.

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

## Cross-cutting data, testing, and UI safeguards

- Any change that can alter stored data must follow the complete backup and migration procedure in `.github/instructions/database.instructions.md` before the change is applied.
- Never run `prisma migrate reset` without explicit user approval or use `prisma db push` as a substitute for a reviewed migration on persistent or shared data.
- Database-backed integration and E2E work must follow `.github/instructions/postgres-test-lifecycle.instructions.md`. The persistent development database must never be used as a disposable test database.
- UI changes must preserve keyboard navigation, visible focus, screen-reader labels, semantic roles, sufficient colour contrast, loading states, meaningful empty states, and visible error feedback. Follow `.github/instructions/client.instructions.md`.
- Browser-test changes follow `.github/instructions/playwright.instructions.md`.
- Keep focused automated tests for changed behaviour and relevant failure paths.

## Validation contract

Do not record hard-coded expected test counts.

For application or validation-tooling changes, run from the repository root:

```bash
npm run validate
```

This covers client and server lint, type-checking, builds, unit/integration tests, and database-tooling regression tests.

For documentation- or instruction-only changes that do not affect application code, test infrastructure, validation scripts, or generated artefacts, use the established focused documentation/instruction checks and `git diff --check`; explain why full application validation is not applicable.

Add or update Playwright coverage when user-visible behaviour, navigation, permissions, persistence, or a critical cross-domain workflow changes. Follow the path-scoped Playwright and test-database instructions for execution and cleanup.

A failure may be described as pre-existing only after reproducing it on the merge base or current `main`. Unexplained failures are blockers. If an external prerequisite prevents a required check, report the exact blocker and run every remaining check; never claim an unrun check passed.

## Local development

Start both watch-mode servers with:

```bash
npm run dev
```

- API: `http://localhost:3001`
- Vite: `http://localhost:5173`

`tsx watch` and Vite HMR reload normal source changes. Restart only after dependency, environment, startup-configuration, Prisma client, or process-health changes make it necessary. Prefer cross-platform repository scripts over platform-specific process commands.

## Documentation and screenshots

Update documentation when behaviour, setup, architecture, commands, or supported workflows change.

- Keep `README.md`, `CONTRIBUTING.md`, and domain documentation accurate.
- Documentation must be correct before the PR is marked ready for review.
- README database guidance must match `npm run db:backup`.
- README test guidance must use `npm run validate` as the complete application validation workflow.
- Add a PR number only after the PR exists; do not invent one.
- Regenerate screenshots for new pages or material layout changes with `npm run screenshots` and commit only intentional image changes.
- Do not mechanically edit roadmap or shipped-enhancement tables when the change does not affect them.

## Pull-request handoff

The PR description must explain:

- what changed and why
- the tracked issue
- important design or migration decisions
- validation commands and exact results
- E2E tests added or updated, or why E2E is not applicable
- risks, limitations, and optional follow-ups separated from required work
- the final pushed commit SHA

After every push, confirm the remote branch contains the intended commit and check required CI. Before reporting completion, verify the worktree is clean. If intended work remains incomplete, uncommitted, or unpushed, report the task as incomplete. Do not merge even when all checks pass.

## Optional local accelerators

Smart Memory, CodeGraphContext, language-server MCP tools, and other workstation-specific helpers may be used when installed and useful.

- Their absence must not block implementation, testing, review, or PR preparation.
- Do not assume fixed paths under a user's home directory exist.
- Repository code, tests, issues, and committed documentation remain the source of truth.
- Do not store secrets, customer data, or transient implementation details in external memory systems.
