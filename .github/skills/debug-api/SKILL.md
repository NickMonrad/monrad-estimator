---
name: debug-api
description: Use this skill when an API endpoint is broken, returning unexpected responses, or behaving incorrectly. Systematically diagnoses routes, middleware, auth, request/response payloads, and service dependencies.
---

## When to Use
Use when the user says:
- "this API endpoint isn't working"
- "I'm getting a 404/401/500 error"
- "the response is wrong"
- "the API was working, now it's not"
- "debug this endpoint"

## Process

Work through these layers in order — stop when you find the issue:

### 1. Is the server running and reachable?
```bash
curl http://localhost:8000/health
```
If no response → server isn't running or wrong port.

### 2. Does the route exist?
- Check the route is registered in the app
- Check for typos in the path
- Check HTTP method matches

### 3. Is auth blocking the request?
- Try the request with auth disabled or with a valid token
- Check middleware order — auth middleware applied before the route?
- Check token expiry if using JWT

### 4. Is the request payload correct?
- Check Content-Type header (`application/json`)
- Validate the request body against the schema
- Check for missing required fields

### 5. What does the server log say?
Look for the actual exception, not just the HTTP status code.

### 6. Is a downstream service failing?
- Database connection error?
- External API timeout?
- Azure SDK error?

## Output Format

```
## API Debug Report

### Endpoint
<METHOD> <path>

### Symptom
<what the user sees>

### Root Cause
<what's actually wrong>

### Fix
<exact change to make>
```

## Rules
- Always reproduce the error before diagnosing
- Read the server logs — the HTTP status code alone is rarely enough
- Check the simplest things first (is it running? is the route registered?)
- Don't guess — trace the actual request path through the code
