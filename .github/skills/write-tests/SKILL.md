---
name: write-tests
description: Use this skill when asked to write unit tests, integration tests, or test coverage for a specific function or module. Analyses existing code and writes comprehensive tests covering happy path, edge cases, and error conditions.
---

## When to Use
Use when the user asks to:
- "write tests for this"
- "add test coverage"
- "write unit tests"
- "test this function"
- "improve test coverage"

## Process

1. **Read the code to test** — understand inputs, outputs, and side effects
2. **Check existing test files** — find the pattern used in this codebase (pytest, Jest, Vitest, etc.)
3. **Identify test cases:**
   - ✅ Happy path — normal successful execution
   - ❌ Error paths — invalid inputs, missing data, failing dependencies
   - 🔲 Edge cases — empty input, zero, null, boundary values
   - 🔒 Auth/permission cases (if applicable)
4. **Write the tests** following existing patterns in the codebase

## Python (pytest)

```python
import pytest
from unittest.mock import AsyncMock, patch

class TestMyFunction:
    def test_happy_path(self):
        result = my_function("valid_input")
        assert result == expected_output

    def test_empty_input_raises(self):
        with pytest.raises(ValueError, match="Input cannot be empty"):
            my_function("")

    def test_invalid_type_raises(self):
        with pytest.raises(TypeError):
            my_function(123)

    @pytest.mark.asyncio
    async def test_async_function(self):
        result = await my_async_function()
        assert result is not None
```

## TypeScript (Vitest/Jest)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('myFunction', () => {
  it('returns expected output for valid input', () => {
    expect(myFunction('valid')).toBe(expectedOutput)
  })

  it('throws on empty input', () => {
    expect(() => myFunction('')).toThrow('Input cannot be empty')
  })

  it('handles null gracefully', () => {
    expect(myFunction(null)).toBeNull()
  })
})
```

## Rules
- Follow existing test file structure and naming conventions
- Mock external dependencies (DB, HTTP calls, Azure SDK) — don't hit real services
- Each test should have one clear assertion
- Test names must describe the scenario: `"returns 404 when user not found"` not `"test 3"`
- Don't test implementation details — test observable behaviour
