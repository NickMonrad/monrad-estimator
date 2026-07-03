/**
 * backfillCapacityProfiles.ts — CLI script for running the capacity profile backfill.
 *
 * Reads existing persisted fields (ResourceType, NamedResource, CapacityPlan)
 * and derives CapacityProfile / CapacitySegment records.
 *
 * Usage:
 *   npx tsx src/scripts/backfillCapacityProfiles.ts                  # run backfill + reconcile
 *   npx tsx src/scripts/backfillCapacityProfiles.ts --dry-run        # reconcile-only (no writes)
 *   npx tsx src/scripts/backfillCapacityProfiles.ts --reconcile-only # reconcile-only (no writes)
 *
 * Or via npm scripts:
 *   npm run capacity-profiles:backfill          # run backfill + reconcile
 *   npm run capacity-profiles:backfill:dry-run  # reconcile-only
 *   npm run capacity-profiles:reconcile         # reconcile-only
 */
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import 'dotenv/config'

import { backfillCapacityProfiles } from '../lib/backfillCapacityProfiles.js'
import {
  reconcileCapacityProfiles,
  formatReconciliationReport,
} from '../lib/reconcileCapacityProfiles.js'

// ─── CLI argument parsing ──────────────────────────────────────────────────

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run') || args.includes('--reconcile-only')

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔧 Capacity Profile Backfill Runner')
  console.log('===================================')

  if (dryRun) {
    console.log('Mode: RECONCILE ONLY (no writes)\n')
  } else {
    console.log('Mode: BACKFILL + RECONCILE\n')
  }

  // Initialize Prisma client
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  const prisma = new PrismaClient({ adapter })

  try {
    // Phase 1: Backfill (unless dry-run)
    if (!dryRun) {
      console.log('Phase 1: Running backfill…')
      const backfillResult = await backfillCapacityProfiles(prisma)

      console.log(`  Profiles created:      ${backfillResult.profilesCreated}`)
      console.log(`  Profiles updated:      ${backfillResult.profilesUpdated}`)
      console.log(`  Segments created:      ${backfillResult.segmentsCreated}`)
      console.log(`  Segments deleted:      ${backfillResult.segmentsDeleted}`)
      console.log('')
    } else {
      console.log('Phase 1: Skipped (dry-run mode)\n')
    }

    // Phase 2: Reconcile
    console.log('Phase 2: Running reconciliation…')
    const report = await reconcileCapacityProfiles(prisma)
    console.log('')
    console.log(formatReconciliationReport(report))

    // Exit code
    if (report.mismatches.length > 0) {
      console.log('')
      console.log('❌ Reconciliation FAILED — mismatches detected.')
      process.exit(1)
    } else {
      console.log('')
      console.log('✅ Reconciliation PASSED — all profiles match.')
      process.exit(0)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main()
