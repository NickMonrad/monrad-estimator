# Contributing Standards

Repository-wide implementation and review rules are defined in `.github/instructions/project.instructions.md`. This document summarises the human contribution workflow and must remain consistent with that canonical contract.

## Branching strategy

- `main` is the stable, reviewed branch.
- For new issue work, start a new issue branch from the latest `main`.
- For remediation of an existing pull request, fetch and inspect the latest PR head and continue on the existing PR branch. Do not create a replacement branch, retarget the PR, rebase, force-push, or rewrite shared history unless explicitly requested.
- Target `main` directly; do not chain feature branches.
- Use one branch per issue or independently reviewable work item.

Branch names for new work:

```text
feature/<issue>-<slug>
fix/<issue>-<slug>
docs/<issue>-<slug>
```

## Worktrees

Implementation and pull-request remediation must use a dedicated Git worktree so concurrent work does not interfere.

- Verify the selected worktree and branch before editing.
- Reuse an existing dedicated worktree when it already owns the branch.
- Do not modify, clean, reset, delete, or otherwise disturb another contributor's or agent's worktree.
- Leave the worktree clean after intended changes are committed and pushed.

## Pull-request process

1. Confirm issue scope, acceptance criteria, approved design, and exclusions.
2. Select the correct issue or existing PR branch in a dedicated worktree.
3. Implement the smallest complete change and add appropriate tests.
4. Run applicable validation.
5. Update affected documentation and screenshots.
6. Review the final diff against the issue and acceptance criteria.
7. Commit and push only intended changes.
8. Raise or update the PR against `main` using `.github/pull_request_template.md`.
9. Include `Closes #N` for new issue work.
10. Confirm the remote commit, report the SHA and PR URL, leave the worktree clean, and wait for human review.

Incomplete, uncommitted, or unpushed work must be reported as incomplete. Contributors and agents must not push directly to `main`, merge their own PR, enable auto-merge, approve their own PR, force-push shared history without explicit approval, or bypass required checks.

## Commit messages

Use:

```text
type(#issue): short description
```

Valid types are `feat`, `fix`, `refactor`, `docs`, `test`, and `chore`. Attribution must reflect the actual authoring workflow; do not add a hard-coded Copilot co-author trailer.

## Validation

For application or validation-tooling changes, run from the repository root:

```bash
npm run validate
```

Workspace-specific commands may diagnose a failure but do not replace required root validation.

For documentation- or instruction-only changes with no application, test-infrastructure, validation-script, or generated-artifact impact, focused documentation/instruction checks plus `git diff --check` are sufficient when the PR explains why full application validation is not applicable.

Do not accept unexplained failures. A failure may be classified as pre-existing only after reproducing it on the merge base or current `main`.

### End-to-end tests

For user-visible behaviour, navigation, permissions, persistence, or critical cross-domain workflows, add or update Playwright coverage. Follow:

- `.github/instructions/playwright.instructions.md`
- `.github/instructions/postgres-test-lifecycle.instructions.md`

Use the isolated local runner:

```bash
npm run test:e2e:local
```

When Playwright tests change, update `e2e/TESTS.md`. For work where E2E is not applicable, state why and list focused tests used instead.

## Database migrations

Before any Prisma schema migration or stored-data change, follow `.github/instructions/database.instructions.md`.

A verified `npm run db:backup` of the configured database is mandatory before migration. Never run `prisma migrate reset` without explicit user approval, and do not use `prisma db push` as a substitute for a reviewed migration on persistent data.

## Documentation

Update documentation when behaviour, setup, architecture, commands, or supported workflows change.

- Documentation must be accurate before the PR is ready for review.
- README test guidance must use `npm run validate`.
- README database guidance must match `npm run db:backup`.
- Add a PR number only after the PR exists.
- Regenerate screenshots with `npm run screenshots` for new pages or material layout changes.

## Review standard

Follow `.github/instructions/simplicity-review.instructions.md` for the complete review procedure, finding classifications, stop condition, and required verdict.
