/**
 * legacyCapacityFieldSourceGuard.ts — Direct, maintainable source guard that
 * proves production code no longer accesses the candidate ResourceType /
 * NamedResource legacy capacity columns (issue #418).
 *
 * The guard scans server production source files for Prisma queries on the
 * `resourceType` / `namedResource` models whose arguments reference any
 * candidate field. Files with explicitly permitted candidate-field access
 * (historical snapshot input types, the legacy mapper used only by explicit
 * backfill/reconcile tooling, and scripts) are allowlisted.
 *
 * This is deliberately NOT a generic static-analysis framework: it is one
 * brace-balanced scanner over one well-defined pattern.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const LEGACY_CANDIDATE_FIELDS = [
  'allocationMode',
  'allocationPercent',
  'allocationPct',
  'allocationStartWeek',
  'allocationEndWeek',
  'startWeek',
  'endWeek',
] as const

/** Prisma model operations that can read or write model columns. */
const MODEL_OPS = [
  'findMany',
  'findFirst',
  'findUnique',
  'findUniqueOrThrow',
  'findFirstOrThrow',
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
] as const

const MODEL_RE = /\.(resourceType|namedResource)\.([A-Za-z]+)\(/g

/**
 * Files whose candidate-field access is explicitly permitted:
 *  - projectSnapshotTypes.ts — historical snapshot input types (v1/v2/v3).
 *  - capacityProfileMapping.ts — the legacy→profile mapper, consumed only by
 *    explicit backfill/reconcile/sync tooling after the runtime cutover.
 *  - syncCapacityProfiles.ts / reconcileCapacityProfiles.ts — explicit
 *    tooling, never invoked by normal runtime routes (guarded by
 *    runtimeSyncBoundary.test.ts).
 */
export const GUARD_ALLOWLIST = [
  'src/lib/projectSnapshotTypes.ts',
  'src/lib/capacityProfileMapping.ts',
  'src/lib/syncCapacityProfiles.ts',
  'src/lib/reconcileCapacityProfiles.ts',
] as const

export interface GuardFinding {
  file: string
  model: string
  op: string
  field: string
  snippet: string
}

/**
 * Extract the balanced argument text of a `.<model>.<op>(` call starting at
 * the opening paren index. Returns null when the call is never closed
 * (malformed source).
 */
function balancedArgs(source: string, openParenIndex: number): string | null {
  let depth = 0
  let inString: '"' | "'" | '`' | null = null
  let escaped = false
  for (let i = openParenIndex; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === inString) {
        inString = null
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      continue
    }
    if (ch === '(') depth++
    if (ch === ')') {
      depth--
      if (depth === 0) return source.slice(openParenIndex + 1, i)
    }
  }
  return null
}

/**
 * Strip nested blocks that belong to CapacityProfile writes from query
 * arguments: `capacityProfiles: {...}` nested creates and `legacy: {...}`
 * JSONB provenance payloads. CapacityProfile.legacy and profile-level
 * startWeek/endWeek legitimately carry candidate-shaped keys (issue #418
 * keeps CapacityProfile.legacy in place); only direct column access on
 * ResourceType/NamedResource queries is prohibited.
 */
function stripNestedCapacityBlocks(args: string): string {
  let result = args
  // Remove each `capacityProfiles: { ... }` balanced brace object.
  const capacityKeyRe = /capacityProfiles\s*:/g
  let match: RegExpExecArray | null
  while ((match = capacityKeyRe.exec(result)) !== null) {
    const brace = result.indexOf('{', match.index)
    if (brace < 0) break
    const end = matchingBraceEnd(result, brace)
    if (end < 0) break
    result = result.slice(0, match.index) + result.slice(end + 1)
    capacityKeyRe.lastIndex = match.index
  }
  // Remove each flat `legacy: { ... }` payload.
  return result.replace(/legacy\s*:\s*\{[^{}]*\}/g, 'legacy: {}')
}

/** Index of the closing brace matching the opening brace at `openBraceIndex`. */
function matchingBraceEnd(source: string, openBraceIndex: number): number {
  let depth = 0
  let inString: '"' | "'" | '`' | null = null
  let escaped = false
  for (let i = openBraceIndex; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === inString) {
        inString = null
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      continue
    }
    if (ch === '{') depth++
    if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Scan one source file for prohibited candidate-field access in Prisma
 * resourceType/namedResource queries.
 */
export function findProhibitedCandidateFieldAccess(source: string): GuardFinding[] {
  const findings: GuardFinding[] = []
  let match: RegExpExecArray | null
  MODEL_RE.lastIndex = 0
  while ((match = MODEL_RE.exec(source)) !== null) {
    const [, model, op] = match
    if (!(MODEL_OPS as readonly string[]).includes(op)) continue
    const openParen = source.indexOf('(', match.index + match[0].length - 1)
    if (openParen < 0) continue
    const args = stripNestedCapacityBlocks(balancedArgs(source, openParen) ?? '')
    for (const field of LEGACY_CANDIDATE_FIELDS) {
      // Match the field as an object key (quoted or unquoted) anywhere in the
      // query arguments — select/data/where shapes all use key syntax.
      const keyRe = new RegExp(`["']?${field}["']?\\s*:`)
      if (keyRe.test(args)) {
        findings.push({
          file: '',
          model,
          op,
          field,
          snippet: source.slice(Math.max(0, match.index), match.index + match[0].length + 80).replace(/\s+/g, ' '),
        })
        break
      }
    }
  }
  return findings
}

/**
 * Scan all server production files (excluding tests, scripts and the
 * allowlist) for prohibited candidate-field access.
 *
 * @param serverRoot Absolute path of the server package directory.
 */
export function scanProductionSources(serverRoot: string): GuardFinding[] {
  const findings: GuardFinding[] = []
  const allowlist = new Set(GUARD_ALLOWLIST.map(p => p.replace(/\\/g, '/')))

  function walk(dir: string, relative: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = join(relative, entry.name).replace(/\\/g, '/')
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (rel === 'src/test' || rel === 'src/scripts' || rel === 'node_modules' || rel === 'dist') continue
        walk(full, rel)
        continue
      }
      if (!entry.name.endsWith('.ts') || allowlist.has(rel)) continue
      const source = readFileSync(full, 'utf8')
      for (const finding of findProhibitedCandidateFieldAccess(source)) {
        findings.push({ ...finding, file: rel })
      }
    }
  }

  walk(serverRoot, '')
  return findings
}
