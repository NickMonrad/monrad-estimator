## Remediation summary

### Root cause

The PR changed the section heading in ResourceProfileTab.tsx from "Summary" to "Resource Profile", creating a duplicate heading with the page-level `<h1>` "Resource Profile". Playwright E2E tests using `getByRole('heading', { name: /resource profile/i })` in strict mode failed on two matches.

### Fix

**Section heading** — changed from "Resource Profile" to **"Capacity profile summary"** in `ResourceProfileTab.tsx`. This removes the duplicate while keeping the heading descriptive.

**Unit test** — updated `ResourceProfileTab.test.tsx` to expect "Capacity profile summary" instead of "Resource Profile".

**E2E tests** — three fixes in `resource-allocation.spec.ts`:
1. `gotoResourceProfile` heading assertion: `/^summary$/i` → `/capacity profile summary/i`
2. Inline editor label: `/FTE %/i` → `/Capacity %/i` (two occurrences)
3. Test name: "changing FTE % updates allocated days" → "changing Capacity % updates allocated days"

### Validation
- Client typecheck: OK
- Server typecheck: OK
- Client build: OK
- ResourceProfileTab unit tests: **16/16 passed**
- Server tests: **386/386 passed**
- Playwright E2E: **89/89 passed** (CI green)

### Confirmation
- Scheduling algorithms: unchanged
- Commercial calculations: unchanged (display label string only)
- \#325 and \#326: still out of scope
- Dependencies: unchanged