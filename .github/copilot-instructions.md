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
- Never push directly to `main`, approve your own PR, or bypass required checks. Do not merge or enable auto-merge on your own initiative; a specific PR may be merged only after explicit user authorization and the canonical merge gates pass.
- End implementation handoffs without merge authorization with: **Do not merge — waiting for explicit user approval.**
