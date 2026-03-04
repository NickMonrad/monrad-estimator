---
name: dependency-audit
description: Use this skill when asked to audit dependencies, check for outdated packages, review requirements.txt or package.json, or identify vulnerable or unused packages.
---

## When to Use
Use when the user asks to:
- "audit dependencies"
- "check for outdated packages"
- "are my dependencies up to date"
- "check for vulnerabilities in dependencies"
- "review requirements.txt / package.json"

## Process

### Python (`requirements.txt` / `pyproject.toml`)

1. Read the dependency file
2. Run outdated check:
```bash
pip list --outdated
```
3. Run security audit:
```bash
pip-audit
```
   If `pip-audit` not installed: `pip install pip-audit`

4. Check for:
   - Unpinned versions (`package>=1.0` instead of `package==1.2.3`)
   - Packages not used anywhere in the codebase (scan imports)
   - Known-vulnerable packages flagged by pip-audit

### Node.js (`package.json`)

1. Run audit:
```bash
npm audit
```
2. Check outdated:
```bash
npm outdated
```
3. Check for:
   - `devDependencies` accidentally in `dependencies`
   - Very old major versions of core packages (React, TypeScript, Vite)
   - Unused packages (not imported anywhere)

## Output Format

```
## Dependency Audit Results

### 🔴 Security Vulnerabilities
| Package | Version | Issue | Fix |
|---|---|---|---|

### 🟡 Significantly Outdated
| Package | Current | Latest | Breaking changes? |
|---|---|---|---|

### 🔵 Recommendations
- <suggestion>
```

## Rules
- Only flag packages that are meaningfully outdated (major version behind) or have known CVEs
- Don't flag minor/patch version differences unless there's a security reason
- Suggest the upgrade command: `pip install package==X.Y.Z` or `npm install package@latest`
