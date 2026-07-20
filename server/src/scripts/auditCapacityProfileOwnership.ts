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
  // In --json mode, send only JSON to stdout; human-readable output to stderr.
  const log = showJson ? (...args: unknown[]) => process.stderr.write(args.join(' ') + '\n') : console.log

  log('═══ Capacity Profile Ownership Audit ═══')
  log('')

  if (repairIdentical) {
    log('Mode: AUDIT + REPAIR identical duplicates')
    log('')
  } else {
    log('Mode: AUDIT ONLY (no writes)')
    log('')
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  const prisma = new PrismaClient({ adapter })

  try {
    // Phase 1: Audit
    log('Phase 1: Running ownership audit…')
    const report = await runOwnershipAudit(prisma)
    if (showJson) {
      // JSON output to stdout only — one valid JSON document
      process.stdout.write(auditReportToJson(report) + '\n')
    } else {
      log(formatAuditReport(report))
    }

    // Phase 2: Repair (only with explicit flag)
    if (repairIdentical) {
      if (report.repairableGroups.length === 0) {
        log('')
        log('No identical duplicate groups found. Nothing to repair.')
      } else {
        log('')
        log(`Phase 2: Repairing ${report.repairableGroups.length} identical duplicate group(s)…`)
        const repairResult = await repairIdenticalDuplicates(prisma, report)
        log(`  Profiles deleted: ${repairResult.profilesDeleted}`)
        log(`  Segments cascade-deleted: auto (cascade)`)

        // Phase 3: Final audit
        log('')
        log('Phase 3: Running final audit after repair…')
        const finalReport = await runOwnershipAudit(prisma)

        if (showJson) {
          process.stdout.write(auditReportToJson(finalReport) + '\n')
        } else {
          log(formatAuditReport(finalReport))
        }

        if (!finalReport.isClean) {
          log('')
          log('❌ Database is NOT clean after repair. Manual resolution required.')
          process.exit(1)
        }
        log('')
        log('✅ Repair complete. Database ready for migration.')
      }
    }

    // Exit non-zero when database is not clean (including repairable duplicates)
    if (!report.isClean && !repairIdentical) {
      log('')
      log('❌ Audit FAILED — blocking issues detected.')
      process.exit(1)
    }

    // After repair, verify final state
    if (repairIdentical) {
      const finalReport = await runOwnershipAudit(prisma)
      if (!finalReport.isClean) {
        process.exit(1)
      }
    }

    process.exit(0)
  } catch (error) {
    log('')
    log('❌ Audit failed with error:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main()
