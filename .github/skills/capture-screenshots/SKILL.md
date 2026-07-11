---
name: capture-screenshots
description: Capture or regenerate Monrad Estimator UI screenshots for README and documentation using the repository screenshot script.
---

# Screenshot Capture Skill

Follow `.github/instructions/project.instructions.md` and `.github/instructions/playwright.instructions.md` before running screenshot automation.

## When to use

Use this skill when asked to:

- capture or regenerate application screenshots
- update README or documentation screenshots
- validate a material UI layout change visually
- run the `@screenshots` Playwright spec

## Preconditions

- Use a local development database only.
- Ensure dependencies and Playwright Chromium are installed.
- Ensure API and Vite are serving the branch being documented.
- Do not use Unix-only process commands as the default workflow.

Start the normal watch-mode servers from the repository root when needed:

```bash
npm run dev
```

Run this in a dedicated terminal or use the current agent harness's supported detached-process mode. Verify readiness with the application health endpoint and client URL using tools available on the host platform.

## Capture screenshots

From the repository root:

```bash
npm run screenshots
```

This runs the screenshot-specific Playwright spec and writes PNG files under `docs/screenshots/`.

## Verify the result

- Confirm the expected PNG files exist and are non-empty.
- Open and visually inspect every changed image.
- Check that the branch's current UI is shown, not a stale server process.
- Check light/dark mode, labels, clipping, empty space, and responsive layout when relevant.
- Review the Git diff and keep only intentional image changes.

## Documentation update

Update README or other documentation references only when filenames, captions, page coverage, or layout changed.

Do not automatically commit or push screenshots as a side effect of this skill. Stage only the intended files as part of the tracked feature branch and normal pull-request workflow.

## Notes

- Screenshot tests are excluded from normal CI and are run intentionally when documentation images need updating.
- The spec may create local test data; clean it only with the repository's development cleanup tooling and never against a shared or production database.
- Do not rely on hard-coded screenshot test counts or fixed runtime estimates.
- Use current semantic selectors from the application and update the spec when the accessible UI contract changes.
- Report the exact capture command, changed image files, and visual verification performed.
