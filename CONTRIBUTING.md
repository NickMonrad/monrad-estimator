# Contributing Standards

## Branching Strategy

- `master` is the stable, reviewed branch. All completed work must be merged here via PR.
- Feature branches follow the pattern `feature/phase-N-<name>` (e.g. `feature/phase-4-effort`).
- **All feature branches must target `master` directly** — do not chain branches (e.g. phase-2 → phase-1 → master). Each phase PR should have `master` as its base.
- One branch per phase. Small fixes or enhancements within a phase go on the same branch before the PR is raised.

## Pull Request Process

1. **Complete the phase** — all code written, tests passing, TypeScript clean.
2. **Raise a PR** against `master` using the PR template (`.github/pull_request_template.md`).
3. **Review** — the PR is reviewed before merging. No self-merge without review.
4. **Close the related GitHub issue** in the PR body using `Closes #N`.
5. **Merge** — squash or merge commit, never rebase onto master.
6. **Start the next phase** from the updated `master` after merge.

## Phase Workflow (Copilot CLI)

When building a new phase:
```
git checkout master && git pull
git checkout -b feature/phase-N-<name>
# ... build, test, commit ...
gh pr create --base master --head feature/phase-N-<name>
# Wait for review + merge before starting next phase
```

## Commit Messages

Follow the pattern: `type: short description`

| Type | When to use |
|---|---|
| `feat` | New feature or phase work |
| `fix` | Bug fix |
| `refactor` | Rename, restructure, no behaviour change |
| `docs` | Documentation only |
| `test` | Adding or fixing tests |
| `chore` | Deps, config, tooling |

All commits must include the co-author trailer:
```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## Testing Standards

- Every phase must include tests before the PR is raised.
- Server: API integration tests in `server/src/test/` using Vitest + supertest.
- Client: Component tests in `client/src/test/` using Vitest + React Testing Library.
- Run `npm test` in `/server` and `npx tsc --noEmit` in both `/client` and `/server` before raising a PR.

## GitHub Issues

- Each phase has a corresponding GitHub issue (labelled `phase`).
- Future enhancements are tracked as issues labelled `backlog`.
- Close the issue in the PR body: `Closes #N`.
- Completed phases are labelled `completed` and closed when their PR merges.
