---
name: capture-screenshots
description: Use this skill when asked to capture, regenerate, or update screenshots of the app UI for the README or documentation.
---

## When to Use
Use when the user asks to:
- "capture screenshots"
- "take screenshots"
- "update the README screenshots"
- "regenerate screenshots"
- "run the screenshot tests"

## What This Does
Starts both dev servers (if not running), runs the `@screenshots`-tagged Playwright tests, then commits the resulting PNGs to `docs/screenshots/` so they render in the README.

## Process

### 1. Check if servers are running
```bash
# Check for API server on port 3001
lsof -ti:3001

# Check for Vite dev server on port 5173
lsof -ti:5173
```

### 2. Start servers if not running
```bash
cd monrad-estimator

# Start API server (detached so it survives shell exit)
nohup npm run dev --workspace=server > logs/server.log 2>&1 &
SERVER_PID=$!
disown $SERVER_PID

# Start client dev server (detached)
nohup npm run dev --workspace=client > logs/client.log 2>&1 &
CLIENT_PID=$!
disown $CLIENT_PID

# Wait for both to be ready
sleep 5
curl -s http://localhost:3001/health | grep -q ok && echo "API ready"
curl -s http://localhost:5173 > /dev/null && echo "Client ready"
```

### 3. Run the screenshot spec
```bash
cd monrad-estimator
npm run screenshots
# This runs: cd e2e && npx playwright test tests/screenshots.spec.ts --reporter=line
```

### 4. Verify PNGs were created
```bash
ls -lh monrad-estimator/docs/screenshots/*.png
```

### 5. Commit and push
```bash
cd monrad-estimator
git add docs/screenshots/*.png
git commit -m "docs: update screenshots"
git push
```

## Key Files
| File | Purpose |
|---|---|
| `e2e/tests/screenshots.spec.ts` | Playwright spec — 4 tests tagged `@screenshots` |
| `docs/screenshots/*.png` | Generated PNGs committed to repo |
| `README.md` | Embeds PNGs in a 2×2 grid table |

## Notes
- Screenshot tests are **excluded from CI** (`--grep-invert @screenshots` in `e2e.yml`) — they must be run manually
- The spec creates test data (projects, epics, templates) via the UI before capturing — expect ~60s total runtime
- `logs/` directory is gitignored; create it with `mkdir -p logs` if missing
- If a server is already running on the port (from a previous session), skip starting it
- Use `bash mode: async, detach: true` when starting servers so they persist after shell exit
