/**
 * purgePreV4Snapshots.ts — Standalone maintenance command that deliberately
 * removes every stored pre-V4 (V1/V2/V3) BacklogSnapshot row (issue #444).
 *
 * Intended for explicit invocation by the production-machine agent under
 * issue #404 inside a maintenance window. It NEVER runs during application
 * startup or from an HTTP request, exposes no API or UI, and does not
 * synthesise snapshots. Production execution order (V4 safety snapshots +
 * restore-tested backup first) is governed by #404, not by this tool.
 *
 * Usage:
 *   npx tsx src/scripts/purgePreV4Snapshots.ts          # DRY RUN (default)
 *   npx tsx src/scripts/purgePreV4Snapshots.ts --apply  # destructive apply
 *
 * Or via npm scripts:
 *   npm run capacity-profiles:purge-pre-v4-snapshots            # DRY RUN
 *   npm run capacity-profiles:purge-pre-v4-snapshots -- --apply # apply
 *
 * Exit contract:
 *   0 — dry run completed, or apply completed (only V1/V2/V3 deleted);
 *   1 — apply aborted because malformed/unsupported snapshots exist, an
 *       unknown argument was supplied, or the command failed.
 *
 * Output is aggregate-only (version counts): no project names, project IDs,
 * snapshot IDs, snapshot payloads, user data, or database connection
 * details are ever printed.
 */

import { pathToFileURL } from 'node:url'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import 'dotenv/config'

import {
  purgePreV4Snapshots,
  formatPurgeReport,
} from '../lib/purgePreV4Snapshots.js'

export async function main(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply')
  const unknownArgs = argv.filter(arg => arg !== '--apply')
  if (unknownArgs.length > 0) {
    console.log(`❌ unknown argument(s): ${unknownArgs.join(' ')}`)
    console.log('')
    console.log('Usage:')
    console.log('  npx tsx src/scripts/purgePreV4Snapshots.ts            # DRY RUN (default, zero writes)')
    console.log('  npx tsx src/scripts/purgePreV4Snapshots.ts --apply    # destructive apply (V1/V2/V3 only)')
    return 1
  }

  console.log('🔍 Pre-V4 BacklogSnapshot Purge')
  console.log('================================')
  console.log(apply
    ? 'Mode: APPLY — deletes ONLY positively-classified V1/V2/V3 BacklogSnapshot rows.'
    : 'Mode: DRY RUN (default) — zero writes.')
  console.log('')

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  const prisma = new PrismaClient({ adapter })

  try {
    const report = await purgePreV4Snapshots(prisma, { apply })
    console.log(formatPurgeReport(report))
    return report.aborted ? 1 : 0
  } catch (error) {
    console.log('')
    console.log('❌ Purge failed with error:', error instanceof Error ? error.message : String(error))
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
