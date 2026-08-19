import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../index.js'
import { prisma } from '../lib/prisma.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`

/** Test fixture — bare project shape matching route's include query. */
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
  dependencies: [],
  risks: [],
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
    $queryRaw: vi.fn(),
    project: {
      create: vi.fn().mockResolvedValue({ id: 'proj-clone-1', name: 'Copy of Original Project' }),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    resourceType: { create: vi.fn() },
    namedResource: { create: vi.fn() },
    projectOverhead: { create: vi.fn() },
    projectDiscount: { create: vi.fn() },
    projectDependency: { create: vi.fn() },
    projectRisk: { create: vi.fn() },
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
    capacityProfile: { findMany: vi.fn(), create: vi.fn() },
    capacitySegment: { create: vi.fn() },
  }
}

type CloneTransactionMetadata = {
  projectDependency: { create: (args: unknown) => unknown }
  projectRisk: { create: (args: unknown) => unknown }
}

/**
 * Build a mock Prisma capacity profile row for tx.capacityProfile.findMany.
 * The legacy field uses Prisma.DbNull, Prisma.JsonNull (JS null), or a plain
 * value; matching null-state rows must be returned via $queryRaw.
 */
function makeRawProfile(overrides?: {
  id?: string
  ownerKind?: string
  resourceTypeId?: string | null
  namedResourceId?: string | null
  planningBasis?: string
  source?: string
  defaultPercent?: number | null
  startWeek?: number | null
  endWeek?: number | null
  provenance?: string | null
  segments?: Array<{
    id: string
    startWeek: number
    endWeek: number
    capacityPercent: number
    source: string
  }>
}): Record<string, unknown> {
  const id = overrides?.id ?? 'cp-1'
  const segments = (overrides?.segments ?? [
    { id: 'seg-1', startWeek: 0, endWeek: 5, capacityPercent: 100, source: 'FIXED' },
    { id: 'seg-2', startWeek: 5, endWeek: 10, capacityPercent: 80, source: 'MANUAL' },
  ])
  return {
    id,
    projectId: 'proj-1',
    ownerKind: overrides?.ownerKind ?? 'ROLE',
    resourceTypeId: overrides != null && 'resourceTypeId' in overrides ? overrides.resourceTypeId : 'rt-1',
    namedResourceId: overrides != null && 'namedResourceId' in overrides ? overrides.namedResourceId : null,
    planningBasis: overrides?.planningBasis ?? 'CAPACITY_PROFILE',
    source: overrides?.source ?? 'FIXED',
    defaultPercent: overrides?.defaultPercent ?? 100,
    startWeek: overrides?.startWeek ?? 0,
    endWeek: overrides?.endWeek ?? 10,
    provenance: overrides != null && 'provenance' in overrides ? overrides.provenance : null,
    createdAt: new Date(),
    updatedAt: new Date(),
    segments: segments.map(s => ({
      ...s,
      capacityProfileId: id,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  }
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/projects/:id/clone', () => {
  // ── Basic scenarios ──────────────────────────────────────────────────

  it('returns 201 with the cloned project on success', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = baseTx()
      tx.project.findFirst
        .mockResolvedValueOnce(mockSource as unknown as Record<string, unknown>)
        .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
      tx.capacityProfile.findMany.mockResolvedValue([])
      tx.$queryRaw.mockResolvedValue([])
      return (fn as (tx: unknown) => Promise<unknown>)(tx)
    })

    const res = await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(res.body.name).toBe('Copy of Original Project')
  })

  it('clones project dependencies and risks with new child rows', async () => {
    let cloneTx: CloneTransactionMetadata | undefined
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = baseTx()
      cloneTx = tx
      tx.project.findFirst
        .mockResolvedValueOnce({
          ...mockSource,
          dependencies: [{ id: 'dependency-1', description: 'API access', order: 2 }],
          risks: [{ id: 'risk-1', description: 'Vendor delay', mitigation: 'Escalate early', order: 1 }],
        } as unknown as Record<string, unknown>)
        .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
      tx.capacityProfile.findMany.mockResolvedValue([])
      tx.$queryRaw.mockResolvedValue([])
      return (fn as (tx: unknown) => Promise<unknown>)(tx)
    })

    const response = await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(response.status).toBe(201)
    expect(cloneTx?.projectDependency.create).toHaveBeenCalledWith({
      data: { projectId: 'proj-clone-1', description: 'API access', order: 2 },
    })
    expect(cloneTx?.projectRisk.create).toHaveBeenCalledWith({
      data: { projectId: 'proj-clone-1', description: 'Vendor delay', mitigation: 'Escalate early', order: 1 },
    })
  })

  it('returns 404 when source project does not exist', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = baseTx()
      tx.project.findFirst.mockResolvedValue(null)
      return (fn as (tx: unknown) => Promise<unknown>)(tx)
    })
    const res = await request(app).post('/api/projects/nonexistent/clone').set('Authorization', authHeader)
    expect(res.status).toBe(404)
  })

  it('returns 401 without auth token', async () => {
    const res = await request(app).post('/api/projects/proj-1/clone')
    expect(res.status).toBe(401)
  })

  it('rolls back on transaction failure', async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error('DB failure'))
    const res = await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(res.status).toBe(500)
    expect(vi.mocked(prisma.project.create)).not.toHaveBeenCalled()
  })

  it('passes timeout 30000 and RepeatableRead isolation to $transaction', async () => {
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = baseTx()
      tx.project.findFirst
        .mockResolvedValueOnce(mockSource as unknown as Record<string, unknown>)
        .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
      tx.capacityProfile.findMany.mockResolvedValue([])
      tx.$queryRaw.mockResolvedValue([])
      return (fn as (tx: unknown) => Promise<unknown>)(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 30000, isolationLevel: 'RepeatableRead' }),
    )
  })

  // ── Planning fields ──────────────────────────────────────────────────

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
    const captured: Record<string, unknown> = {}
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = baseTx()
      tx.project.findFirst
        .mockResolvedValueOnce(src as unknown as Record<string, unknown>)
        .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
      tx.project.create = vi.fn((args: unknown) => {
        const data = (args as { data: Record<string, unknown> }).data
        Object.assign(captured, data)
        return { id: 'proj-clone-1' }
      })
      tx.capacityProfile.findMany.mockResolvedValue([])
      tx.$queryRaw.mockResolvedValue([])
      return (fn as (tx: unknown) => Promise<unknown>)(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(captured.onboardingWeeks).toBe(2)
    expect(captured.bufferWeeks).toBe(3)
    expect(captured.startDate).toEqual(new Date('2026-06-01'))
    expect(captured.hoursPerDay).toBe(7.5)
    expect(captured.taxRate).toBe(0.1)
    expect(captured.taxLabel).toBe('GST')
  })

  // ── Feature metadata ─────────────────────────────────────────────────

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
    const captured: Record<string, unknown> = {}
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = baseTx()
      tx.project.findFirst
        .mockResolvedValueOnce(src as unknown as Record<string, unknown>)
        .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.epic.create = vi.fn().mockResolvedValue({ id: 'epic-clone-1' })
      tx.feature.create = vi.fn((args: unknown) => {
        const data = (args as { data: Record<string, unknown> }).data
        Object.assign(captured, data)
        return { id: 'feat-clone-1' }
      })
      tx.capacityProfile.findMany.mockResolvedValue([])
      tx.$queryRaw.mockResolvedValue([])
      return (fn as (tx: unknown) => Promise<unknown>)(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(captured.featureMode).toBe('parallel')
    expect(captured.timelineColour).toBe('#ff0000')
    expect(captured.timelineStartWeek).toBe(3)
  })

  // ── Epic dependency remapping ────────────────────────────────────────

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
    const ids: string[] = []
    const depData: Array<Record<string, unknown>> = []
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = baseTx()
      tx.project.findFirst
        .mockResolvedValueOnce(src as unknown as Record<string, unknown>)
        .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.epic.create = vi.fn((_args: unknown) => {
        const id = `epic-c-${ids.length + 1}`
        ids.push(id)
        return { id }
      })
      tx.epicDependency.create = vi.fn((args: unknown) => {
        depData.push((args as { data: Record<string, unknown> }).data)
        return {}
      })
      tx.capacityProfile.findMany.mockResolvedValue([])
      tx.$queryRaw.mockResolvedValue([])
      return (fn as (tx: unknown) => Promise<unknown>)(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(ids).toHaveLength(2)
    expect(depData).toHaveLength(1)
    // Both fields use cloned epic IDs, not source IDs "epic-a" / "epic-b"
    expect(depData[0].epicId).toBe('epic-c-1')
    expect(depData[0].dependsOnId).toBe('epic-c-2')
  })

  // ── Feature deps and timeline entries ────────────────────────────────

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
    const depData: Array<Record<string, unknown>> = []
    const teData: Array<Record<string, unknown>> = []
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = baseTx()
      tx.project.findFirst
        .mockResolvedValueOnce(src as unknown as Record<string, unknown>)
        .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.epic.create = vi.fn().mockResolvedValue({ id: 'epic-clone-1' })
      let fi = 0
      tx.feature.create = vi.fn(() => {
        fi++
        return { id: `feat-c-${fi}` }
      })
      tx.featureDependency.create = vi.fn((args: unknown) => {
        depData.push((args as { data: Record<string, unknown> }).data)
        return {}
      })
      tx.timelineEntry.create = vi.fn((args: unknown) => {
        teData.push((args as { data: Record<string, unknown> }).data)
        return {}
      })
      tx.capacityProfile.findMany.mockResolvedValue([])
      tx.$queryRaw.mockResolvedValue([])
      return (fn as (tx: unknown) => Promise<unknown>)(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    // Feature dependency uses cloned feature IDs
    expect(depData).toHaveLength(1)
    expect(depData[0].featureId).toBe('feat-c-1')
    expect(depData[0].dependsOnId).toBe('feat-c-2')
    // Timeline entry uses cloned feature ID and project ID, preserves values
    expect(teData).toHaveLength(1)
    expect(teData[0].projectId).toBe('proj-clone-1')
    expect(teData[0].featureId).toBe('feat-c-1')
    expect(teData[0].startWeek).toBe(2)
    expect(teData[0].durationWeeks).toBe(4)
    expect(teData[0].isManual).toBe(true)
  })

  // ── Story deps and story timeline entries ────────────────────────────

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
    const depData: Array<Record<string, unknown>> = []
    const steData: Array<Record<string, unknown>> = []
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = baseTx()
      tx.project.findFirst
        .mockResolvedValueOnce(src as unknown as Record<string, unknown>)
        .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.epic.create = vi.fn().mockResolvedValue({ id: 'epic-clone-1' })
      tx.feature.create = vi.fn().mockResolvedValue({ id: 'feat-c-1' })
      let si = 0
      tx.userStory.create = vi.fn(() => {
        si++
        return { id: `story-c-${si}` }
      })
      tx.storyDependency.create = vi.fn((args: unknown) => {
        depData.push((args as { data: Record<string, unknown> }).data)
        return {}
      })
      tx.storyTimelineEntry.create = vi.fn((args: unknown) => {
        steData.push((args as { data: Record<string, unknown> }).data)
        return {}
      })
      tx.capacityProfile.findMany.mockResolvedValue([])
      tx.$queryRaw.mockResolvedValue([])
      return (fn as (tx: unknown) => Promise<unknown>)(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    // Story dependency uses cloned story IDs
    expect(depData).toHaveLength(1)
    expect(depData[0].storyId).toBe('story-c-1')
    expect(depData[0].dependsOnId).toBe('story-c-2')
    // Story timeline entry uses cloned story ID and project ID, preserves values
    expect(steData).toHaveLength(1)
    expect(steData[0].projectId).toBe('proj-clone-1')
    expect(steData[0].storyId).toBe('story-c-1')
    expect(steData[0].startWeek).toBe(1)
    expect(steData[0].durationWeeks).toBe(3)
    expect(steData[0].isManual).toBe(false)
  })

  // ── Capacity plan ────────────────────────────────────────────────────

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
    let entryData: Record<string, unknown> = {}
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = baseTx()
      tx.project.findFirst
        .mockResolvedValueOnce(src as unknown as Record<string, unknown>)
        .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
      tx.capacityPlan.create = vi.fn(() => ({ id: 'cp-c-1' }))
      tx.capacityPlanPeriod.create = vi.fn(() => ({ id: 'per-c-1' }))
      tx.capacityPlanEntry.create = vi.fn((args: unknown) => {
        entryData = (args as { data: Record<string, unknown> }).data
        return {}
      })
      tx.capacityProfile.findMany.mockResolvedValue([])
      tx.$queryRaw.mockResolvedValue([])
      return (fn as (tx: unknown) => Promise<unknown>)(tx)
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
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = baseTx()
      tx.project.findFirst
        .mockResolvedValueOnce(src as unknown as Record<string, unknown>)
        .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
      tx.capacityPlan.create = vi.fn(() => ({ id: 'cp-c-1' }))
      tx.capacityPlanPeriod.create = vi.fn(() => ({ id: 'per-c-1' }))
      tx.capacityProfile.findMany.mockResolvedValue([])
      tx.$queryRaw.mockResolvedValue([])
      return (fn as (tx: unknown) => Promise<unknown>)(tx)
    })
    const res = await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(res.status).toBe(500)
  })

  // ── Named resources ─────────────────────────────────────────────────

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
    const nrData: Array<Record<string, unknown>> = []
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = baseTx()
      tx.project.findFirst
        .mockResolvedValueOnce(src as unknown as Record<string, unknown>)
        .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
      tx.namedResource.create = vi.fn((args: unknown) => {
        nrData.push((args as { data: Record<string, unknown> }).data)
        return {}
      })
      tx.capacityProfile.findMany.mockResolvedValue([])
      tx.$queryRaw.mockResolvedValue([])
      return (fn as (tx: unknown) => Promise<unknown>)(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(nrData).toHaveLength(1)
    expect(nrData[0].name).toBe('Alice')
    expect(nrData[0].resourceTypeId).toBe('rt-c-1')
    // Candidate legacy capacity columns are no longer copied by clone
    // (issue #418) — capacity state is cloned losslessly via profiles.
    expect(nrData[0].startWeek).toBeUndefined()
    expect(nrData[0].endWeek).toBeUndefined()
  })

  // ── Overhead RT remapping ────────────────────────────────────────────

  it('project overhead with resourceTypeId is remapped to cloned RT', async () => {
    const src = {
      ...mockSource,
      resourceTypes: [{ id: 'rt-1', namedResources: [] }],
      overheads: [
        { name: 'PM', resourceTypeId: 'rt-1', type: 'FIXED', value: 10000, order: 0 },
      ],
    }
    const ohData: Array<Record<string, unknown>> = []
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = baseTx()
      tx.project.findFirst
        .mockResolvedValueOnce(src as unknown as Record<string, unknown>)
        .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
      tx.projectOverhead.create = vi.fn((args: unknown) => {
        ohData.push((args as { data: Record<string, unknown> }).data)
        return {}
      })
      tx.capacityProfile.findMany.mockResolvedValue([])
      tx.$queryRaw.mockResolvedValue([])
      return (fn as (tx: unknown) => Promise<unknown>)(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(ohData).toHaveLength(1)
    expect(ohData[0].resourceTypeId).toBe('rt-c-1')
    expect(ohData[0].name).toBe('PM')
  })

  it('project overhead with null resourceTypeId passes null', async () => {
    const src = {
      ...mockSource,
      overheads: [
        { name: 'Fixed Cost', resourceTypeId: null, type: 'FIXED', value: 5000, order: 0 },
      ],
    }
    const ohData: Array<Record<string, unknown>> = []
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = baseTx()
      tx.project.findFirst
        .mockResolvedValueOnce(src as unknown as Record<string, unknown>)
        .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.projectOverhead.create = vi.fn((args: unknown) => {
        ohData.push((args as { data: Record<string, unknown> }).data)
        return {}
      })
      tx.capacityProfile.findMany.mockResolvedValue([])
      tx.$queryRaw.mockResolvedValue([])
      return (fn as (tx: unknown) => Promise<unknown>)(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(ohData[0].resourceTypeId).toBeNull()
  })

  // ── Discount RT remapping ───────────────────────────────────────────

  it('project discount with resourceTypeId is remapped to cloned RT', async () => {
    const src = {
      ...mockSource,
      resourceTypes: [{ id: 'rt-1', namedResources: [] }],
      discounts: [
        { resourceTypeId: 'rt-1', type: 'PERCENTAGE', value: 10, label: 'Early adopter', order: 0 },
      ],
    }
    const discData: Array<Record<string, unknown>> = []
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = baseTx()
      tx.project.findFirst
        .mockResolvedValueOnce(src as unknown as Record<string, unknown>)
        .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
      tx.projectDiscount.create = vi.fn((args: unknown) => {
        discData.push((args as { data: Record<string, unknown> }).data)
        return {}
      })
      tx.capacityProfile.findMany.mockResolvedValue([])
      tx.$queryRaw.mockResolvedValue([])
      return (fn as (tx: unknown) => Promise<unknown>)(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(discData).toHaveLength(1)
    expect(discData[0].resourceTypeId).toBe('rt-c-1')
    expect(discData[0].label).toBe('Early adopter')
  })

  it('project discount with null resourceTypeId passes null', async () => {
    const src = {
      ...mockSource,
      discounts: [
        { resourceTypeId: null, type: 'PERCENTAGE', value: 5, label: 'Loyalty', order: 0 },
      ],
    }
    const discData: Array<Record<string, unknown>> = []
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
      const tx = baseTx()
      tx.project.findFirst
        .mockResolvedValueOnce(src as unknown as Record<string, unknown>)
        .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
      tx.project.create = vi.fn().mockResolvedValue({ id: 'proj-clone-1' })
      tx.projectDiscount.create = vi.fn((args: unknown) => {
        discData.push((args as { data: Record<string, unknown> }).data)
        return {}
      })
      tx.capacityProfile.findMany.mockResolvedValue([])
      tx.$queryRaw.mockResolvedValue([])
      return (fn as (tx: unknown) => Promise<unknown>)(tx)
    })
    await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
    expect(discData[0].resourceTypeId).toBeNull()
  })

  // ─────────────────────────────────────────────────────────────────────
  // Capacity profile cloning — issue #358
  // ─────────────────────────────────────────────────────────────────────

  describe('capacity profile cloning', () => {
    it('ROLE profiles are cloned with remapped resourceTypeId', async () => {
      const rawProfiles = [
        makeRawProfile({
          id: 'cp-1',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-1',
          namedResourceId: null,
        }),
      ]

      const cpCreateData: Array<Record<string, unknown>> = []
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const tx = baseTx()
        tx.project.findFirst
          .mockResolvedValueOnce({
            ...mockSource,
            resourceTypes: [{ id: 'rt-1', namedResources: [] }],
          } as unknown as Record<string, unknown>)
          .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
        tx.capacityProfile.findMany.mockResolvedValue(rawProfiles)
          tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
        tx.capacityProfile.create = vi.fn((args: unknown) => {
          cpCreateData.push((args as { data: Record<string, unknown> }).data)
          return { id: 'new-cp-1' }
        })
        return (fn as (tx: unknown) => Promise<unknown>)(tx)
      })

      await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
      expect(cpCreateData).toHaveLength(1)
      expect(cpCreateData[0].ownerKind).toBe('ROLE')
      // resourceTypeId is remapped from source 'rt-1' to cloned 'rt-c-1'
      expect(cpCreateData[0].resourceTypeId).toBe('rt-c-1')
      expect(cpCreateData[0].namedResourceId).toBeNull()
    })

    it('NAMED_PERSON profiles are cloned with remapped namedResourceId', async () => {
      const rawProfiles = [
        makeRawProfile({
          id: 'cp-2',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: 'nr-1',
        }),
      ]

      const cpCreateData: Array<Record<string, unknown>> = []
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const tx = baseTx()
        tx.project.findFirst
          .mockResolvedValueOnce({
            ...mockSource,
            resourceTypes: [{ id: 'rt-1', namedResources: [{ id: 'nr-1', name: 'Alice' }] }],
          } as unknown as Record<string, unknown>)
          .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
        tx.capacityProfile.findMany.mockResolvedValue(rawProfiles)
          tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
        tx.namedResource.create = vi.fn(() => ({ id: 'nr-c-1' }))
        tx.capacityProfile.create = vi.fn((args: unknown) => {
          cpCreateData.push((args as { data: Record<string, unknown> }).data)
          return { id: 'new-cp-2' }
        })
        return (fn as (tx: unknown) => Promise<unknown>)(tx)
      })

      await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
      expect(cpCreateData).toHaveLength(1)
      expect(cpCreateData[0].ownerKind).toBe('NAMED_PERSON')
      expect(cpCreateData[0].resourceTypeId).toBeNull()
      // namedResourceId is remapped from source 'nr-1' to cloned 'nr-c-1'
      expect(cpCreateData[0].namedResourceId).toBe('nr-c-1')
    })

    it('PLANNED_RESOURCE profiles are cloned with remapped namedResourceId', async () => {
      const rawProfiles = [
        makeRawProfile({
          id: 'cp-3',
          ownerKind: 'PLANNED_RESOURCE',
          resourceTypeId: null,
          namedResourceId: 'nr-1',
        }),
      ]

      const cpCreateData: Array<Record<string, unknown>> = []
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const tx = baseTx()
        tx.project.findFirst
          .mockResolvedValueOnce({
            ...mockSource,
            resourceTypes: [{ id: 'rt-1', namedResources: [{ id: 'nr-1', name: 'Bob' }] }],
          } as unknown as Record<string, unknown>)
          .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
        tx.capacityProfile.findMany.mockResolvedValue(rawProfiles)
          tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
        tx.namedResource.create = vi.fn(() => ({ id: 'nr-c-1' }))
        tx.capacityProfile.create = vi.fn((args: unknown) => {
          cpCreateData.push((args as { data: Record<string, unknown> }).data)
          return { id: 'new-cp-3' }
        })
        return (fn as (tx: unknown) => Promise<unknown>)(tx)
      })

      await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
      expect(cpCreateData).toHaveLength(1)
      expect(cpCreateData[0].ownerKind).toBe('PLANNED_RESOURCE')
      expect(cpCreateData[0].resourceTypeId).toBeNull()
      expect(cpCreateData[0].namedResourceId).toBe('nr-c-1')
    })

    it('segments are copied 1:1 with values and source preserved', async () => {
      const segments = [
        { id: 'seg-a', startWeek: 2, endWeek: 6, capacityPercent: 90, source: 'MANUAL' },
        { id: 'seg-b', startWeek: 6, endWeek: 12, capacityPercent: 75, source: 'FIXED' },
      ]
      const rawProfiles = [
        makeRawProfile({
          id: 'cp-1',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-1',
          namedResourceId: null,
          segments,
        }),
      ]

      const segCreateData: Array<Record<string, unknown>> = []
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const tx = baseTx()
        tx.project.findFirst
          .mockResolvedValueOnce({
            ...mockSource,
            resourceTypes: [{ id: 'rt-1', namedResources: [] }],
          } as unknown as Record<string, unknown>)
          .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
        tx.capacityProfile.findMany.mockResolvedValue(rawProfiles)
          tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
        tx.capacityProfile.create = vi.fn(() => ({ id: 'new-cp-1' }))
        tx.capacitySegment.create = vi.fn((args: unknown) => {
          segCreateData.push((args as { data: Record<string, unknown> }).data)
          return {}
        })
        return (fn as (tx: unknown) => Promise<unknown>)(tx)
      })

      await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
      expect(segCreateData).toHaveLength(2)
      // First segment
      expect(segCreateData[0].startWeek).toBe(2)
      expect(segCreateData[0].endWeek).toBe(6)
      expect(segCreateData[0].capacityPercent).toBe(90)
      expect(segCreateData[0].source).toBe('MANUAL')
      expect(segCreateData[0].capacityProfileId).toBe('new-cp-1')
      // Second segment
      expect(segCreateData[1].startWeek).toBe(6)
      expect(segCreateData[1].endWeek).toBe(12)
      expect(segCreateData[1].capacityPercent).toBe(75)
      expect(segCreateData[1].source).toBe('FIXED')
      expect(segCreateData[1].capacityProfileId).toBe('new-cp-1')
    })

    it('explicit provenance is preserved on create (issue #405)', async () => {
      const rawProfiles = [
        makeRawProfile({
          id: 'cp-1',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-1',
          namedResourceId: null,
          provenance: 'LEGACY_MAPPER',
        }),
        makeRawProfile({
          id: 'cp-2',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: 'nr-1',
          provenance: 'ROLE_DEFAULT',
        }),
        makeRawProfile({
          id: 'cp-3',
          ownerKind: 'PLANNED_RESOURCE',
          resourceTypeId: null,
          namedResourceId: 'nr-2',
          provenance: 'TRANSFERRED_FROM_SQUAD_PLANNER',
        }),
        makeRawProfile({
          id: 'cp-4',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: 'nr-3',
          provenance: 'RESOURCE_OPTIMISER',
        }),
        makeRawProfile({
          id: 'cp-5',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: 'nr-4',
          provenance: null,
        }),
      ]

      const cpCreateData: Array<Record<string, unknown>> = []
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const tx = baseTx()
        tx.project.findFirst
          .mockResolvedValueOnce({
            ...mockSource,
            resourceTypes: [{
              id: 'rt-1',
              namedResources: [
                { id: 'nr-1', name: 'A' },
                { id: 'nr-2', name: 'B' },
                { id: 'nr-3', name: 'C' },
                { id: 'nr-4', name: 'D' },
              ],
            }],
          } as unknown as Record<string, unknown>)
          .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
        tx.capacityProfile.findMany.mockResolvedValue(rawProfiles)
        tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
        let nrIdx = 0
        tx.namedResource.create = vi.fn(() => ({ id: `nr-c-${++nrIdx}` }))
        tx.capacityProfile.create = vi.fn((args: unknown) => {
          cpCreateData.push((args as { data: Record<string, unknown> }).data)
          return { id: 'new-cp-1' }
        })
        return (fn as (tx: unknown) => Promise<unknown>)(tx)
      })

      await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
      expect(cpCreateData).toHaveLength(5)
      // Every provenance value (and null) round-trips through clone with new
      // clone-owned owner IDs; the removed legacy JSON is never copied
      // (issue #405).
      expect(cpCreateData.map(d => d.provenance).sort())
        .toEqual(['LEGACY_MAPPER', 'RESOURCE_OPTIMISER', 'ROLE_DEFAULT', 'TRANSFERRED_FROM_SQUAD_PLANNER', null].sort())
      for (const data of cpCreateData) {
        expect(data.resourceTypeId ?? data.namedResourceId).toBeDefined()
      }
    })

    it('profile scalars and window fields are preserved on create', async () => {
      const rawProfiles = [
        makeRawProfile({
          id: 'cp-1',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-1',
          namedResourceId: null,
          planningBasis: 'AVAILABILITY_WINDOW',
          source: 'SQUAD_PLANNER',
          defaultPercent: 85,
          startWeek: 3,
          endWeek: 14,
        }),
      ]

      const cpCreateData: Array<Record<string, unknown>> = []
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const tx = baseTx()
        tx.project.findFirst
          .mockResolvedValueOnce({
            ...mockSource,
            resourceTypes: [{ id: 'rt-1', namedResources: [] }],
          } as unknown as Record<string, unknown>)
          .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
        tx.capacityProfile.findMany.mockResolvedValue(rawProfiles)
          tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
        tx.capacityProfile.create = vi.fn((args: unknown) => {
          cpCreateData.push((args as { data: Record<string, unknown> }).data)
          return { id: 'new-cp-1' }
        })
        return (fn as (tx: unknown) => Promise<unknown>)(tx)
      })

      await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
      expect(cpCreateData).toHaveLength(1)
      expect(cpCreateData[0].planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(cpCreateData[0].source).toBe('SQUAD_PLANNER')
      expect(cpCreateData[0].defaultPercent).toBe(85)
      expect(cpCreateData[0].startWeek).toBe(3)
      expect(cpCreateData[0].endWeek).toBe(14)
    })

    it('source profile IDs and segment IDs are never reused (new IDs generated)', async () => {
      // The route reads source profiles/segments from DB via findMany
      // and creates new records via create — it never copies IDs.
      // We verify the create calls reference newly generated IDs,
      // not the source IDs from the fixtures.
      const segments = [
        { id: 'src-seg-1', startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'FIXED' },
      ]
      const rawProfiles = [
        makeRawProfile({
          id: 'src-cp-1',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-1',
          namedResourceId: null,
          segments,
        }),
      ]

      const cpCreateData: Array<Record<string, unknown>> = []
      const segCreateData: Array<Record<string, unknown>> = []
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const tx = baseTx()
        tx.project.findFirst
          .mockResolvedValueOnce({
            ...mockSource,
            resourceTypes: [{ id: 'rt-1', namedResources: [] }],
          } as unknown as Record<string, unknown>)
          .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
        tx.capacityProfile.findMany.mockResolvedValue(rawProfiles)
          tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
        tx.capacityProfile.create = vi.fn((args: unknown) => {
          cpCreateData.push((args as { data: Record<string, unknown> }).data)
          return { id: 'generated-cp-id' }
        })
        tx.capacitySegment.create = vi.fn((args: unknown) => {
          segCreateData.push((args as { data: Record<string, unknown> }).data)
          return {}
        })
        return (fn as (tx: unknown) => Promise<unknown>)(tx)
      })

      await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
      // The created profile has a newly generated ID, not 'src-cp-1'
      expect(cpCreateData).toHaveLength(1)
      // Create data must not carry source IDs into Prisma create
      expect(cpCreateData[0].id).toBeUndefined()
      expect(segCreateData).toHaveLength(1)
      expect(segCreateData[0].id).toBeUndefined()
      // Segment references the new profile ID, not the source profile ID
      expect(segCreateData[0].capacityProfileId).toBe('generated-cp-id')
    })

    it('duplicate-owner source profiles are cloned 1:1 (not deduplicated)', async () => {
      // Two ROLE profiles — same ownerKind but different source IDs
      const rawProfiles = [
        makeRawProfile({
          id: 'cp-a',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-1',
          namedResourceId: null,
          segments: [{ id: 'seg-a1', startWeek: 0, endWeek: 4, capacityPercent: 100, source: 'FIXED' }],
        }),
        makeRawProfile({
          id: 'cp-b',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-1',
          namedResourceId: null,
          segments: [{ id: 'seg-b1', startWeek: 4, endWeek: 8, capacityPercent: 50, source: 'MANUAL' }],
        }),
      ]

      const cpCreateCalls: Array<Record<string, unknown>> = []
      const segCreateCalls: Array<Record<string, unknown>> = []
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const tx = baseTx()
        tx.project.findFirst
          .mockResolvedValueOnce({
            ...mockSource,
            resourceTypes: [{ id: 'rt-1', namedResources: [] }],
          } as unknown as Record<string, unknown>)
          .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
        tx.capacityProfile.findMany.mockResolvedValue(rawProfiles)
          tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
        tx.capacityProfile.create = vi.fn((args: unknown) => {
          cpCreateCalls.push((args as { data: Record<string, unknown> }).data)
          return { id: `new-${cpCreateCalls.length}` }
        })
        tx.capacitySegment.create = vi.fn((args: unknown) => {
          segCreateCalls.push((args as { data: Record<string, unknown> }).data)
          return {}
        })
        return (fn as (tx: unknown) => Promise<unknown>)(tx)
      })

      await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
      // Both profiles must be cloned (not deduplicated by ownerKind)
      expect(cpCreateCalls).toHaveLength(2)
      expect(cpCreateCalls[0].ownerKind).toBe('ROLE')
      expect(cpCreateCalls[1].ownerKind).toBe('ROLE')
      // Both segments must be copied (one per profile)
      expect(segCreateCalls).toHaveLength(2)
    })

    it('missing RT mapping for ROLE profile rejects with 500', async () => {
      // ROLE profile references resourceTypeId 'rt-unknown' not in source.resourceTypes
      const rawProfiles = [
        makeRawProfile({
          id: 'cp-bad',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-unknown',
          namedResourceId: null,
        }),
      ]

      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const tx = baseTx()
        tx.project.findFirst
          .mockResolvedValueOnce({
            ...mockSource,
            resourceTypes: [{ id: 'rt-1', namedResources: [] }],
          } as unknown as Record<string, unknown>)
          .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
        tx.capacityProfile.findMany.mockResolvedValue(rawProfiles)
          tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
        return (fn as (tx: unknown) => Promise<unknown>)(tx)
      })

      const res = await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
      expect(res.status).toBe(500)
    })

    it('missing NR mapping for NAMED_PERSON profile rejects with 500', async () => {
      // NAMED_PERSON profile references namedResourceId 'nr-missing' not in source's NRs
      const rawProfiles = [
        makeRawProfile({
          id: 'cp-bad',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: null,
          namedResourceId: 'nr-missing',
        }),
      ]

      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const tx = baseTx()
        tx.project.findFirst
          .mockResolvedValueOnce({
            ...mockSource,
            resourceTypes: [{ id: 'rt-1', namedResources: [{ id: 'nr-1', name: 'Alice' }] }],
          } as unknown as Record<string, unknown>)
          .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
        tx.capacityProfile.findMany.mockResolvedValue(rawProfiles)
          tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
        tx.namedResource.create = vi.fn(() => ({ id: 'nr-c-1' }))
        return (fn as (tx: unknown) => Promise<unknown>)(tx)
      })

      const res = await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
      expect(res.status).toBe(500)
    })

    it('ROLE profile with non-null namedResourceId (invalid shape) rejects with 500', async () => {
      const rawProfiles = [
        makeRawProfile({
          id: 'cp-invalid',
          ownerKind: 'ROLE',
          resourceTypeId: 'rt-1',
          namedResourceId: 'nr-1',  // ROLE must have null namedResourceId
        }),
      ]

      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const tx = baseTx()
        tx.project.findFirst
          .mockResolvedValueOnce({
            ...mockSource,
            resourceTypes: [{ id: 'rt-1', namedResources: [{ id: 'nr-1', name: 'Alice' }] }],
          } as unknown as Record<string, unknown>)
          .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
        tx.capacityProfile.findMany.mockResolvedValue(rawProfiles)
          tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
        tx.namedResource.create = vi.fn(() => ({ id: 'nr-c-1' }))
        return (fn as (tx: unknown) => Promise<unknown>)(tx)
      })

      const res = await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
      expect(res.status).toBe(500)
    })

    it('NAMED_PERSON profile with non-null resourceTypeId (invalid shape) rejects with 500', async () => {
      const rawProfiles = [
        makeRawProfile({
          id: 'cp-invalid',
          ownerKind: 'NAMED_PERSON',
          resourceTypeId: 'rt-1',    // NAMED_PERSON must have null resourceTypeId
          namedResourceId: 'nr-1',
        }),
      ]

      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const tx = baseTx()
        tx.project.findFirst
          .mockResolvedValueOnce({
            ...mockSource,
            resourceTypes: [{ id: 'rt-1', namedResources: [{ id: 'nr-1', name: 'Alice' }] }],
          } as unknown as Record<string, unknown>)
          .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
        tx.capacityProfile.findMany.mockResolvedValue(rawProfiles)
          tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
        tx.namedResource.create = vi.fn(() => ({ id: 'nr-c-1' }))
        return (fn as (tx: unknown) => Promise<unknown>)(tx)
      })

      const res = await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
      expect(res.status).toBe(500)
    })

    it('unknown ownerKind rejects with 500', async () => {
      const rawProfiles = [
        makeRawProfile({
          id: 'cp-unknown',
          ownerKind: 'INVALID_KIND',
          resourceTypeId: null,
          namedResourceId: null,
        }),
      ]

      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const tx = baseTx()
        tx.project.findFirst
          .mockResolvedValueOnce({
            ...mockSource,
            resourceTypes: [{ id: 'rt-1', namedResources: [] }],
          } as unknown as Record<string, unknown>)
          .mockResolvedValueOnce(mockClonedProject as unknown as Record<string, unknown>)
        tx.capacityProfile.findMany.mockResolvedValue(rawProfiles)
          tx.resourceType.create = vi.fn(() => ({ id: 'rt-c-1' }))
        return (fn as (tx: unknown) => Promise<unknown>)(tx)
      })

      const res = await request(app).post('/api/projects/proj-1/clone').set('Authorization', authHeader)
      expect(res.status).toBe(500)
    })
  })
})
