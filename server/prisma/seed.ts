import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import 'dotenv/config'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

const DEFAULT_GLOBAL_TYPES = [
  { name: 'Business Analyst', category: 'ENGINEERING' as const },
  { name: 'Developer', category: 'ENGINEERING' as const },
  { name: 'Tech Lead', category: 'ENGINEERING' as const },
  { name: 'QA Engineer', category: 'ENGINEERING' as const },
  { name: 'Tech Governance', category: 'GOVERNANCE' as const },
  { name: 'Project Manager', category: 'PROJECT_MANAGEMENT' as const },
]

async function main() {
  // Upsert global resource types
  for (const gt of DEFAULT_GLOBAL_TYPES) {
    await prisma.globalResourceType.upsert({
      where: { name: gt.name },
      create: { ...gt, isDefault: true },
      update: {},
    })
  }

  // Build name -> id map
  const globalTypes = await prisma.globalResourceType.findMany()
  const nameToId = new Map(globalTypes.map(gt => [gt.name, gt.id]))

  // Link existing resource types to global types by name
  const resourceTypes = await prisma.resourceType.findMany({ where: { globalTypeId: null } })
  for (const rt of resourceTypes) {
    const globalTypeId = nameToId.get(rt.name)
    if (globalTypeId) {
      await prisma.resourceType.update({ where: { id: rt.id }, data: { globalTypeId } })
    }
  }

  console.log('Seed complete.')
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
