# Oh My Pi Repository Adapter

This file contains OMP runtime guidance only. It is not a project contract.

Before working, follow:

1. `AGENTS.md`
2. `.github/instructions/project.instructions.md`
3. `.github/instructions/simplicity-review.instructions.md`
4. every matching path-scoped instruction under `.github/instructions/`

The canonical repository instructions remain authoritative.

## OMP execution

- Work inline by default for one coherent implementation, defect, remediation, or review task.
- Use `task` only when the user explicitly requests delegation or when genuinely independent workstreams meet the canonical delegation threshold.
- Omit the optional task `effort` field unless the user explicitly requests per-task effort.
- Omit the optional task `model` selector unless the user explicitly requests a model override.
- Let configured OMP role and agent routing choose the child model.
- Do not use `model: "default"` to mean inheritance from the selected agent.
- Do not use task `hi` as a generic importance flag.
- Keep delegated context compact and self-contained. Do not replay the whole parent prompt or canonical project contract into each worker.
- Do not nest subagents by default.
- The active agent owns scope, design, the integrated diff, validation, final review, and PR handoff.

Do not merge — wait for review.
