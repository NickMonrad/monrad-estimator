/**
 * classifyNeedsReplan.ts — Standalone maintenance command that classifies an
 * explicitly supplied, reviewed project set as NEEDS_REPLAN (issue #449).
 *
 * Intended for explicit invocation by the production-machine agent under
 * issue #404 inside a maintenance window. It NEVER runs during application
 * startup or from an HTTP request, exposes no API or UI, and performs no
 * capacity inference, profile reconstruction, percentage, window or
 * owner-kind decisions. Each classified project goes through the same atomic
 * reset transaction as the normal Reset Planning product action, preserving
 * estimation/business data.
 *
 * Usage:
 *   npx tsx src/scripts/classifyNeedsReplan.ts --manifest manifest.json        # DRY RUN (default)
 *   npx tsx src/scripts/classifyNeedsReplan.ts --manifest manifest.json --apply # destructive apply
 *
 * Manifest shape (reviewed input only — never invented selection rules):
 *   { "projectIds": ["<projectId>", ...] }
 *
 * Exit contract:
 *   0 — dry run completed, or apply completed (every manifest project is now
 *       NEEDS_REPLAN or was already NEEDS_REPLAN);
 *   1 — manifest missing/invalid, unknown arguments, any manifest project no
 *       longer exists (fail closed), or the command failed.
 *
 * Output is sanitized: only operator-supplied project IDs and aggregate
 * counts are printed — no project names, payloads, user data or database
 * connection details.
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

export async function main(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply')
  const manifestIndex = argv.indexOf('--manifest')
  const manifestPath = manifestIndex >= 0 ? argv[manifestIndex + 1] : null
  const unknownArgs = argv.filter(arg => arg !== '--apply' && arg !== '--manifest' && arg !== manifestPath)
  if (manifestPath == null || manifestPath === '--apply' || unknownArgs.length > 0) {
    console.log('❌ usage: classifyNeedsReplan.ts --manifest <manifest.json> [--apply]')
    console.log('')
    console.log('  --manifest <path>  reviewed JSON manifest: { "projectIds": ["<id>", ...] }')
    console.log('  --apply            destructive apply (default is DRY RUN, zero writes)')
    return 1
  }

  let manifest: ClassifyManifest
  try {
    manifest = parseClassifyManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
  } catch (error) {
    console.log('❌ manifest invalid:', error instanceof Error ? error.message : String(error))
    return 1
  }

  console.log('🔍 Classify projects as NEEDS_REPLAN')
  console.log('====================================')
  console.log(apply
    ? 'Mode: APPLY — each listed project is classified via the atomic reset transaction.'
    : 'Mode: DRY RUN (default) — zero writes.')
  console.log('')

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  const prisma = new PrismaClient({ adapter })

  try {
    const report = await classifyNeedsReplan(prisma, manifest, { apply })
    console.log(formatClassificationReport(report, apply))
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
