# Agent Instructions — Monrad Estimator

These instructions apply to the whole repository.

Monrad Estimator is a full-stack project estimation tool. Follow the detailed project workflow, stack, testing, database, UI, and communication rules in `.github/copilot-instructions.md` as the operational source of truth.

## Simplicity / Ponytail Rule

Prefer the smallest correct change. Boring, direct code is better than clever or speculative code.

Before writing code, stop at the first option that holds:

1. Does this need to be built at all? If not, do not build it.
2. Does the standard library already do this? Use it.
3. Does the browser, React, Express, Prisma, Playwright, or another existing platform feature already cover it? Use that.
4. Does an already-installed dependency solve it? Use it instead of adding another dependency.
5. Can the same behaviour be expressed directly with fewer moving parts? Prefer that.
6. Only then write the minimum code that solves the issue.

Do not add abstractions, wrappers, factories, generic configuration, new state ownership, or dependency layers unless the issue requires them or there are at least two real call sites that need the abstraction now.

Deletion beats addition when the behaviour remains correct.

## What Must Not Be Simplified Away

Never use the simplicity rule to remove or weaken:

- authentication, authorisation, ownership checks, or trust-boundary validation
- database backup, migration safety, rollback safety, or data-loss prevention
- accessibility, labels, keyboard support, contrast, loading states, and empty states
- tests that cover non-trivial business logic, permissions, scheduling, document output, or user flows
- user-requested scope, especially timeline/resource/commercial consistency
- explicit error handling needed to prevent silent failure or data corruption

A small focused test is not bloat. Non-trivial logic should leave behind the smallest runnable check that would fail if the behaviour regresses.

## Monrad-Specific Ownership Rules

Be especially careful not to duplicate ownership across these areas:

- Timeline owns scheduling, dependency, onboarding, and buffer planning behaviour.
- Resource Profile should aggregate and explain resource demand rather than re-own scheduling settings.
- Commercial should calculate and display pricing/commercial impact rather than maintain separate planning state.
- Document generation should render from the same source data used by the app, not recreate scheduling or costing rules.

If a change touches Timeline, Resource Profile, Commercial, or Document export, explicitly check for duplicated state, duplicated calculations, stale props, and cache invalidation gaps.

## PR Review Procedure

Use two review passes:

1. **Correctness pass** — check behaviour, data model consistency, tests, migrations, security, permissions, accessibility, API contracts, and UX impact.
2. **Ponytail pass** — review for over-engineering only. Look for code that can be deleted, props that no longer need to exist, duplicated state, helpers with one caller, abstractions with one implementation, unused flexibility, hand-rolled platform features, or unnecessary dependencies.

Do not let the Ponytail pass override correctness. If correctness and simplicity conflict, correctness wins.

When reporting Ponytail findings, use concise lines:

```text
<file>:<line>: delete|stdlib|native|yagni|shrink: <what to cut>. <what replaces it>.
```

If there is nothing meaningful to simplify, say: `Lean already. Ship.`

## Implementation Checklist

Before completing work or recommending merge:

- Confirm the source of truth for any changed state.
- Remove dead props, unused helpers, obsolete UI copy, and stale tests.
- Reuse existing API/client helpers and query invalidation patterns.
- Keep migrations and schema changes deliberately small.
- Add or update the smallest useful automated test for changed behaviour.
- Include manual smoke-test notes when UI behaviour changes.
