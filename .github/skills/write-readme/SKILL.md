---
name: write-readme
description: Update Monrad Estimator README and project documentation using the canonical repository instructions and current codebase behaviour.
---

# README and Documentation Skill

Before editing documentation, follow `.github/instructions/project.instructions.md` and read the current README, relevant scripts, environment examples, and implementation being documented.

## When to use

Use this skill when asked to:

- create or update `README.md`
- document setup, architecture, commands, or workflows
- correct stale developer guidance
- add or update feature documentation

## Process

1. Read the existing documentation before editing it.
2. Verify commands, ports, environment variables, and behaviour against the current repository.
3. Change only the sections affected by the work; do not rewrite the README from scratch unless explicitly requested.
4. Keep setup instructions cross-platform where repository scripts already provide a cross-platform workflow.
5. Run or statically verify documented commands when practical.
6. Check links, headings, code fences, and referenced files.
7. Compare README guidance with `CONTRIBUTING.md` and the canonical instructions so the repository does not publish competing workflows.

## Monrad-specific commands

Use the current root commands rather than inventing alternatives:

```bash
npm install
npm run dev
npm run validate
npm run test:e2e:local
npm run screenshots
npm run db:backup
```

`npm run validate` is the primary complete client/server validation command. It covers lint, type-checking, builds, unit/integration tests, and backup regression tests for both workspaces. Workspace-specific commands may be documented for targeted troubleshooting, but must not be presented as a substitute validation checklist.

For database schema development, documentation must show the safety sequence:

```bash
npm run db:backup
cd server
npx prisma migrate dev --name <migration-name>
npx prisma generate
```

Before documenting the sequence, verify that `npm run db:backup` backs up the database configured by `DATABASE_URL` or the selected environment file (`MONRAD_ENV_FILE`, default `server/.env`) and supports the documented local topology:

- Docker-based PostgreSQL via explicit `MONRAD_DB_MODE=docker` (default container `monrad-pg`, overridable via `MONRAD_DB_CONTAINER`)
- non-Docker PostgreSQL running directly on the host (default mode — conservative, no automatic Docker detection)

Documentation must not imply that a Docker-only implementation supports non-Docker development, that automatic container detection proves endpoint identity, or that a backup of default credentials protects a differently configured database. Document the `PGPASSWORD` delivery mechanism: the password is extracted from `DATABASE_URL` and passed to `pg_dump` through the environment, not on the command line. Describe required tools such as Docker or `pg_dump`, explicit overrides, credential-redacted failure modes, and the generated backup path accurately. Backup regression tests (`npm run test:backup`) run on both Linux and Windows CI.

Never document `prisma migrate reset` as a routine step. It requires explicit user approval because it destroys data.

## Documentation rules

- Write for a developer who has not seen the project before.
- Prefer the minimum accurate setup over speculative or generic sections.
- Do not include real secrets, credentials, customer names, or private connection strings.
- Do not guess the licence; reflect the repository's actual licence state.
- Keep Windows, macOS, and Linux behaviour accurate.
- Explain when Docker, `pg_dump`, or a local PostgreSQL instance is required.
- Prefer `npm run test:e2e:local` for local E2E guidance because it owns ports, server processes, seed data, and cleanup.
- Do not describe a failing CI gate as complete or healthy.
- Add a PR number only after the PR exists; never predict one.
- Update screenshots only when the UI materially changed and use the screenshot skill.
- Do not alter roadmap or shipped-enhancement tables unless the work actually changes them.

## Completion report

Summarise the sections changed, facts verified, and any commands that could not be run. Documentation-only work may mark E2E as not applicable with a clear reason.