---
applyTo: "client/**,server/**,e2e/**"
---

# Simplicity and Review Instructions

These instructions apply to implementation and review work in Monrad Estimator. They complement `.github/copilot-instructions.md` and `AGENTS.md`.

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

Do not remove or weaken validation, ownership checks, migration safety, rollback safety, accessibility, loading states, empty states, focused tests, requested scope, or error handling needed to avoid silent failure or data corruption.

## Review Procedure

Use two passes for PR review:

1. Correctness pass: behaviour, data model, API contracts, tests, migrations, safety, accessibility, cache invalidation, and UX.
2. Simplicity pass: over-engineering only. Look for dead props, duplicated state, helpers with one caller, abstractions with one implementation, unused flexibility, hand-rolled platform features, unnecessary dependencies, and code that can be deleted.

Correctness wins over simplicity.

When reporting simplicity findings, use concise lines:

```text
<file>:<line>: delete|stdlib|native|yagni|shrink: <what to cut>. <what replaces it>.
```

If there is nothing meaningful to simplify, say: `Lean already. Ship.`

## Monrad Ownership Check

When a change touches Timeline, Resource Profile, Commercial, or Document export, explicitly check that there is a single source of truth for scheduling, resource allocation, onboarding/buffer weeks, and commercial calculations. Avoid mirrored state and duplicated calculation logic across tabs.
