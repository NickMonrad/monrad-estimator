---
name: write-readme
description: Use this skill when asked to write a README, update documentation, or create project documentation. Generates comprehensive README files with setup instructions, architecture overview, and usage guide.
---

## When to Use
Use when the user asks to:
- "write a README"
- "update the README"
- "create documentation"
- "document this project"
- "add setup instructions"

## Process

1. **Read the project** — understand what it does, the stack, and key workflows
2. **Check if README.md already exists** — if so, read it before updating
3. **Write or update the README** using the structure below

## README Structure

```markdown
# Project Name

> One sentence describing what this project does and who it's for.

## Prerequisites

- Node.js 20+ / Python 3.12+
- Docker (for local DB)
- ...

## Quick Start

\`\`\`bash
git clone https://github.com/org/repo
cd repo
cp .env.example .env   # fill in values
npm install
npm run dev
\`\`\`

Open http://localhost:5173

## Architecture

<brief description or Mermaid diagram>

## Key Features

- Feature A — description
- Feature B — description

## Development

### Running tests
\`\`\`bash
npm test
npm run test:e2e
\`\`\`

### Database migrations
\`\`\`bash
npx prisma migrate dev
\`\`\`

## Environment Variables

See `.env.example` for all variables. Required ones:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | JWT signing secret |

## Contributing

...

## Licence

MIT
```

## Rules
- Write for a developer who has never seen the project
- Keep Quick Start under 5 commands
- Include the minimum required setup — don't over-document
- If README exists, update it — don't rewrite from scratch unless asked
- Do not include sensitive values (connection strings, real keys)
