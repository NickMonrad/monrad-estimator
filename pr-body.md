Closes #325

## Summary

Align Squad Planner wording and output descriptions with the capacity-profile model defined in #312.

### Changes

Squad Planner — 5 label updates in SquadPlannerDrawer.tsx:

Before | After
---|---
▶ Generate Plan | ▶ Generate capacity profile
Summary | Capacity profile summary
Capacity Plan | Capacity profile
Apply this plan? Resource profiles will be updated. | Apply this capacity profile? Resource profiles will be updated.
✓ Apply Plan | ✓ Apply capacity profile

### What did not change

- Starting Team Finder — labels and help text were already correct.
- Timeline page — labels were already correct.
- Timeline recommendation engine — secondarySummary text was already correct.
- User guide — already up to date from prior PRs.

### Confirmation

- Scheduling algorithms: unchanged
- Commercial calculations: unchanged
- Data model: unchanged
- Dependencies: unchanged
- #326: out of scope
- Forbidden terms: none found in touched files

### Test results

| Suite | Result |
|---|---|
| Client typecheck | OK |
| Server typecheck | OK |
| Client build | OK |
| timelineUx tests | 9/9 passed |
| timelineDrawerState tests | 2/2 passed |
| Full client test suite | 76/106 passed |
| Server tests | 386/386 passed |

Do not merge. Wait for review.