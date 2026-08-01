/**
 * checkProductionMigrationReadiness.ts — Standalone read-only production
 * readiness command for the legacy capacity-column migration (issue #418).
 *
 * Intended for explicit invocation by the production-machine agent under
 * issue #404. It NEVER runs during application startup or from an HTTP
 * request, exposes no API or UI, and performs no writes, repair,
 * reconciliation or cache clearing.
 *
 * Usage:
 *   npx tsx src/scripts/checkProductionMigrationReadiness.ts
 *
 * Or via npm scripts:
 *   npm run capacity-profiles:readiness
 *
 * Exit contract:
 *   0 — every readiness section passes; the database is migration-ready.
 *   1 — at least one blocker; the destructive migration must not start.
 */

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import 'dotenv/config'

import {
  runProductionMigrationReadiness,
  formatReadinessReport,
} from '../lib/productionMigrationReadiness.js'

async function main() {
  console.log('🔍 Production Migration Readiness Check')
  console.log('=======================================')
  console.log('Mode: READ-ONLY (no writes, no repair)')
  console.log('')

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  const prisma = new PrismaClient({ adapter })

  try {
    const report = await runProductionMigrationReadiness(prisma)
    console.log(formatReadinessReport(report))
    process.exit(report.passed ? 0 : 1)
  } catch (error) {
    console.log('')
    console.log('❌ Readiness check failed with error:', error instanceof Error ? error.message : String(error))
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main()
