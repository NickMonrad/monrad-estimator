# Contributing Standards

Repository-wide implementation and review rules are defined in `.github/instructions/project.instructions.md`. This document summarises the human contribution workflow and must remain consistent with that canonical contract.

## Branching strategy

- `main` is the stable, reviewed branch.
- Start each piece of work from the latest `main`.
- Target `main` directly; do not chain feature branches.
- Use one branch per issue or independently reviewable work item.

Branch names:

```text
feature/<issue>-<slug>
fix/<issue>-<slug>
docs/<issue>-<slug>
```

Examples:

```text
feature/365-agent-instruction-hardening
fix/353-windows-e2e-runner
```

## Pull-request process

1. Confirm the issue scope and acceptance criteria.
2. Implement the smallest complete change and add appropriate tests.
3. Run the repository validation contract.
4. Update affected documentation and screenshots.
5. Raise a PR against `main` using `.github/pull_request_template.md`.
6. Include `Closes #N` in the PR body.
7. Wait for human review and approval.
8. The repository owner merges the PR.

Contributors and agents must not push directly to `main`, merge their own PR, enable auto-merge, approve their own PR, or bypass required checks.

## Commit messages

Use:

```text
type(#issue): short description
```

| Type | Use |
|---|---|
| `feat` | New user or system capability |
| `fix` | Defect correction |
| `refactor` | Structural change without intended behaviour change |
| `docs` | Documentation only |
| `test` | Test coverage or test infrastructure |
| `chore` | Tooling, dependencies, CI, or repository maintenance |

Do not add a hard-coded Copilot co-author trailer. Attribution must reflect the actual authoring workflow.

## Validation

Run from the repository root:

```bash
npm run validate
```

This runs client and server lint, type-checking, builds, and unit/integration tests.

Do not accept unexplained failures. A failure may only be classified as pre-existing after reproducing it on the merge base or current `main`.

### End-to-end tests

For user-visible behaviour, navigation, permissions, persistence, or critical cross-domain workflows, add or update Playwright coverage and run:

```bash
npm run test:e2e:local
```

The local runner manages the database, ports, dev processes, test execution, and cleanup across Windows, macOS, and Linux.

For documentation-only work, internal refactors with unchanged behaviour, or narrowly scoped server work, E2E may be marked not applicable when the PR explains why and lists the focused tests used instead.

When Playwright tests change, update `e2e/TESTS.md`.

## Database migrations

Before a Prisma schema migration or other operation that may alter persistent development data:

```bash
npm run db:backup
```

Confirm a non-empty timestamped dump exists in `backups/` before continuing.

Never run `prisma migrate reset` without explicit user approval. Prefer backward-compatible migrations and explain destructive behaviour in the PR.

## Documentation

Update documentation when behaviour, setup, architecture, commands, or supported workflows change.

- Documentation must be accurate before the PR is marked ready for review.
- Add a PR number to a README table only after the PR exists.
- Do not invent a future PR number.
- Regenerate screenshots with `npm run screenshots` for new pages or material layout changes.

## Review standard

Every review includes:

1. a correctness pass covering behaviour, security, data safety, tests, accessibility, UX, and API contracts
2. a simplicity pass covering unnecessary abstraction, duplicated state, unused flexibility, new dependencies, and code that can be deleted

See `.github/instructions/simplicity-review.instructions.md` for the complete review procedure.
