# GitHub Copilot Entry Point — Monrad Estimator

Follow the canonical repository-wide contract in:

- `.github/instructions/project.instructions.md`
- `.github/instructions/simplicity-review.instructions.md`
- any additional `.github/instructions/*.instructions.md` file whose `applyTo` pattern matches the files being changed

Do not recreate or override project conventions in this file. The path-scoped instruction files are the source of truth for implementation, validation, review, data safety, Git workflow, and pull-request handoff.

## Copilot-specific behaviour

- Use available tools and specialist agents when they materially improve the result, but do not depend on a particular model or named sub-agent.
- A single implementation agent may make code changes and add the appropriate unit, integration, and Playwright tests.
- Repository skills such as screenshot capture or Smart Memory are optional accelerators. Skip them cleanly when unavailable.
- Never merge, enable auto-merge, approve your own PR, push directly to `main`, or bypass required checks.
- End implementation handoffs with: **Do not merge — wait for review.**
