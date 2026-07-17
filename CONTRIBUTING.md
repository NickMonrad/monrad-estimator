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

This is the complete client/server validation workflow. It runs the backup regression suite (Linux and Windows CI) first, then client and server lint, type-checking, builds, and unit/integration tests.

Workspace-specific commands may be used to diagnose an individual failure, but they do not replace the root validation command.

Do not accept unexplained failures. A failure may only be classified as pre-existing after reproducing it on the merge base or current `main`. Do not enable or merge a new CI gate in a permanently failing state; remediate the exposed failure before the gate is treated as complete.

### End-to-end tests

For user-visible behaviour, navigation, permissions, persistence, or critical cross-domain workflows, add or update Playwright coverage and run:

```bash
npm run test:e2e:local
```

The local runner provisions one disposable PostgreSQL 15 Docker container per
worktree/run, then runs migrations, cleanup, seed, API, Vite, and Playwright only
against that container. It never probes, connects to, or modifies the persistent
`DATABASE_URL` database. Before removing the container it terminates all spawned
child processes: on POSIX the entire process tree receives SIGTERM with escalation
to SIGKILL after a grace period; on Windows `taskkill /T /F` kills the process
tree. The container is force-removed after success or failure.

Use `npm run test:integration:local` for the PostgreSQL-backed snapshot rollback, clone, Squad Plan profile-first, and apply-parity suites. `npm run db:setup` safely creates the configured persistent development database if missing, then runs `prisma migrate deploy` and `prisma generate`. Shell variables override `server/.env` (or `MONRAD_ENV_FILE`). For an externally managed test database, set both `MONRAD_TEST_DATABASE_URL` (the exact database that receives migrations, seed, and cleanup — never auto-created or auto-dropped) and `MONRAD_ALLOW_EXTERNAL_TEST_DATABASE=1` (required opt-in). Both variables together are required; the lifecycle module refuses to operate when only one is set.

list containers with `docker ps -a --filter name=monrad_pg_`
For documentation-only work, internal refactors with unchanged behaviour, or narrowly scoped server work, E2E may be marked not applicable when the PR explains why and lists the focused tests used instead.

When Playwright tests change, update `e2e/TESTS.md`.

## Database migrations

Before a Prisma schema migration or other operation that may alter persistent development data:

1. Confirm the configured database in `DATABASE_URL` or the selected environment file (`MONRAD_ENV_FILE`, default `server/.env`) and whether it runs in the default Docker container or directly on the host.
2. Run:

   ```bash
   npm run db:backup
   ```

3. Confirm the command backed up that configured database and produced a non-empty timestamped dump in `backups/`.
4. Record the backup method and output path in the PR description or implementation handoff.
5. Only then run the migration.

`npm run db:backup` is the required repository entry point. It must work on Windows, macOS, and Linux and support both documented local PostgreSQL setups:

- host mode is the default and uses the host `pg_dump` for the exact configured `DATABASE_URL`
- Docker mode requires `MONRAD_DB_MODE=docker`; `MONRAD_DB_CONTAINER` only overrides the container name (default `monrad-pg`) after Docker mode is selected
- `MONRAD_DB_MODE=host` explicitly selects host `pg_dump`

Authority passwords are removed from the URI, raw query-string password fields are removed without reserialising unrelated libpq options, and the effective credential is passed through child-process `PGPASSWORD` rather than command arguments. Final dump names are reserved with an exclusive filesystem operation so concurrent backups cannot overwrite one another. Conflicting or ambiguous password representations fail before invoking `pg_dump`. Set `MONRAD_ENV_FILE` only when a non-standard environment-file path is required. Backup command failures identify the executable and exit status without revealing the database URL or password. The command must fail clearly rather than silently backing up the wrong database. If it cannot back up the current configuration, stop and fix the backup tooling or configuration before migrating.

Never run `prisma migrate reset` without explicit user approval. Prefer backward-compatible migrations and explain destructive behaviour in the PR.

## Documentation

Update documentation when behaviour, setup, architecture, commands, or supported workflows change.

- Documentation must be accurate before the PR is marked ready for review.
- README test guidance must use `npm run validate` as the complete client/server workflow.
- README database guidance must match the Docker and non-Docker behaviour implemented by `npm run db:backup`.
- Add a PR number to a README table only after the PR exists.
- Do not invent a future PR number.
- Regenerate screenshots with `npm run screenshots` for new pages or material layout changes.

## Review standard

Every review includes:

1. a correctness pass covering behaviour, security, data safety, tests, accessibility, UX, and API contracts
2. a simplicity pass covering unnecessary abstraction, duplicated state, unused flexibility, new dependencies, and code that can be deleted

See `.github/instructions/simplicity-review.instructions.md` for the complete review procedure.