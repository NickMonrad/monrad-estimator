---
name: refactor
description: Use this skill when asked to refactor code — improve readability, reduce duplication, extract functions, simplify logic, or apply clean code principles without changing behaviour.
---

## When to Use
Use when the user asks to:
- "refactor this"
- "clean up this code"
- "extract this into a function"
- "reduce duplication"
- "make this more readable"
- "simplify this"

## Guiding Principles

Apply these in priority order:
1. **Correctness first** — don't change behaviour
2. **Clarity** — code should read like prose
3. **DRY** — extract repeated logic
4. **Small functions** — each function does one thing
5. **Naming** — variables and functions should describe intent

## Common Refactors

### Extract function
Before:
```python
# inline logic doing X
result = x * 1.1 + base_fee if tier == "premium" else x * 1.0
```
After:
```python
def calculate_price(x: float, tier: str) -> float:
    if tier == "premium":
        return x * 1.1 + base_fee
    return x * 1.0
```

### Remove nested conditionals (early return)
Before:
```python
if user:
    if user.is_active:
        if user.has_permission:
            do_thing()
```
After:
```python
if not user or not user.is_active or not user.has_permission:
    return
do_thing()
```

### Replace magic numbers
Before: `if age > 18`
After: `MINIMUM_AGE = 18; if age > MINIMUM_AGE`

### Extract repeated API calls into a helper
Before: three routes each doing the same DB query inline
After: extract to a shared `get_resource_or_404(id)` helper

## Process

1. **Read the code to refactor** — understand what it does completely
2. **Identify the biggest readability/duplication problem**
3. **Make one focused change** at a time
4. **Keep tests green** — run after each change
5. **Don't refactor and add features at the same time**

## Rules
- Do NOT change behaviour
- Do NOT change public API signatures without asking
- Run tests before and after to verify no regression
- Prefer one clean extraction over many micro-optimisations
