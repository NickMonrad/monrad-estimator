/**
 * classifyNeedsReplan.ts — Standalone maintenance command that classifies an
 * explicitly supplied, reviewed project set as NEEDS_REPLAN (issue #449).
 *
 * Intended for explicit invocation by the production-machine agent under
 * issue #404 inside a maintenance window. It NEVER runs during application
 * startup or from an HTTP request, exposes no API or UI, and performs no
 * capacity inference, profile reconstruction, percentage, window or
 * owner-kind decisions. Each classified project goes through the same atomic
 * reset transaction body as the normal Reset Planning product action,
 * preserving estimation/business data.
 *
 * Usage:
 *   npx tsx src/scripts/classifyNeedsReplan.ts --manifest manifest.json                      # DRY RUN (default)
 *   npx tsx src/scripts/classifyNeedsReplan.ts --manifest manifest.json --apply \
 *        --expected-fingerprint <sha256>                                                      # apply
 *
 * Manifest shape (reviewed input only — never invented selection rules):
 *   { "projectIds": ["<projectId>", ...] }
 *
 * Dry-run prints `stateFingerprint: <sha256>` — a deterministic fingerprint
 * over the reset-relevant state of the exact manifest set. Apply REQUIRES
 * that reviewed fingerprint via --expected-fingerprint and aborts with zero
 * writes on any drift. The whole apply is one transaction: either every
 * to-classify project is reset or none is.
 *
 * Exit contract:
 *   0 — dry run completed, or apply completed (every manifest project is now
 *       NEEDS_REPLAN or was already NEEDS_REPLAN);
 *   1 — manifest missing/invalid, unknown arguments, missing/malformed
 *       --expected-fingerprint for apply, fingerprint drift, any manifest
 *       project no longer exists (fail closed), or the command failed.
 *
 * Output is sanitized: only operator-supplied project IDs, the reviewed
 * fingerprint hash and aggregate counts are printed — no project names,
 * payloads, user data or database connection details.
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import 'dotenv/config'

import {
  classifyNeedsReplan,
  formatClassificationReport,
  parseClassifyManifest,
  type ClassifyManifest,
} from '../lib/classifyNeedsReplan.js'

const FINGERPRINT_RE = /^[0-9a-f]{64}$/i

export interface ClassifyCliArgs {
  apply: boolean
  manifestPath: string | null
  expectedFingerprint: string | null
  /** Human-readable usage error; null when the arguments are valid. */
  error: string | null
}

/** Pure argument parsing (unit-testable without a database). */
export function parseClassifyCliArgs(argv: string[]): ClassifyCliArgs {
  const apply = argv.includes('--apply')
  const manifestIndex = argv.indexOf('--manifest')
  const manifestPath = manifestIndex >= 0 ? argv[manifestIndex + 1] : null
  const fingerprintIndex = argv.indexOf('--expected-fingerprint')
  const expectedFingerprint = fingerprintIndex >= 0 ? argv[fingerprintIndex + 1] : null
  const known = new Set(['--apply', '--manifest', manifestPath, '--expected-fingerprint', expectedFingerprint])
  const unknownArgs = argv.filter(arg => !known.has(arg))

  if (manifestPath == null || manifestPath === '--apply' || unknownArgs.length > 0) {
    return {
      apply,
      manifestPath: null,
      expectedFingerprint: null,
      error: 'usage: classifyNeedsReplan.ts --manifest <manifest.json> [--apply --expected-fingerprint <sha256>]',
    }
  }
  if (apply && expectedFingerprint == null) {
    return {
      apply,
      manifestPath,
      expectedFingerprint: null,
      error: 'apply requires --expected-fingerprint <sha256> from a dry-run on unchanged state',
    }
  }
  if (expectedFingerprint != null && !FINGERPRINT_RE.test(expectedFingerprint)) {
    return {
      apply,
      manifestPath,
      expectedFingerprint: null,
      error: '--expected-fingerprint must be a 64-character SHA-256 hex digest',
    }
  }
  return { apply, manifestPath, expectedFingerprint, error: null }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseClassifyCliArgs(argv)
  if (args.error) {
    console.log(`❌ ${args.error}`)
    return 1
  }

  let manifest: ClassifyManifest
  try {
    manifest = parseClassifyManifest(JSON.parse(readFileSync(args.manifestPath!, 'utf8')))
  } catch (error) {
    console.log('❌ manifest invalid:', error instanceof Error ? error.message : String(error))
    return 1
  }

  console.log('🔍 Classify projects as NEEDS_REPLAN')
  console.log('====================================')
  console.log(args.apply
    ? 'Mode: APPLY — the reviewed set is classified atomically (one transaction).'
    : 'Mode: DRY RUN (default) — zero writes.')
  console.log('')

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  const prisma = new PrismaClient({ adapter })

  try {
    const report = await classifyNeedsReplan(prisma, manifest, {
      apply: args.apply,
      expectedFingerprint: args.expectedFingerprint ?? undefined,
    })
    console.log(formatClassificationReport(report, args.apply))
    return report.notFoundCount > 0 ? 1 : 0
  } catch (error) {
    console.log('')
    console.log('❌ Classification failed:', error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    await prisma.$disconnect()
  }
}

// Execute only when run directly as a script; importing `main` for tests
// must not trigger process.exit.
const isMain = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href,
)
if (isMain) {
  const exitCode = await main(process.argv.slice(2))
  process.exit(exitCode)
}
