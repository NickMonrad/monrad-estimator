---
applyTo: "e2e/**,server/src/test/**/*.integration.test.ts,scripts/run-e2e-local.mjs,scripts/run-integration-local.mjs,scripts/local-postgres*.mjs,scripts/runner-*.mjs,scripts/aggregated-error*.mjs"
---

# PostgreSQL Test-Database Lifecycle Instructions

These rules apply to database-backed integration/E2E tests and the scripts that create, migrate, seed, clean, monitor, or remove their disposable databases. They extend `.github/instructions/project.instructions.md`.

## Persistent development database

The configured `DATABASE_URL` (defaulting to `monrad_estimator` in `server/.env.example`) identifies a persistent PostgreSQL database that stores data across sessions.

- Never automatically reset, drop, clean, or seed it as part of disposable test setup.
- Server unit tests using mocked Prisma do not touch it.
- `npm run db:setup` creates it only when missing and never resets or overwrites it.
- Before any cleanup or destructive operation, verify the target is not the persistent database.

## Disposable test databases

The lifecycle module operates in two modes.

### Docker-first mode (default)

- Create a unique disposable `postgres:15` Docker container with a dynamically assigned loopback port.
- Apply migrations to the container's built-in `postgres` database.
- Run the suite and then force-remove the container.
- Treat the container as the isolation and cleanup boundary; do not create a temporary database on a host PostgreSQL server.
- Keep container names worktree/run-specific so parallel runs do not collide.

### Externally managed mode

When `MONRAD_TEST_DATABASE_URL` is set:

- use that exact database for migrations, cleanup, seed, and tests
- never auto-create or auto-drop it
- require `MONRAD_ALLOW_EXTERNAL_TEST_DATABASE=1` as an explicit destructive-test opt-in
- reject `MONRAD_ALLOW_EXTERNAL_TEST_DATABASE=1` when no test URL is set
- reject a test URL that identifies the same normalised host, effective port, and decoded database name as persistent `DATABASE_URL`, regardless of credentials, URL scheme aliases, encoding, or irrelevant query parameters
- fail closed for local loopback aliases where practical

When Docker is unavailable, fail with a clear diagnostic explaining the default prerequisite and the explicit external-database alternative. Do not fall back automatically to host PostgreSQL.

## Naming

- Disposable Docker containers use the `monrad_pg_` prefix.
- Legacy test-database names use the `monrad_test_` prefix but are not created by the default lifecycle.
- Generated names contain only lowercase letters, digits, and underscores.

## Interrupted runs and cleanup

An interrupted run may leave a disposable container behind. Before removal:

```bash
docker ps -a --filter name=monrad_pg_
```

For each candidate:

1. Verify the exact name and worktree-specific suffix.
2. Confirm it was created by the lifecycle module and is not a persistent or manually managed container.
3. Only then run `docker rm -f <exact-container-name>`.

Never delete containers by prefix without inspecting each exact target.

The local E2E runner owns migration, cleanup, seed, dynamic ports, API/Vite startup, Playwright execution, child-process shutdown, and disposable-container removal. It terminates the process tree before removing the container. Do not manually start, kill, or reuse development servers around that runner.

If a required lifecycle or database prerequisite is unavailable, report the exact blocker and do not redirect the suite to persistent data.
