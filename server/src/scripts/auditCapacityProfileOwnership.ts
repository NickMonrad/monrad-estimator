/**
 * auditCapacityProfileOwnership.ts — CLI script for the ownership-integrity audit.
 *
 * Default execution is audit-only (no writes). Pass --repair-identical to delete
 * proven semantically identical duplicate profiles.
 *
 * Usage:
 *   npx tsx src/scripts/auditCapacityProfileOwnership.ts
 *   npx tsx src/scripts/auditCapacityProfileOwnership.ts --json
 *   npx tsx src/scripts/auditCapacityProfileOwnership.ts --repair-identical
 *   npx tsx src/scripts/auditCapacityProfileOwnership.ts --repair-identical --json
 *
 * Or via npm scripts:
 *   npm run capacity-profiles:audit
 *   npm run capacity-profiles:audit:repair
 */

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import 'dotenv/config'

import {
  runOwnershipAudit,
  formatAuditReport,
  auditReportToJson,
} from '../lib/capacityProfileOwnershipAudit.js'
import { repairIdenticalDuplicates } from '../lib/capacityProfileOwnershipRepair.js'

// ─── CLI argument parsing ──────────────────────────────────────────────────

const args = process.argv.slice(2)
const showJson = args.includes('--json')
const repairIdentical = args.includes('--repair-identical')

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══ Capacity Profile Ownership Audit ═══')
  console.log('')

  if (repairIdentical) {
    console.log('Mode: AUDIT + REPAIR identical duplicates')
    console.log('')
  } else {
    console.log('Mode: AUDIT ONLY (no writes)')
    console.log('')
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  const prisma = new PrismaClient({ adapter })

  try {
    // Phase 1: Audit
    console.log('Phase 1: Running ownership audit…')
    const report = await runOwnershipAudit(prisma)

    if (showJson) {
      console.log(auditReportToJson(report))
    } else {
      console.log(formatAuditReport(report))
    }

    // Phase 2: Repair (only with explicit flag)
    if (repairIdentical) {
      if (report.repairableGroups.length === 0) {
        console.log('')
        console.log('No identical duplicate groups found. Nothing to repair.')
      } else {
        console.log('')
        console.log(`Phase 2: Repairing ${report.repairableGroups.length} identical duplicate group(s)…`)
        const repairResult = await repairIdenticalDuplicates(prisma, report)
        console.log(`  Profiles deleted: ${repairResult.profilesDeleted}`)
        console.log(`  Segments cascade-deleted: auto (cascade)`)

        // Phase 3: Final audit
        console.log('')
        console.log('Phase 3: Running final audit after repair…')
        const finalReport = await runOwnershipAudit(prisma)

        if (showJson) {
          console.log(auditReportToJson(finalReport))
        } else {
          console.log(formatAuditReport(finalReport))
        }

        if (!finalReport.isClean) {
          console.log('')
          console.log('❌ Database is NOT clean after repair. Manual resolution required.')
          process.exit(1)
        }
        console.log('')
        console.log('✅ Repair complete. Database ready for migration.')
      }
    }

    // Exit code
    if (!report.isClean && !repairIdentical) {
      console.log('')
      console.log('❌ Audit FAILED — blocking issues detected.')
      process.exit(1)
    }

    // After repair, check final state
    if (repairIdentical) {
      // Re-read state and exit appropriately
      const finalReport = await runOwnershipAudit(prisma)
      if (!finalReport.isClean) {
        process.exit(1)
      }
    }

    process.exit(0)
  } catch (error) {
    console.error('')
    console.error('❌ Audit failed with error:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main()
