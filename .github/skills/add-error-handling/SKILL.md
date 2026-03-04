---
name: add-error-handling
description: Use this skill when asked to add error handling, improve resilience, handle exceptions, or make code more robust. Audits a file and wraps external calls with appropriate error handling and logging.
---

## When to Use
Use when the user asks to:
- "add error handling"
- "make this more robust"
- "handle exceptions"
- "what happens if this fails"
- "add retry logic"

## Process

1. **Scan the target file** for unhandled external calls:
   - HTTP requests (httpx, requests, fetch, axios)
   - Database queries
   - Azure SDK calls
   - File I/O
   - Any `await` expression calling an external service

2. **Apply appropriate handling** per call type:

### HTTP / API Calls
```python
try:
    response = await client.get(url)
    response.raise_for_status()
except httpx.TimeoutException:
    logger.error("Request timed out", url=url)
    raise
except httpx.HTTPStatusError as e:
    logger.error("HTTP error", status=e.response.status_code, url=url)
    raise
```

### Azure SDK Calls
```python
from azure.core.exceptions import HttpResponseError, ServiceRequestError
try:
    result = await client.some_operation()
except HttpResponseError as e:
    logger.error("Azure API error", code=e.error.code, message=e.message)
    raise
```

### Database Queries
```python
try:
    result = await db.execute(query)
except Exception as e:
    logger.error("Database error", error=str(e))
    raise
```

3. **Add logging** alongside every error catch — use structured logging:
```python
import logging
logger = logging.getLogger(__name__)
logger.error("message", extra={"key": "value"})
```

4. **Add timeouts** to any HTTP client that doesn't have one:
```python
async with httpx.AsyncClient(timeout=30.0) as client:
```

## Rules
- Never swallow exceptions silently (`except: pass` is forbidden)
- Always log before re-raising
- Add timeouts to every external call
- Don't add retry logic unless specifically asked — keep it focused
