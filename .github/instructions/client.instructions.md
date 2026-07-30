---
applyTo: "client/src/**/*.tsx,client/src/**/*.css"
---

# Client UI and Accessibility Instructions

These rules apply to React UI and styling work. They extend `.github/instructions/project.instructions.md`.

## UI conventions

- Primary actions use LAB3 navy (`#1d245b`, `bg-lab3-navy`).
- LAB3 blue (`#2c60f6`, `bg-lab3-blue`) is for hover states and accents.
- Use established grey and dark-mode tokens for secondary controls, borders, and surfaces.
- Reuse existing hand-rolled Tailwind patterns; do not add a UI component library without explicit approval.
- Avoid unrelated visual styling changes while implementing functional work.
- Route client API requests through `client/src/lib/api.ts`; do not add raw `fetch` calls or hard-coded API URLs.

## Accessibility and asynchronous states

Preserve or add, as applicable:

- keyboard navigation
- visible focus
- semantic roles
- screen-reader labels and accessible names
- sufficient colour contrast
- loading indicators or skeletons for asynchronous work
- meaningful empty states for lists and result areas
- actionable inline or toast error feedback

Prefer toast or inline feedback over `alert()`. Do not silently ignore failed writes.

## Testing

Add focused component tests for changed UI behaviour and relevant failure states. Use Playwright only when the browser-visible contract, navigation, permissions, persistence, or a critical cross-domain workflow requires it; then follow `.github/instructions/playwright.instructions.md`.
