import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

const project = { id: 'project-1', ownerId: userId }
const featureOne = { id: 'feature-1', name: 'Feature One', epicId: 'epic-1' }
const featureTwo = { id: 'feature-2', name: 'Feature Two', epicId: 'epic-1' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.project.findFirst).mockResolvedValue(project as never)
  vi.mocked(prisma.feature.findFirst).mockImplementation((async ({ where }: any) => {
    return where.id === featureOne.id ? featureOne : where.id === featureTwo.id ? featureTwo : null
  }) as never)
  vi.mocked(prisma.featureDependency.findMany).mockResolvedValue([])
})

describe('feature dependency validation', () => {
  it('accepts a valid dependency', async () => {
    const dependency = { featureId: featureTwo.id, dependsOnId: featureOne.id, feature: featureTwo, dependsOn: featureOne }
    vi.mocked(prisma.featureDependency.create).mockResolvedValue(dependency as never)

    const response = await request(app)
      .post('/api/projects/project-1/feature-dependencies')
      .set('Authorization', authHeader)
      .send({ featureId: featureTwo.id, dependsOnId: featureOne.id })

    expect(response.status).toBe(201)
    expect(response.body).toEqual(dependency)
    expect(prisma.featureDependency.create).toHaveBeenCalledWith(expect.objectContaining({
      data: { featureId: featureTwo.id, dependsOnId: featureOne.id },
    }))
  })

  it('rejects a self-dependency before querying or writing', async () => {
    const response = await request(app)
      .post('/api/projects/project-1/feature-dependencies')
      .set('Authorization', authHeader)
      .send({ featureId: featureOne.id, dependsOnId: featureOne.id })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('A feature cannot depend on itself')
    expect(prisma.feature.findFirst).not.toHaveBeenCalled()
    expect(prisma.featureDependency.create).not.toHaveBeenCalled()
  })

  it('rejects a duplicate dependency with the existing conflict response', async () => {
    vi.mocked(prisma.featureDependency.create).mockRejectedValue({ code: 'P2002' })

    const response = await request(app)
      .post('/api/projects/project-1/feature-dependencies')
      .set('Authorization', authHeader)
      .send({ featureId: featureTwo.id, dependsOnId: featureOne.id })

    expect(response.status).toBe(409)
    expect(response.body.error).toBe('Dependency already exists')
  })

  it('rejects feature IDs from another project', async () => {
    vi.mocked(prisma.feature.findFirst).mockImplementation((async ({ where }: any) => {
      return where.id === featureOne.id ? featureOne : null
    }) as never)

    const response = await request(app)
      .post('/api/projects/project-1/feature-dependencies')
      .set('Authorization', authHeader)
      .send({ featureId: featureTwo.id, dependsOnId: featureOne.id })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('featureId does not belong to this project')
    expect(prisma.featureDependency.create).not.toHaveBeenCalled()
  })

  it('rejects a direct cycle before creating the dependency', async () => {
    vi.mocked(prisma.featureDependency.findMany).mockImplementation((async ({ where }: any) => {
      return where.featureId === featureOne.id ? [{ dependsOnId: featureTwo.id }] : []
    }) as never)

    const response = await request(app)
      .post('/api/projects/project-1/feature-dependencies')
      .set('Authorization', authHeader)
      .send({ featureId: featureTwo.id, dependsOnId: featureOne.id })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('This dependency would create a circular reference')
    expect(prisma.featureDependency.create).not.toHaveBeenCalled()
  })

  it('rejects a transitive cycle before creating the dependency', async () => {
    const featureThree = { id: 'feature-3', name: 'Feature Three', epicId: 'epic-1' }
    vi.mocked(prisma.feature.findFirst).mockImplementation((async ({ where }: any) => {
      return [featureOne, featureTwo, featureThree].find(feature => feature.id === where.id) ?? null
    }) as never)
    vi.mocked(prisma.featureDependency.findMany).mockImplementation((async ({ where }: any) => {
      if (where.featureId === featureOne.id) return [{ dependsOnId: featureThree.id }]
      if (where.featureId === featureThree.id) return [{ dependsOnId: featureTwo.id }]
      return []
    }) as never)

    const response = await request(app)
      .post('/api/projects/project-1/feature-dependencies')
      .set('Authorization', authHeader)
      .send({ featureId: featureTwo.id, dependsOnId: featureOne.id })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('This dependency would create a circular reference')
    expect(prisma.featureDependency.create).not.toHaveBeenCalled()
  })
})
