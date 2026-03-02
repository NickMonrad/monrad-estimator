/**
 * E2E test data cleanup script.
 *
 * Deletes all data created by the Playwright test user (test@example.com)
 * and any FeatureTemplates whose name starts with the E2E prefix ("E2E ").
 *
 * Safe to run against a local dev database; never run against production.
 *
 * Usage:
 *   cd server && npx tsx scripts/e2e-cleanup.ts
 *   # or via npm:
 *   cd server && npm run e2e:cleanup
 */

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import 'dotenv/config'

const E2E_EMAIL = 'test@example.com'
const E2E_TEMPLATE_PREFIX = 'E2E '

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

async function main() {
  console.log('🧹 Starting E2E cleanup…')

  // Projects (cascade-deletes epics → features → stories → tasks, snapshots, timeline)
  const { count: projectCount } = await prisma.project.deleteMany({
    where: { owner: { email: E2E_EMAIL } },
  })
  console.log(`  Deleted ${projectCount} project(s) owned by ${E2E_EMAIL}`)

  // FeatureTemplates created during E2E runs (identified by name prefix)
  const { count: templateCount } = await prisma.featureTemplate.deleteMany({
    where: { name: { startsWith: E2E_TEMPLATE_PREFIX } },
  })
  console.log(`  Deleted ${templateCount} template(s) with prefix "${E2E_TEMPLATE_PREFIX}"`)

  console.log('✅ E2E cleanup complete.')
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
