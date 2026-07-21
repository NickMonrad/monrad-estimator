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
  type AuditReport,
} from '../lib/capacityProfileOwnershipAudit.js'
import { repairIdenticalDuplicates, type RepairResult } from '../lib/capacityProfileOwnershipRepair.js'

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
    const initialAudit = await runOwnershipAudit(prisma)

    if (showJson && !repairIdentical) {
      // Audit-only mode: JSON is the single audit report
      process.stdout.write(auditReportToJson(initialAudit) + '\n')
    } else if (!showJson) {
      log(formatAuditReport(initialAudit))
    }

    let repairResult: RepairResult | null = null
    let finalAudit: AuditReport | null = null

    // Phase 2: Repair (only with explicit flag)
    if (repairIdentical) {
      if (initialAudit.repairableGroups.length === 0) {
        log('')
        log('No identical duplicate groups found. Nothing to repair.')
      } else {
        log('')
        log(`Phase 2: Repairing ${initialAudit.repairableGroups.length} identical duplicate group(s)…`)
        repairResult = await repairIdenticalDuplicates(prisma, initialAudit)
        log(`  Profiles deleted: ${repairResult.profilesDeleted}`)

        // Phase 3: Final audit
        log('')
        log('Phase 3: Running final audit after repair…')
        finalAudit = await runOwnershipAudit(prisma)

        if (!finalAudit.isClean) {
          log('')
          log('❌ Database is NOT clean after repair. Manual resolution required.')
        }
        log('')
        log('✅ Repair complete. Database ready for migration.')
      }

      // Repair mode JSON: one document with all phases
      if (showJson) {
        const output: Record<string, unknown> = {
          initialAudit: JSON.parse(auditReportToJson(initialAudit)),
        }
        if (repairResult) {
          output.repair = repairResult
        }
        if (finalAudit) {
          output.finalAudit = JSON.parse(auditReportToJson(finalAudit))
        }
        if (!finalAudit?.isClean && finalAudit != null) {
          output.clean = false
        } else {
          output.clean = initialAudit.repairableGroups.length === 0 ? initialAudit.isClean : (finalAudit?.isClean ?? false)
        }
        process.stdout.write(JSON.stringify(output, null, 2) + '\n')
      } else if (finalAudit) {
        log(formatAuditReport(finalAudit))
      }
    }

    // Exit non-zero when database is not clean
    const isClean = repairIdentical && finalAudit ? finalAudit.isClean : initialAudit.isClean
    if (!isClean) {
      if (!showJson) {
        log('')
        log('❌ Audit FAILED — blocking issues detected.')
      }
      process.exit(1)
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
