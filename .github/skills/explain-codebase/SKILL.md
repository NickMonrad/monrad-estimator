---
name: explain-codebase
description: Use this skill when asked to explain the codebase, give a high-level overview, summarise the architecture, describe how components connect, or onboard a new developer.
---

## When to Use
Use when the user asks:
- "explain this codebase"
- "give me an overview"
- "how does this all fit together"
- "I'm new, where do I start"
- "what does this project do"

## Process

1. **Read the top-level directory** — understand the layout
2. **Find the entry point** — `main.py`, `index.ts`, `server.ts`, `app.py`, etc.
3. **Read the README** if it exists
4. **Understand the tech stack** from `package.json`, `requirements.txt`, `pyproject.toml`
5. **Trace the main request flow** — pick one core feature and trace it end-to-end
6. **Identify key modules/files** — which files are most important to understand?

## Output Format

Structure the explanation as:

```markdown
## What this project does
<1-2 sentence purpose statement>

## Tech stack
- Language: 
- Framework:
- Database:
- Key dependencies:

## Project layout
<directory tree with 1-line descriptions>

## How it works — core request flow
<step-by-step trace of main feature>

## Key files to understand
| File | Purpose |
|---|---|
| | |

## Things to know before coding
<gotchas, conventions, non-obvious patterns>
```

## Rules
- Write for a developer who has never seen the project before
- Use concrete examples — trace a real code path, not abstract descriptions
- Highlight anything non-standard or surprising
- Keep it under 600 words — this is orientation, not documentation
