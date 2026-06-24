import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

const mockSource = {
  id: 'proj-1',
  ownerId: userId,
  name: 'Original Project',
  description: null,
  customerId: null,
  orgId: null,
  status: 'ACTIVE',
  hoursPerDay: 8,
  bufferWeeks: 0,
  onboardingWeeks: 2,
  startDate: new Date('2026-06-01'),
  taxRate: null,
  taxLabel: null,
  weeklyDemandCache: null,
  timelineEntries: [],
  storyTimelineEntries: [],
  capacityPlans: [],
  resourceTypes: [],
  overheads: [],
  discounts: [],
  epics: [],
}

const mockClonedProject = {
  id: 'proj-clone-1',
  ownerId: userId,
  name: 'Copy of Original Project',
  resourceTypes: [],
  _count: { epics: 0 },
}

function baseTx() {
  return {
    project: {
      create: vi.fn().mockResolvedValue({ id: 'proj-clone-1', name: 'Copy of Original Project' }),
      findFirst: vi.fn().mockResolvedValue(mockClonedProject),
      update: vi.fn(),
    },
    resourceType: { create: vi.fn() },
    namedResource: { create: vi.fn() },
    projectOverhead: { create: vi.fn() },
    projectDiscount: { create: vi.fn() },
    epic: { create: vi.fn() },
    epicDependency: { create: vi.fn() },
    feature: { create: vi.fn() },
    featureDependency: { create: vi.fn() },
    userStory: { create: vi.fn() },
    storyDependency: { create: vi.fn() },
    task: { create: vi.fn() },
    timelineEntry: { create: vi.fn() },
    storyTimelineEntry: { create: vi.fn() },
    capacityPlan: { create: vi.fn() },
    capacityPlanPeriod: { create: vi.fn() },
    capacityPlanEntry: { create: vi.fn() },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/projects/:id/clone', () => {
  it('returns 201 with the cloned project on success', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockSource as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = baseTx()
      return fn(tx)
    })

    const res = await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Copy of Original Project')
  })

  it('returns 404 when source project does not exist', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(null)
    const res = await request(app).post('/api/projects/nonexistent/clone').set('Authorization', authHeader)
    expect(res.status).toBe(404)
  })

  it('returns 401 without auth token', async () => {
    const res = await request(app).post('/api/projects/proj-1/clone')
    expect(res.status).toBe(401)
  })

  it('rolls back on transaction failure', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockSource as any)
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('DB failure'))
    const res = await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(res.status).toBe(500)
    expect(vi.mocked(prisma.project.create)).not.toHaveBeenCalled()
  })

  it('passes timeout:30000 to $transaction', async () => {
    vi.mocked(prisma.project.findFirst).mockResolvedValue(mockSource as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = baseTx()
      return fn(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 30000 }),
    )
  })

  // ── Planning fields ────────────────────────────────────────────────────

  it('preserves planning fields on cloned project', async () => {
    const src = {
      ...mockSource,
      onboardingWeeks: 2,
      bufferWeeks: 3,
      startDate: new Date('2026-06-01'),
      hoursPerDay: 7.5,
      taxRate: 0.1,
      taxLabel: 'GST',
    }
    vi.mocked(prisma.project.findFirst).mockResolvedValue(src as any)
    let captured: Record<string, unknown> = {}
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = baseTx()
      tx.project.create = vi.fn(({ data }: any) => {
        captured = data
        return { id: 'proj-clone-1' }
      })
      return fn(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(captured.onboardingWeeks).toBe(2)
    expect(captured.bufferWeeks).toBe(3)
    expect(captured.startDate).toEqual(new Date('2026-06-01'))
    expect(captured.hoursPerDay).toBe(7.5)
    expect(captured.taxRate).toBe(0.1)
    expect(captured.taxLabel).toBe('GST')
  })

  // ── Feature metadata ───────────────────────────────────────────────────

  it('preserves featureMode, timelineColour, timelineStartWeek on cloned features', async () => {
    const src = {
      ...mockSource,
      epics: [
        {
          id: 'epic-1',
          featureMode: 'parallel',
          scheduleMode: 'sequential',
          timelineStartWeek: null,
          epicDependencies: [],
          epicDependents: [],
          features: [
            {
              id: 'feat-1',
              featureMode: 'parallel',
              timelineColour: '#ff0000',
              timelineStartWeek: 3,
              dependencies: [],
              dependents: [],
              timelineEntry: null,
              userStories: [],
            },
          ],
        },
      ],
    }
    vi.mocked(prisma.project.findFirst).mockResolvedValue(src as any)
    let captured: Record<string, unknown> = {}
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = baseTx()
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.epic.create = vi.fn().mockResolvedValue({ id: 'epic-clone-1' })
      tx.feature.create = vi.fn(({ data }: any) => {
        captured = data
        return { id: 'feat-clone-1' }
      })
      return fn(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(captured.featureMode).toBe('parallel')
    expect(captured.timelineColour).toBe('#ff0000')
    expect(captured.timelineStartWeek).toBe(3)
  })

  // ── Epic dependency remapping ──────────────────────────────────────────

  it('epic dependencies use cloned epic IDs, not source IDs', async () => {
    const src = {
      ...mockSource,
      epics: [
        {
          id: 'epic-a',
          featureMode: 'sequential',
          scheduleMode: 'sequential',
          timelineStartWeek: null,
          epicDependencies: [{ epicId: 'epic-a', dependsOnId: 'epic-b' }],
          epicDependents: [],
          features: [],
        },
        {
          id: 'epic-b',
          featureMode: 'sequential',
          scheduleMode: 'sequential',
          timelineStartWeek: null,
          epicDependencies: [],
          epicDependents: [{ epicId: 'epic-a', dependsOnId: 'epic-b' }],
          features: [],
        },
      ],
    }
    vi.mocked(prisma.project.findFirst).mockResolvedValue(src as any)
    const ids: string[] = []
    const depDataList: any[] = []
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = baseTx()
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.epic.create = vi.fn(() => {
        const id = `epic-c-${ids.length + 1}`
        ids.push(id)
        return { id }
      })
      tx.epicDependency.create = vi.fn(({ data }: any) => {
        depDataList.push(data)
        return {}
      })
      return fn(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(ids).toHaveLength(2)
    expect(depDataList).toHaveLength(1)
    // Both fields use cloned epic IDs, not source IDs "epic-a" / "epic-b"
    expect(depDataList[0].epicId).toBe('epic-c-1')
    expect(depDataList[0].dependsOnId).toBe('epic-c-2')
  })

  // ── Feature deps and timeline entries ───────────────────────────────────

  it('feature dependencies and timeline entries use cloned IDs and preserve values', async () => {
    const src = {
      ...mockSource,
      epics: [
        {
          id: 'epic-1',
          featureMode: 'sequential',
          scheduleMode: 'sequential',
          timelineStartWeek: null,
          epicDependencies: [],
          epicDependents: [],
          features: [
            {
              id: 'feat-1',
              featureMode: 'sequential',
              timelineColour: null,
              timelineStartWeek: null,
              dependencies: [{ featureId: 'feat-1', dependsOnId: 'feat-2' }],
              dependents: [],
              timelineEntry: { startWeek: 2, durationWeeks: 4, isManual: true },
              userStories: [],
            },
            {
              id: 'feat-2',
              featureMode: 'sequential',
              timelineColour: null,
              timelineStartWeek: null,
              dependencies: [],
              dependents: [{ featureId: 'feat-1', dependsOnId: 'feat-2' }],
              timelineEntry: null,
              userStories: [],
            },
          ],
        },
      ],
    }
    vi.mocked(prisma.project.findFirst).mockResolvedValue(src as any)
    const depDataList: any[] = []
    const teDataList: any[] = []
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = baseTx()
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.epic.create = vi.fn().mockResolvedValue({ id: 'epic-clone-1' })
      let fi = 0
      tx.feature.create = vi.fn(() => {
        fi++
        return { id: `feat-c-${fi}` }
      })
      tx.featureDependency.create = vi.fn(({ data }: any) => {
        depDataList.push(data)
        return {}
      })
      tx.timelineEntry.create = vi.fn(({ data }: any) => {
        teDataList.push(data)
        return {}
      })
      return fn(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    // Feature dependency uses cloned feature IDs
    expect(depDataList).toHaveLength(1)
    expect(depDataList[0].featureId).toBe('feat-c-1')
    expect(depDataList[0].dependsOnId).toBe('feat-c-2')
    // Timeline entry uses cloned feature ID and project ID, preserves values
    expect(teDataList).toHaveLength(1)
    expect(teDataList[0].projectId).toBe('proj-clone-1')
    expect(teDataList[0].featureId).toBe('feat-c-1')
    expect(teDataList[0].startWeek).toBe(2)
    expect(teDataList[0].durationWeeks).toBe(4)
    expect(teDataList[0].isManual).toBe(true)
  })

  // ── Story deps and story timeline entries ───────────────────────────────

  it('story dependencies and story timeline entries use cloned IDs and preserve values', async () => {
    const src = {
      ...mockSource,
      epics: [
        {
          id: 'epic-1',
          featureMode: 'sequential',
          scheduleMode: 'sequential',
          timelineStartWeek: null,
          epicDependencies: [],
          epicDependents: [],
          features: [
            {
              id: 'feat-1',
              featureMode: 'sequential',
              timelineColour: null,
              timelineStartWeek: null,
              dependencies: [],
              dependents: [],
              timelineEntry: null,
              userStories: [
                {
                  id: 'story-1',
                  dependencies: [{ storyId: 'story-1', dependsOnId: 'story-2' }],
                  dependents: [],
                  timelineEntry: { startWeek: 1, durationWeeks: 3, isManual: false },
                  tasks: [],
                },
                {
                  id: 'story-2',
                  dependencies: [],
                  dependents: [{ storyId: 'story-1', dependsOnId: 'story-2' }],
                  timelineEntry: null,
                  tasks: [],
                },
              ],
            },
          ],
        },
      ],
    }
    vi.mocked(prisma.project.findFirst).mockResolvedValue(src as any)
    const depDataList: any[] = []
    const steDataList: any[] = []
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = baseTx()
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.epic.create = vi.fn().mockResolvedValue({ id: 'epic-clone-1' })
      tx.feature.create = vi.fn().mockResolvedValue({ id: 'feat-c-1' })
      let si = 0
      tx.userStory.create = vi.fn(() => {
        si++
        return { id: `story-c-${si}` }
      })
      tx.storyDependency.create = vi.fn(({ data }: any) => {
        depDataList.push(data)
        return {}
      })
      tx.storyTimelineEntry.create = vi.fn(({ data }: any) => {
        steDataList.push(data)
        return {}
      })
      return fn(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    // Story dependency uses cloned story IDs
    expect(depDataList).toHaveLength(1)
    expect(depDataList[0].storyId).toBe('story-c-1')
    expect(depDataList[0].dependsOnId).toBe('story-c-2')
    // Story timeline entry uses cloned story ID and project ID, preserves values
    expect(steDataList).toHaveLength(1)
    expect(steDataList[0].projectId).toBe('proj-clone-1')
    expect(steDataList[0].storyId).toBe('story-c-1')
    expect(steDataList[0].startWeek).toBe(1)
    expect(steDataList[0].durationWeeks).toBe(3)
    expect(steDataList[0].isManual).toBe(false)
  })

  // ── Capacity plan ───────────────────────────────────────────────────────

  it('capacity plan entry resourceTypeId is remapped to cloned RT', async () => {
    const src = {
      ...mockSource,
      resourceTypes: [{ id: 'rt-1', namedResources: [] }],
      capacityPlans: [
        {
          id: 'cp-1',
          name: 'Monthly',
          targetWeeks: 12,
          periodWeeks: 4,
          maxDelta: 2,
          isActive: true,
          totalCost: 5000,
          deliveryWeeks: 10,
          periods: [
            {
              id: 'per-1',
              periodIndex: 0,
              startWeek: 0,
              endWeek: 4,
              entries: [{ resourceTypeId: 'rt-1', headcount: 2, demandFTE: 1.5, utilisationPct: 0.75 }],
            },
          ],
        },
      ],
    }
    vi.mocked(prisma.project.findFirst).mockResolvedValue(src as any)
    let entryData: any = {}
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = baseTx()
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
      tx.capacityPlan.create = vi.fn(() => ({ id: 'cp-c-1' }))
      tx.capacityPlanPeriod.create = vi.fn(() => ({ id: 'per-c-1' }))
      tx.capacityPlanEntry.create = vi.fn(({ data }: any) => {
        entryData = data
        return {}
      })
      return fn(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(entryData.resourceTypeId).toBe('rt-c-1')
  })

  it('capacity plan entry throws when resource type is not in rtIdMap', async () => {
    // The source has a capacity plan entry referencing a resource type that
    // is not included in source.resourceTypes, so it cannot be remapped.
    const src = {
      ...mockSource,
      capacityPlans: [
        {
          id: 'cp-1',
          name: 'Monthly',
          targetWeeks: 12,
          periodWeeks: 4,
          maxDelta: 2,
          isActive: true,
          totalCost: null,
          deliveryWeeks: null,
          periods: [
            {
              id: 'per-1',
              periodIndex: 0,
              startWeek: 0,
              endWeek: 4,
              entries: [{ resourceTypeId: 'rt-missing', headcount: 2, demandFTE: 1.5, utilisationPct: 0.75 }],
            },
          ],
        },
      ],
    }
    vi.mocked(prisma.project.findFirst).mockResolvedValue(src as any)
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = baseTx()
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
      tx.capacityPlan.create = vi.fn(() => ({ id: 'cp-c-1' }))
      tx.capacityPlanPeriod.create = vi.fn(() => ({ id: 'per-c-1' }))
      return fn(tx)
    })
    const res = await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(res.status).toBe(500)
  })

  // ── Named resources ─────────────────────────────────────────────────────

  it('named resources are cloned under the cloned resource type ID', async () => {
    const src = {
      ...mockSource,
      resourceTypes: [
        {
          id: 'rt-1',
          namedResources: [
            { name: 'Alice', startWeek: 1, endWeek: 10, allocationPct: 100, allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: null, allocationEndWeek: null, pricingModel: 'ACTUAL_DAYS' },
          ],
        },
      ],
    }
    vi.mocked(prisma.project.findFirst).mockResolvedValue(src as any)
    const nrDataList: any[] = []
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = baseTx()
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
      tx.namedResource.create = vi.fn(({ data }: any) => {
        nrDataList.push(data)
        return {}
      })
      return fn(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(nrDataList).toHaveLength(1)
    expect(nrDataList[0].name).toBe('Alice')
    expect(nrDataList[0].resourceTypeId).toBe('rt-c-1')
    expect(nrDataList[0].startWeek).toBe(1)
    expect(nrDataList[0].endWeek).toBe(10)
  })

  // ── Overhead RT remapping ───────────────────────────────────────────────

  it('project overhead with resourceTypeId is remapped to cloned RT', async () => {
    const src = {
      ...mockSource,
      resourceTypes: [{ id: 'rt-1', namedResources: [] }],
      overheads: [
        { name: 'PM', resourceTypeId: 'rt-1', type: 'FIXED', value: 10000, order: 0 },
      ],
    }
    vi.mocked(prisma.project.findFirst).mockResolvedValue(src as any)
    const ohDataList: any[] = []
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = baseTx()
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
      tx.projectOverhead.create = vi.fn(({ data }: any) => {
        ohDataList.push(data)
        return {}
      })
      return fn(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(ohDataList).toHaveLength(1)
    expect(ohDataList[0].resourceTypeId).toBe('rt-c-1')
    expect(ohDataList[0].name).toBe('PM')
  })

  it('project overhead with null resourceTypeId passes null', async () => {
    const src = {
      ...mockSource,
      overheads: [
        { name: 'Fixed Cost', resourceTypeId: null, type: 'FIXED', value: 5000, order: 0 },
      ],
    }
    vi.mocked(prisma.project.findFirst).mockResolvedValue(src as any)
    const ohDataList: any[] = []
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = baseTx()
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.projectOverhead.create = vi.fn(({ data }: any) => {
        ohDataList.push(data)
        return {}
      })
      return fn(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(ohDataList[0].resourceTypeId).toBeNull()
  })

  // ── Discount RT remapping ──────────────────────────────────────────────

  it('project discount with resourceTypeId is remapped to cloned RT', async () => {
    const src = {
      ...mockSource,
      resourceTypes: [{ id: 'rt-1', namedResources: [] }],
      discounts: [
        { resourceTypeId: 'rt-1', type: 'PERCENTAGE', value: 10, label: 'Early adopter', order: 0 },
      ],
    }
    vi.mocked(prisma.project.findFirst).mockResolvedValue(src as any)
    const discDataList: any[] = []
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = baseTx()
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
      tx.projectDiscount.create = vi.fn(({ data }: any) => {
        discDataList.push(data)
        return {}
      })
      return fn(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(discDataList).toHaveLength(1)
    expect(discDataList[0].resourceTypeId).toBe('rt-c-1')
    expect(discDataList[0].label).toBe('Early adopter')
  })

  it('project discount with null resourceTypeId passes null', async () => {
    const src = {
      ...mockSource,
      discounts: [
        { resourceTypeId: null, type: 'PERCENTAGE', value: 5, label: 'Loyalty', order: 0 },
      ],
    }
    vi.mocked(prisma.project.findFirst).mockResolvedValue(src as any)
    const discDataList: any[] = []
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = baseTx()
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.projectDiscount.create = vi.fn(({ data }: any) => {
        discDataList.push(data)
        return {}
      })
      return fn(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(discDataList[0].resourceTypeId).toBeNull()
  })
})
