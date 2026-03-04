---
name: security-scan
description: Use this skill when asked to do a security review, scan for vulnerabilities, audit authentication, check for secrets in code, or review infrastructure for security issues.
---

## When to Use
Use when the user asks to:
- "do a security review"
- "check for vulnerabilities"
- "is there anything unsafe here"
- "scan for secrets"
- "review authentication"

## Process

Work through each layer:

### 1. Secrets in code
```bash
# Look for hardcoded credentials
grep -r "password\|secret\|api_key\|token" . --include="*.py" --include="*.ts" --include="*.env" \
  | grep -v ".env.example" | grep -v "node_modules" | grep -v ".pyc"
```
Flag any hardcoded values that look like real secrets.

### 2. Authentication
- Is JWT secret sufficiently strong and loaded from env?
- Are token expiry times reasonable?
- Is HTTPS enforced in production config?
- Are passwords hashed with bcrypt/argon2 (never MD5/SHA1)?
- Are protected routes actually protected (middleware applied)?

### 3. Input validation
- Are all user inputs validated before use?
- Is SQL built from raw string concatenation? (Use parameterised queries)
- Is user input ever eval'd or exec'd?
- Is file upload restricted to expected types/sizes?

### 4. Dependencies
```bash
# Python
pip-audit

# Node
npm audit
```

### 5. Headers & CORS
- Is CORS locked to specific origins (not `*`) in production?
- Are security headers set? (Content-Security-Policy, X-Frame-Options, etc.)

### 6. Infrastructure (if applicable)
- Are storage accounts/blobs public by default?
- Are database ports exposed to the internet?
- Are managed identities used instead of connection strings where possible?

## Output Format

```
## Security Scan Results

### 🔴 Critical
<issue + location + recommendation>

### 🟠 High
<issue + location + recommendation>

### 🟡 Medium
<issue + location + recommendation>

### 🟢 Passed
<things that look good>
```

## Rules
- Report findings as-is — don't auto-fix without permission
- Never log or output real secrets you find
- Flag and skip if a finding is ambiguous — don't guess
