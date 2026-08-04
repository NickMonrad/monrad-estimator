/**
 * generateSnapshotEvidence.ts — Issue #432: standalone explicitly-invoked,
 * read-only command that extracts sanitized aggregate historical snapshot
 * evidence for the Issue #430 design investigation.
 *
 * NEVER runs during application startup or from an HTTP request; exposes no
 * API or UI. Requires explicit CLI invocation. Performs ZERO database writes:
 * it loads the existing remediation-plan state and snapshot created-at
 * metadata with ordinary read queries and aggregates in pure code.
 *
 * Usage:
 *   npx tsx src/scripts/generateSnapshotEvidence.ts \
 *     --json <output.json> --markdown <output.md> --expected <expected.json>
 *
 * Or via the root npm script:
 *   npm run capacity-profiles:snapshot-evidence -- \
 *     --json <output.json> --markdown <output.md> --expected <expected.json>
 *
 * Expected JSON schema (reviewed production-run values; never hard-coded):
 *   {
 *     "fingerprint": "<64-hex>",
 *     "baselineStateHash": "<64-hex>",
 *     "quarantinedEntries": 574,
 *     "quarantinedSnapshots": 49,
 *     "defectSnapshots": 18,
 *     "windowlessDecisions": 359,
 *     "singleMinusOneDecisions": 7,
 *     "snapshotDecisions": 366,
 *     "liveDecisions": 130,
 *     "unsupported": 0,
 *     "rewriteOperations": 0,
 *     "topology11WindowlessDecisions": 226,
 *     "topology7WindowlessDecisions": 133,
 *     "topology7SingleMinusOneDecisions": 7
 *   }
 *
 * Exit contract:
 *   0 — evidence produced, all gates passed (fingerprint, baseline, counts,
 *       reconciliation) and both output files written;
 *   1 — any refusal: bad arguments, missing/unsafe expected values, existing
 *       output files (never silently overwritten), snapshot parse failure,
 *       unsupported schema version, fingerprint/baseline/count mismatch,
 *       reconciliation failure, or output-write failure.
 *
 * No `--dry-run` option exists: the command is inherently read-only.
 * Credentials and complete database URLs are never printed; runtime errors
 * are converted to controlled reason codes and concise safe messages.
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import 'dotenv/config'

import {
  buildSnapshotEvidenceReport,
  isExpectedBoundaryShape,
  renderSnapshotEvidenceMarkdown,
  SnapshotEvidenceError,
  type SnapshotEvidenceExpected,
  type SnapshotEvidenceReport,
} from '../lib/snapshotEvidence.js'
import { loadRemediationState } from '../lib/productionRemediationPlan.js'

// ─── CLI argument parsing ──────────────────────────────────────────────────

interface CliOptions {
  jsonPath: string | null
  markdownPath: string | null
  expectedPath: string | null
}

function parseArgs(args: string[]): CliOptions | { error: string } {
  const options: CliOptions = { jsonPath: null, markdownPath: null, expectedPath: null }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--json':
        options.jsonPath = args[++i] ?? null
        if (!options.jsonPath) return { error: '--json requires an output file path' }
        break
      case '--markdown':
        options.markdownPath = args[++i] ?? null
        if (!options.markdownPath) return { error: '--markdown requires an output file path' }
        break
      case '--expected':
        options.expectedPath = args[++i] ?? null
        if (!options.expectedPath) return { error: '--expected requires a reviewed expectations file path' }
        break
      default:
        return { error: `unknown argument "${arg}"` }
    }
  }
  if (!options.jsonPath || !options.markdownPath || !options.expectedPath) {
    return { error: '--json, --markdown and --expected are all required' }
  }
  return options
}

function currentCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}

function usage(): string {
  return [
    'Usage:',
    '  generateSnapshotEvidence.ts --json <output.json> --markdown <output.md> --expected <expected.json>',
    '',
    'The command is read-only (zero database writes) and emits sanitized',
    'aggregate evidence only. It fails closed on drift, mismatch, parse',
    'failure, unsupported snapshot versions or unsafe output.',
    'Exit codes: 0 = evidence produced and reconciled; 1 = any refusal.',
  ].join('\n')
}

// ─── Controlled error output (never raw payloads or database details) ──────

function controlledFailure(reason: string): number {
  console.error(`❌ snapshot evidence command refused: ${reason}`)
  return 1
}

// ─── Main ──────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    console.error(`❌ ${parsed.error}`)
    console.error(usage())
    return 1
  }
  const options = parsed

  console.log('🔎 Sanitized Historical Snapshot Evidence (read-only)')
  console.log('=====================================================')

  let expected: SnapshotEvidenceExpected
  try {
    const raw = readFileSync(options.expectedPath!, 'utf-8')
    const candidate: unknown = JSON.parse(raw)
    if (!isExpectedBoundaryShape(candidate)) {
      return controlledFailure('the reviewed expectations file does not match the required schema')
    }
    expected = candidate
  } catch (error) {
    return controlledFailure(
      `cannot read the reviewed expectations file: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  // Output safety: existing files are never silently overwritten.
  for (const path of [options.jsonPath!, options.markdownPath!]) {
    try {
      readFileSync(path)
      return controlledFailure(`output file already exists (refusing to overwrite): ${path}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return controlledFailure(`cannot inspect output path: ${path}`)
      }
    }
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  const prisma = new PrismaClient({ adapter })

  try {
    const state = await loadRemediationState(prisma)
    const snapshotRows = await prisma.backlogSnapshot.findMany({
      select: { id: true, createdAt: true },
      orderBy: { id: 'asc' },
    })
    const snapshotCreatedAtById = new Map<string, string>(
      snapshotRows.map(row => [row.id, row.createdAt.toISOString()]),
    )

    let report: SnapshotEvidenceReport
    try {
      report = buildSnapshotEvidenceReport({
        state,
        snapshotCreatedAtById,
        applicationCommit: currentCommit(),
        generatedAt: new Date().toISOString(),
        expected,
      })
    } catch (error) {
      if (error instanceof SnapshotEvidenceError) {
        return controlledFailure(`${error.code}: ${error.message}`)
      }
      return controlledFailure('evidence aggregation failed internally')
    }

    if (!report.integrityResult.reconciliationPassed) {
      console.error('❌ evidence gates failed — no output emitted:')
      for (const detail of report.reconciliation.details) {
        if (detail.includes('MISMATCH')) console.error(`   - ${detail}`)
      }
      if (!report.integrityResult.fingerprintMatch) console.error('   - fingerprint mismatch')
      if (!report.integrityResult.baselineMatch) console.error('   - baseline-state hash mismatch')
      return 1
    }

    const json = `${JSON.stringify(report, null, 2)}\n`
    const markdown = renderSnapshotEvidenceMarkdown(report)

    writeFileSync(options.jsonPath!, json, { encoding: 'utf-8', flag: 'wx' })
    writeFileSync(options.markdownPath!, markdown, { encoding: 'utf-8', flag: 'wx' })

    console.log(`✅ fingerprint matched (${report.observedBoundary.fingerprint.slice(0, 12)}…)`)
    console.log(`✅ baseline-state hash matched (${report.observedBoundary.baselineStateHash.slice(0, 12)}…)`)
    console.log(`✅ all reviewed counts reconciled`)
    console.log(`✅ JSON written: ${options.jsonPath}`)
    console.log(`✅ Markdown written: ${options.markdownPath}`)
    console.log('')
    console.log('This report is evidence only. It does not authorize remediation, migration, manifest creation or decision selection.')
    return 0
  } finally {
    await prisma.$disconnect().catch(() => undefined)
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
