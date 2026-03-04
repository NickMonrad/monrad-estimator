---
name: debug-failing-tests
description: Use this skill when tests are failing and the cause is unclear. Systematically reads test output, traces root causes, and identifies fixes without changing test logic unless the tests themselves are wrong.
---

## When to Use
Use when the user says:
- "my tests are failing"
- "why is this test broken"
- "tests were passing, now they're not"
- "CI is failing"
- "fix the failing tests"

## Process

1. **Get the full test output first**

   Python:
   ```bash
   pytest -v --tb=long 2>&1
   ```
   Node/TypeScript:
   ```bash
   npm test -- --reporter=verbose 2>&1
   ```

2. **Categorise failures** — group by error type:
   - `ImportError` / `ModuleNotFoundError` → missing dependency or wrong path
   - `AssertionError` → logic change broke expected output
   - `AttributeError` / `TypeError` → interface change (function signature changed)
   - `ConnectionRefusedError` / timeout → external service not running (DB, API)
   - `FileNotFoundError` → missing fixture or test data file

3. **For each failure, trace in this order:**
   - Read the full stack trace — find the **actual** line that threw, not just the test line
   - Check if the **source code** changed recently (`git log --oneline -10 -- <file>`)
   - Check if the **test** is testing the right thing (tests can be wrong too)
   - Check if a **dependency** changed

4. **Fix the source, not the test** unless:
   - The test expectation is clearly wrong
   - The behaviour was intentionally changed and tests need updating

## Rules
- Never delete a failing test — fix it or skip it with a comment explaining why
- If a test requires an external service (DB, API), note that it needs mocking
- Run tests after each fix to confirm — don't batch fixes blindly
- If more than 3 tests fail for the same root cause, fix the root cause once
