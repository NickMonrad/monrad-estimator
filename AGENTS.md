# Agent Entry Point

Before implementing, testing, reviewing, or preparing a pull request in this repository, read and follow:

1. `.github/instructions/project.instructions.md` — canonical repository-wide contract
2. `.github/instructions/simplicity-review.instructions.md` — mandatory correctness and simplicity review procedure
3. any additional `.github/instructions/*.instructions.md` file whose `applyTo` pattern matches the files being changed

Custom agent definitions and tool-specific instruction files are adapters only. They must not override the canonical project instructions.

Never push directly to `main`, merge or enable auto-merge on your own initiative, approve your own PR, or bypass required checks. A specific PR may be merged only after explicit user authorization and only when the canonical merge gates pass. End implementation handoffs without merge authorization with: **Do not merge — waiting for explicit user approval.**
