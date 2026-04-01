---
name: memory
description: Use this skill to store and retrieve semantic memories across sessions. Call it when you need to remember something important, recall past decisions, or restore context at session start.
---

# Copilot Smart Memory Skill

## Overview
Semantic vector memory backed by sqlite-vector + sentence-transformers. Memories are embedded as 384-dim vectors and retrieved by cosine similarity — not exact key match.

## When to Use

### Session Start (ALWAYS)
At the start of every session, retrieve relevant context:
```bash
source ~/.copilot/venv/bin/activate && python3 ~/.copilot/scripts/memory.py search \
  --query "conventions, decisions, known issues for this project" \
  --repo <repo-name> --limit 15 --threshold 0.25
```

### During Work — Store Memories
Store when you encounter:
- **User preferences/conventions** (`--type convention`): "Always use X instead of Y"
- **Architecture decisions** (`--type decision`): "Chose Puppeteer over @react-pdf/renderer because..."
- **Known bugs/gotchas** (`--type bug`): "Port 3001 shows as redwood-broker in lsof"
- **Important facts** (`--type fact`): "Puppeteer v24 pins Chrome v146"
- **User preferences** (`--type preference`): "User prefers minimal PR descriptions"

```bash
source ~/.copilot/venv/bin/activate && python3 ~/.copilot/scripts/memory.py add \
  --content "DESCRIPTION OF WHAT TO REMEMBER" \
  --type TYPE --scope "repo:REPO_NAME" --repo REPO_NAME \
  --tags "tag1,tag2"
```

### During Work — Search Memories
Search when you need context on a past decision, convention, or known issue:
```bash
source ~/.copilot/venv/bin/activate && python3 ~/.copilot/scripts/memory.py search \
  --query "YOUR NATURAL LANGUAGE QUESTION" \
  --repo REPO_NAME --limit 10
```

### Session End / Checkpoint
When the user says "save", "checkpoint", or "wrap up", flush important learnings:
```bash
# Store any unstored decisions/conventions from this session
source ~/.copilot/venv/bin/activate && python3 ~/.copilot/scripts/memory.py add \
  --content "..." --type decision --scope "repo:REPO_NAME" --repo REPO_NAME
```

## Memory Types

| Type | When to use | Example |
|------|-------------|---------|
| `fact` | Objective information about the codebase | "Prisma 7 uses driver adapter mode with PrismaPg" |
| `decision` | Why something was chosen over alternatives | "Chose TipTap over Quill for rich text — better TypeScript support" |
| `convention` | How things should be done | "Always use npm run typecheck in /client" |
| `bug` | Known issues and workarounds | "prose classes are no-ops — @tailwindcss/typography not installed" |
| `preference` | User's stated preferences | "User prefers Sonnet-orchestrates, Codex-implements pattern" |

## Scope

| Scope | Meaning |
|-------|---------|
| `global` | Applies everywhere (rare) |
| `repo:<name>` | Applies to a specific repo (most common) |

## Commands Reference

```bash
VENV="source ~/.copilot/venv/bin/activate &&"

# Add
$VENV python3 ~/.copilot/scripts/memory.py add --content "..." --type TYPE --scope "repo:NAME" --repo NAME --tags "t1,t2"

# Search (semantic)
$VENV python3 ~/.copilot/scripts/memory.py search --query "..." --repo NAME --limit 10

# List (filter-based)
$VENV python3 ~/.copilot/scripts/memory.py list --repo NAME --type convention --limit 20

# Delete
$VENV python3 ~/.copilot/scripts/memory.py delete --id ID

# Stats
$VENV python3 ~/.copilot/scripts/memory.py stats

# Migrate from old session_state
$VENV python3 ~/.copilot/scripts/memory.py migrate --source ~/sqlite-db/copilot-history.db
```

## Rules
- **Don't store trivial things** — only decisions, conventions, bugs, and facts that would be useful in a future session
- **Keep content concise** — one clear sentence or short paragraph per memory
- **Use specific tags** — helps with list filtering
- **Prefer repo-scoped** over global — most memories are project-specific
- **Deduplicate** — the script rejects exact content+scope matches, but rephrase before adding near-duplicates
- **First load takes ~3s** (model warm-up), subsequent calls are <1s
