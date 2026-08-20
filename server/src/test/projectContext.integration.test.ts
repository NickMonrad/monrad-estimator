import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

let prisma: PrismaClient
let ownerId: string
const projectIds: string[] = []

describeIf('project context PostgreSQL integration', () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
    await prisma.$connect()
    const owner = await prisma.user.create({
      data: {
        email: `project-context-${Date.now()}@example.com`,
        name: 'Project context integration',
        password: '$2b$10$placeholder',
      },
    })
    ownerId = owner.id
  })

  afterAll(async () => {
    if (!prisma) return
    if (projectIds.length > 0) {
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } })
    }
    if (ownerId) await prisma.user.delete({ where: { id: ownerId } })
    await prisma.$disconnect()
  })

  it('cascades project dependencies and risks when a project is deleted', async () => {
    const project = await prisma.project.create({
      data: { name: `Project context ${Date.now()}`, ownerId },
    })
    projectIds.push(project.id)

    await prisma.projectDependency.create({
      data: { projectId: project.id, description: '<p>Dependency</p>', order: 0 },
    })
    await prisma.projectRisk.create({
      data: { projectId: project.id, description: '<p>Risk</p>', mitigation: '<p>Response</p>', order: 0 },
    })

    await prisma.project.delete({ where: { id: project.id } })

    expect(await prisma.projectDependency.count({ where: { projectId: project.id } })).toBe(0)
    expect(await prisma.projectRisk.count({ where: { projectId: project.id } })).toBe(0)
  })
})
