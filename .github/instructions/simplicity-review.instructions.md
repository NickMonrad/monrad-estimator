---
applyTo: "**"
---

# Simplicity and Review Instructions

These instructions apply to all implementation and review work in Monrad Estimator. They complement `.github/instructions/project.instructions.md`.

## Simplicity Rule

Prefer the smallest correct change. Do not add abstractions, dependencies, duplicated state, wrappers, generic configuration, or future-proofing unless the issue explicitly requires it or there are at least two real call sites now.

Before writing code, check whether the work can be solved by:

1. not building it because the behaviour is unnecessary
2. the standard library
3. a native browser, React, Express, Prisma, Playwright, or platform feature
4. an already-installed dependency
5. direct code with fewer moving parts
6. only then, the minimum new code that works

Deletion beats addition when behaviour remains correct.

## Do Not Cut Required Safeguards

Do not remove or weaken:

- **Authentication and authorisation** — all protected routes must use the `authenticate` middleware; ownership checks must use `ownedProject()` or equivalent
- **Validation** — input validation on all API endpoints and forms
- **Migration safety** — schema changes require a backup (`npm run db:backup`) first; never run `prisma migrate reset` without explicit confirmation
- **Rollback safety** — backward-compatible schema and data migrations
- **Accessibility** — keyboard navigation, screen reader labels, focus management, colour contrast
- **Loading states** — spinners or skeleton placeholders during async operations
- **Empty states** — meaningful empty-state UI when lists have no items
- **Focused tests** — keep existing test coverage; add tests for new functionality
- **Requested scope** — deliver what the issue or feature spec asks for
- **Error handling** — surface errors via toasts or inline feedback; never silent failure or data corruption

## Monrad Ownership Boundaries

When a change touches project-estimation domain logic, respect these ownership boundaries:

| Domain | Owns |
|---|---|
| **Timeline** | Scheduling, task dependencies, onboarding weeks, buffer planning, duration calculations |
| **Resource Profile** | Aggregating resource demand across tasks, resource type totals, utilisation summaries |
| **Commercial** | Pricing, rates, commercial impact calculations, budget totals |
| **Document generation** | Rendering SOWs, proposals, and exports from the same source data; never duplicated calculation logic |

Each domain must maintain a single source of truth for its data. Avoid mirrored state and duplicated calculation logic across tabs or components.

## Review Procedure

Use two passes for every PR review:

1. **Correctness pass** — behaviour, data model, API contracts, tests, migrations, safety, accessibility, cache invalidation, and UX. Correctness wins over simplicity.

2. **Simplicity / over-engineering pass** — look for dead props, duplicated state, helpers with one caller, abstractions with one implementation, unused flexibility, hand-rolled platform features, unnecessary dependencies, and code that can be deleted.

When reporting simplicity findings, use concise lines:

```text
<file>:<line>: delete|stdlib|native|yagni|shrink: <what to cut>. <what replaces it>.
```

If there is nothing meaningful to simplify, say: `Lean already. Ship.`
