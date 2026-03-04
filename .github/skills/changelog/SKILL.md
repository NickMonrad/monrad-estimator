---
name: changelog
description: Use this skill when asked to write a changelog, summarise recent changes, document what changed in a release, or generate release notes from git history.
---

## When to Use
Use when the user asks to:
- "write a changelog"
- "what changed recently"
- "generate release notes"
- "summarise the last X commits"
- "update the CHANGELOG"

## Process

1. **Read recent git history:**
```bash
git log --oneline -30
```

2. **Categorise commits** into:
   - 🚀 **Features** — new functionality added
   - 🐛 **Bug Fixes** — something broken that was fixed
   - ⚡ **Improvements** — performance, refactoring, UX
   - 🔒 **Security** — security fixes or hardening
   - 📦 **Dependencies** — package updates
   - 🏗️ **Infrastructure** — deployment, CI/CD, config changes
   - 📝 **Docs** — documentation only

3. **Output format:**

```markdown
## [Unreleased] — YYYY-MM-DD

### 🚀 Features
- Added streaming support to chat endpoint
- New Azure AI Search integration for document Q&A

### 🐛 Bug Fixes
- Fixed CORS headers missing on error responses
- Resolved PostgreSQL connection timeout on cold start

### ⚡ Improvements
- Refactored document chunking for better search accuracy
- Reduced Docker image size by 40%

### 📦 Dependencies
- Upgraded FastAPI to 0.115.0
- Updated Azure SDK to latest
```

## Rules
- Skip merge commits and trivial commits ("fix typo", "WIP")
- Group related commits into a single entry
- Write in past tense, active voice: "Added X" not "Adding X"
- If `CHANGELOG.md` exists, prepend the new entry — don't replace the file
