---
applyTo: "server/prisma/**,server/src/test/setup.ts,server/.env.example,scripts/db-backup.mjs,scripts/db-backup.test.mjs,scripts/db-setup.mjs,scripts/db-setup.test.mjs"
---

# Prisma and Database Safety Instructions

These rules apply to Prisma schema or migration work and to the repository database setup and backup tooling. They extend `.github/instructions/project.instructions.md`.

## Required backup before stored-data changes

Before any Prisma schema migration or other operation that can alter stored data:

1. Identify the configured database from `DATABASE_URL` or the selected environment file (`MONRAD_ENV_FILE`, default `server/.env`) and any explicit backup-tool overrides. Confirm whether PostgreSQL is running in the default Docker container or directly on the host.
2. Run `npm run db:backup` from the repository root.
3. Confirm the command backed up the configured database and produced a non-empty timestamped dump in `backups/`.
4. Record the backup method and output path in the implementation handoff or PR description.
5. Only then run the required migration command.

If `npm run db:backup` cannot back up the configured database, stop. Do not migrate, skip the backup, or substitute an unverified or empty dump. Fix the backup configuration or tooling first.

## Backup-tool safety boundary

The repository backup tooling must:

- work on Windows, macOS, and Linux without POSIX-only shell syntax
- support host PostgreSQL and Docker PostgreSQL through the documented explicit mode
- use host-mode `pg_dump` when `MONRAD_DB_MODE` is unset or explicitly set to `host`
- select Docker mode only when `MONRAD_DB_MODE=docker`; any other non-empty mode is a safe configuration error
- derive the database connection from repository configuration rather than assuming a default database, user, or host
- allow `MONRAD_DB_CONTAINER` to override only the Docker container name after Docker mode is selected
- allow `MONRAD_ENV_FILE` as a test/developer override for the environment-file path
- fail clearly when Docker, `pg_dump`, credentials, or the configured database are unavailable
- pass authority and query-string database passwords through `PGPASSWORD` in host mode rather than process arguments
- fail before invoking `pg_dump` when authority and query-string password representations conflict or are ambiguous
- remove query-string password fields without reserialising unrelated libpq query options
- report only the backup mode, executable, and exit/spawn status on failure; never print a credential-bearing `DATABASE_URL`
- finalise verified dumps with an exclusive no-overwrite operation so concurrent runs cannot replace an existing backup
- never report success after backing up a different database from the configured application database

## Migration rules

- Never run `prisma migrate reset` without explicit user approval. It destroys data.
- Do not use `prisma db push` as a substitute for a reviewed migration on shared or persistent data.
- Prefer backward-compatible schema and data migrations.
- After schema changes, run `npx prisma migrate dev --name <name>` and `npx prisma generate` from `server/`.
- When adding Prisma models or methods used in tests, update the global mock in `server/src/test/setup.ts`.
- When nullable fields change, audit server DTOs, client types, calculations, maps, and route handlers that previously assumed non-null values.
- JSON fields may require an explicit `unknown` cast before conversion to an application type.
- Explain destructive or irreversible migration behaviour in the PR description.
