---
name: generate-env-example
description: Use this skill when asked to create a .env.example file, document required environment variables, or audit what environment variables the application uses.
---

## When to Use
Use when the user asks to:
- "create a .env.example"
- "document environment variables"
- "what env vars does this need"
- "generate .env.example from .env"

## Process

1. **Search the codebase for env var reads:**

   Python:
   ```bash
   grep -r "os.environ\|os.getenv\|env(" . --include="*.py" | grep -v ".pyc"
   ```
   Node/TypeScript:
   ```bash
   grep -r "process.env" . --include="*.ts" --include="*.js" | grep -v "node_modules"
   ```

2. **Collect all unique variable names** — include their context (what module uses them)

3. **Categorise them:**
   - 🔑 **Required** — app won't start without these
   - 🔧 **Optional** — has a default, enhances functionality
   - 🧪 **Test only** — only needed for running tests

4. **Write the `.env.example`** with:
   - A comment above each variable explaining what it does
   - Placeholder values that are clearly fake (not real credentials)
   - Grouped by category

## Output Format

```env
# ──────────────────────────────────────────
# Database
# ──────────────────────────────────────────

# PostgreSQL connection string (required)
DATABASE_URL=postgresql://user:password@localhost:5432/mydb

# ──────────────────────────────────────────
# Authentication
# ──────────────────────────────────────────

# JWT signing secret — use a long random string in production
JWT_SECRET=change-me-to-a-long-random-secret

# ──────────────────────────────────────────
# Azure (optional)
# ──────────────────────────────────────────

# Azure OpenAI endpoint (leave blank to disable AI features)
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_API_KEY=
```

## Rules
- Never put real credentials in `.env.example`
- Mark required vs optional clearly
- Include the full variable name even if optional (leave value blank)
- If `.env.example` already exists, update it — don't replace undocumented entries
