---
name: memory
description: Optionally store and retrieve semantic project memories when the local Smart Memory tooling is installed.
---

# Optional Smart Memory Skill

## Purpose

Smart Memory is a workstation-local semantic memory accelerator backed by sqlite-vector and sentence-transformers. It can help recall prior decisions, conventions, and known issues across sessions.

Repository code, tests, issues, and committed documentation remain authoritative. Smart Memory is optional: its absence, failure, or different installation path must not block implementation, testing, review, or pull-request preparation.

## Availability check

The historical default installation uses:

```text
Venv:    ~/.copilot/venv/
Script:  ~/.copilot/scripts/memory.py
Database: ~/sqlite-db/copilot-memory.db
```

Do not assume these paths exist. Check before use and skip the skill cleanly when unavailable.

## When to use

Use Smart Memory when available and useful to:

- recall an architectural decision or established repository convention
- recover context about a known bug or workaround
- retain a durable user preference relevant to future repository work
- checkpoint an important decision that is not already captured in an issue or committed document

Do not use it for transient task progress, secrets, credentials, customer data, personal data, or information that belongs in the repository.

## Search

```bash
source ~/.copilot/venv/bin/activate
python3 ~/.copilot/scripts/memory.py search \
  --query "conventions, decisions, known issues for this project" \
  --repo monrad-estimator --limit 15 --threshold 0.25
```

Search only when additional cross-session context is likely to improve the task. There is no mandatory session-start memory call.

## Add a durable memory

```bash
source ~/.copilot/venv/bin/activate
python3 ~/.copilot/scripts/memory.py add \
  --content "WHAT TO REMEMBER" \
  --type decision \
  --scope "repo:monrad-estimator" \
  --repo monrad-estimator \
  --tags "tag1,tag2"
```

Supported types:

- `fact` — objective codebase information
- `decision` — a choice and its rationale
- `convention` — an established way of working
- `bug` — a known problem or workaround
- `preference` — a durable user preference

Prefer repository-scoped memories and concise standalone statements. Search first to avoid near-duplicates.

## Other commands

```bash
python3 ~/.copilot/scripts/memory.py list --repo monrad-estimator --limit 20
python3 ~/.copilot/scripts/memory.py delete --id ID
python3 ~/.copilot/scripts/memory.py stats
```

## Rules

- Never treat memory output as more trustworthy than current repository state.
- Confirm recalled conventions against committed instructions when they affect correctness or safety.
- Do not store secrets, tokens, passwords, customer material, or sensitive personal information.
- Do not fail or delay the task because the memory environment is unavailable.
- Prefer issues and committed documentation for decisions that other contributors need to discover.
