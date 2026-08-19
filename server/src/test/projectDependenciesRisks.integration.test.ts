import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { app } from '../app.js'

vi.mock('../lib/prisma.js', async importOriginal => await importOriginal())

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

let prisma: PrismaClient
let ownerId: string
let foreignOwnerId: string
let ownerHeader: string
let foreignHeader: string
const projectIds: string[] = []

beforeAll(async () => {
  if (!runIntegration) return
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
  await prisma.$connect()
  const owner = await prisma.user.create({
    data: { email: `project-context-owner-${Date.now()}@example.com`, name: 'Project context owner', password: '$2b$10$placeholder' },
  })
  const foreignOwner = await prisma.user.create({
    data: { email: `project-context-foreign-${Date.now()}@example.com`, name: 'Foreign owner', password: '$2b$10$placeholder' },
  })
  ownerId = owner.id
  foreignOwnerId = foreignOwner.id
  ownerHeader = `Bearer ${jwt.sign({ userId: ownerId, role: 'USER' }, process.env.JWT_SECRET!)}`
  foreignHeader = `Bearer ${jwt.sign({ userId: foreignOwnerId, role: 'USER' }, process.env.JWT_SECRET!)}`
})

afterAll(async () => {
  if (!runIntegration) return
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } })
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, foreignOwnerId] } } })
  await prisma.$disconnect()
})

async function createProject(name: string, owner = ownerId) {
  const project = await prisma.project.create({ data: { name: `${name}-${Date.now()}-${Math.random()}`, ownerId: owner } })
  projectIds.push(project.id)
  return project
}

describeIf('project dependency and risk PostgreSQL contract', () => {
  it('persists CRUD, ordering, mitigation and cascade deletion', async () => {
    const project = await createProject('Project context')
    const dependencyOne = await request(app).post(`/api/projects/${project.id}/dependencies`).set('Authorization', ownerHeader).send({ description: 'API access' })
    const dependencyTwo = await request(app).post(`/api/projects/${project.id}/dependencies`).set('Authorization', ownerHeader).send({ description: 'Test data' })
    expect(dependencyOne.status).toBe(201)
    expect(dependencyTwo.status).toBe(201)

    const reorderedDependencies = await request(app)
      .patch(`/api/projects/${project.id}/dependencies/reorder`)
      .set('Authorization', ownerHeader)
      .send({ items: [{ id: dependencyTwo.body.id, order: 0 }, { id: dependencyOne.body.id, order: 1 }] })
    expect(reorderedDependencies.status).toBe(200)
    const dependencies = await request(app).get(`/api/projects/${project.id}/dependencies`).set('Authorization', ownerHeader)
    expect(dependencies.body.map((item: { description: string }) => item.description)).toEqual(['Test data', 'API access'])

    const riskOne = await request(app).post(`/api/projects/${project.id}/risks`).set('Authorization', ownerHeader).send({ description: 'Vendor delay' })
    const riskTwo = await request(app).post(`/api/projects/${project.id}/risks`).set('Authorization', ownerHeader).send({ description: 'Scope change', mitigation: 'Review weekly' })
    expect(riskOne.status).toBe(201)
    expect(riskTwo.status).toBe(201)
    await request(app).put(`/api/projects/${project.id}/risks/${riskOne.body.id}`).set('Authorization', ownerHeader).send({ mitigation: 'Escalate early' })
    await request(app).patch(`/api/projects/${project.id}/risks/reorder`).set('Authorization', ownerHeader).send({ items: [{ id: riskTwo.body.id, order: 0 }, { id: riskOne.body.id, order: 1 }] })
    const risks = await request(app).get(`/api/projects/${project.id}/risks`).set('Authorization', ownerHeader)
    expect(risks.body.map((item: { description: string; mitigation: string | null }) => [item.description, item.mitigation])).toEqual([
      ['Scope change', 'Review weekly'],
      ['Vendor delay', 'Escalate early'],
    ])

    await prisma.project.delete({ where: { id: project.id } })
    expect(await prisma.projectDependency.count({ where: { projectId: project.id } })).toBe(0)
    expect(await prisma.projectRisk.count({ where: { projectId: project.id } })).toBe(0)
  })

  it('isolates foreign projects', async () => {
    const project = await createProject('Foreign project', foreignOwnerId)
    const response = await request(app).get(`/api/projects/${project.id}/risks`).set('Authorization', ownerHeader)
    expect(response.status).toBe(404)
    const foreignResponse = await request(app).post(`/api/projects/${project.id}/dependencies`).set('Authorization', foreignHeader).send({ description: 'Foreign dependency' })
    expect(foreignResponse.status).toBe(201)
  })
})
