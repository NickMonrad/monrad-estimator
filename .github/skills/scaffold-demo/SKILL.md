---
name: scaffold-demo
description: Use this skill when asked to scaffold a demo environment, create sample data, or spin up a working demo of the application with realistic test data.
---

## When to Use
Use when the user asks to:
- "scaffold a demo"
- "create demo data"
- "set up a demo environment"
- "populate with sample data"
- "get this ready for a demo"

## What This Does
Creates a realistic demo environment with seeded data so the app can be demoed to stakeholders. Uses the `scaffold-demo.ps1` script for Windows environments or the equivalent bash commands on Linux/macOS.

## Process

### Linux/macOS

1. Ensure both dev servers are running (API on :3001, Vite on :5173)
2. Run the seed script:
```bash
cd server
npx tsx scripts/seed-demo.ts
```

3. Log in with demo credentials:
   - Email: `demo@example.com`
   - Password: `Demo1234!`

4. Verify demo data is visible in the app

### Windows (PowerShell)

Run the scaffold script:
```powershell
.\.github\skills\scaffold-demo\scaffold-demo.ps1
```

## Demo Data Includes
- 1 demo user account
- 2–3 sample projects with realistic names
- Each project has 3–5 epics, each with 2–4 features
- Features have user stories and tasks with effort estimates
- Resource types seeded: Developer, BA, Tech Lead, PM, Governance
- Timeline configured for one project
- Feature templates populated in the template library

## What to Show in a Demo

1. **Login** → show the projects list
2. **Open a project** → walk through the backlog tree
3. **Template library** → show pre-built templates
4. **Apply a template** → generate tasks from a feature template
5. **Timeline page** → show auto-schedule and projected end date
6. **Resource Profile** → show effort distribution by resource type
7. **Export** → CSV export of the backlog

## Rules
- Always run against a non-production database
- Demo data should use realistic but fictional project/customer names
- Don't use real customer data for demos
- Clean up demo data after: `npx tsx scripts/cleanup-demo.ts`
