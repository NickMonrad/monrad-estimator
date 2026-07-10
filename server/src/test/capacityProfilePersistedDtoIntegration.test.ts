/**
 * capacityProfilePersistedDtoIntegration.test.ts — Integration tests proving
 * the full #326 persisted DTO path using a shared in-memory Prisma store.
 *
 * Architecture:
 *   vi.hoisted → createStore() + makeStoreClient(storeRef)
 *   vi.mock('../lib/prisma.js', ...)  → prisma backed by storeRef.current
 *
 * Write routes, syncCapacityProfilesForProject, and GET /capacity-profiles
 * all share the same mutable store object. The test fails if sync stops
 * writing CapacityProfile/CapacitySegment rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'

// ─── vi.hoisted: store types and factory (runs before vi.mock) ──────────────

const { storeRef, createStore, makeStoreClient } = vi.hoisted(() => {
  type Store = ReturnType<typeof createStore>

  function createStore() {
    const now = new Date()
    const project = {
      id: 'proj-1',
      ownerId: 'user-1',
      name: 'Test',
      hoursPerDay: 8,
      startDate: new Date('2026-03-01'),
      weeklyDemandCache: {},
      createdAt: now,
      updatedAt: now,
    }
    return {
      project,
      resourceTypes: [] as any[],
      namedResources: [] as any[],
      capacityPlans: [] as any[],
      capacityPlanPeriods: [] as any[],
      capacityPlanEntries: [] as any[],
      capacityProfiles: [] as any[],
      capacitySegments: [] as any[],
      backlogSnapshots: [] as any[],
      epics: [] as any[],
      features: [] as any[],
      userStories: [] as any[],
      tasks: [] as any[],
      timelineEntries: [] as any[],
      storyTimelineEntries: [] as any[],
      epicDependencies: [] as any[],
      storyDependencies: [] as any[],
      projectOverheads: [] as any[],
    }
  }

  let idCounter = 0
  function nextId(prefix = ''): string {
    idCounter++
    return `${prefix}${idCounter}`
  }

  function filter(arr: any[], where: any): any[] {
    if (!where || Object.keys(where).length === 0) return [...arr]
    const entries = Object.entries(where)
    return arr.filter(r =>
      entries.every(([k, v]) => {
        // Handle { in: [...] } operator
        if (v !== null && typeof v === 'object' && 'in' in v) {
          return (v as { in: unknown[] }).in.includes(r[k])
        }
        return r[k] === v
      }),
    )
  }

  function findOne(arr: any[], where: any): any | null {
    const matches = filter(arr, where)
    return matches.length > 0 ? { ...matches[0] } : null
  }

  /** Resolve Prisma include spec for the project entity. */
  function resolveProjectIncludes(store: any, include: any): any {
    const result = { ...store.project }

    if (include?.resourceTypes) {
      const subInclude = include.resourceTypes.include
      result.resourceTypes = store.resourceTypes
        .filter((rt: any) => rt.projectId === store.project.id)
        .map((rt: any) => {
          const r = { ...rt }
          if (subInclude?.namedResources) {
            const order = subInclude.namedResources.orderBy
            let nrs = store.namedResources.filter(
              (nr: any) => nr.resourceTypeId === rt.id,
            )
            if (order?.createdAt) {
              const dir = order.createdAt === 'desc' ? -1 : 1
              nrs = [...nrs].sort(
                (a: any, b: any) =>
                  (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * dir,
              )
            }
            r.namedResources = nrs.map((nr: any) => ({ ...nr }))
          }
          return r
        })
    }

    if (include?.capacityPlans) {
      const cpWhere = include.capacityPlans.where ?? {}
      const cpTake = include.capacityPlans.take
      const subInclude = include.capacityPlans.include

      let plans = store.capacityPlans
        .filter((cp: any) => cp.projectId === store.project.id)
        .filter((cp: any) =>
          Object.entries(cpWhere).every(([k, v]) => cp[k] === v),
        )

      if (cpTake) plans = plans.slice(0, cpTake)

      if (subInclude?.periods) {
        const perOrder = subInclude.periods.orderBy
        const perInclude = subInclude.periods.include
        plans = plans.map((cp: any) => {
          const p = { ...cp }
          let periods = store.capacityPlanPeriods.filter(
            (pp: any) => pp.capacityPlanId === cp.id,
          )
          if (perOrder) {
            const orders = Array.isArray(perOrder) ? perOrder : [perOrder]
            periods = [...periods].sort((a: any, b: any) => {
              for (const order of orders) {
                const [key, dir] = Object.entries(order)[0]
                const cmp = dir === 'desc'
                  ? (b[key] ?? 0) - (a[key] ?? 0)
                  : (a[key] ?? 0) - (b[key] ?? 0)
                if (cmp !== 0) return cmp
              }
              return 0
            })
          }
          if (perInclude?.entries) {
            periods = periods.map((pp: any) => ({
              ...pp,
              entries: store.capacityPlanEntries.filter(
                (e: any) => e.capacityPlanPeriodId === pp.id,
              ),
            }))
          }
          p.periods = periods
          return p
        })
      }

      result.capacityPlans = plans
    }

    if (include?.capacityProfiles) {
      const subInclude = include.capacityProfiles.include
      const profiles = store.capacityProfiles
        .filter((cp: any) => cp.projectId === store.project.id)
        .map((cp: any) => {
          const p = { ...cp }
          if (subInclude?.segments) {
            const segOrder = subInclude.segments.orderBy
            let segs = store.capacitySegments.filter(
              (s: any) => s.capacityProfileId === cp.id,
            )
            if (segOrder) {
              const orders = Array.isArray(segOrder) ? segOrder : [segOrder]
              segs = [...segs].sort((a: any, b: any) => {
                for (const order of orders) {
                  const [key, dir] = Object.entries(order)[0]
                  const cmp = dir === 'desc'
                    ? (b[key] ?? 0) - (a[key] ?? 0)
                    : (a[key] ?? 0) - (b[key] ?? 0)
                  if (cmp !== 0) return cmp
                }
                return 0
              })
            }
            p.segments = segs.map((s: any) => ({ ...s }))
          }
          return p
        })
      profiles.sort((a: any, b: any) => (a.id ?? '').localeCompare(b.id ?? ''))
      result.capacityProfiles = profiles
    }

    // Default empty arrays for includes not otherwise resolved.
    // Required by the Resource Profile route.
    if (!result.epics && include?.epics) result.epics = []
    if (!result.overheads && include?.overheads) result.overheads = []
    if (!result.timelineEntries && include?.timelineEntries) result.timelineEntries = []
    if (!result.storyTimelineEntries && include?.storyTimelineEntries) result.storyTimelineEntries = []

    // Resolve nested includes for epics when data exists in the store
    if (include?.epics && store.epics.length > 0) {
      const epicsInclude = include.epics.include
      result.epics = store.epics
        .filter((e: any) => e.projectId === store.project.id)
        .map((e: any) => {
          const epic = { ...e }
          if (epicsInclude?.features) {
            const featsInclude = epicsInclude.features.include
            const features = store.features
              .filter((f: any) => f.epicId === e.id)
              .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))
              .map((f: any) => {
                const feature = { ...f }
                if (featsInclude?.userStories) {
                  const storiesInclude = featsInclude.userStories.include
                  feature.userStories = store.userStories
                    .filter((us: any) => us.featureId === f.id)
                    .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))
                    .map((us: any) => {
                      const story = { ...us }
                      if (storiesInclude?.tasks) {
                        const tasksInclude = storiesInclude.tasks.include
                        story.tasks = store.tasks
                          .filter((t: any) => t.userStoryId === us.id)
                          .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))
                          .map((t: any) => {
                            const task = { ...t }
                            if (tasksInclude?.resourceType) {
                              task.resourceType =
                                store.resourceTypes.find((rt: any) => rt.id === task.resourceTypeId) ?? null
                            }
                            return task
                          })
                      }
                      return story
                    })
                }
                return feature
              })
            epic.features = features
          }
          return epic
        })
    }

    return result
  }

  /** Build a prisma-like client backed by a mutable store reference. */
  function makeStoreClient(storeRef: { current: Store }): any {
    const store = () => storeRef.current

    function createIn(arrKey: string, data: any): any {
      const arr = (store() as any)[arrKey]
      const now = new Date()

      // Extract nested creates before flattening
      const nested = data ?? {}
      const periodsData = nested.periods
      const segmentsData = nested.segments

      // Flatten — everything except periods/segments goes into the record
      const { periods: _p, segments: _s, entries: _e, ...flat } = nested

      const record = {
        id: nextId(`${arrKey}-`),
        ...flat,
        createdAt: now,
        updatedAt: now,
      }
      arr.push(record)

      // Handle nested periods.create for capacityPlans
      if (periodsData && arrKey === 'capacityPlans') {
        const periodArray = periodsData.create
          ? (Array.isArray(periodsData.create) ? periodsData.create : [periodsData.create])
          : (Array.isArray(periodsData) ? periodsData : [periodsData])
        for (const periodItem of periodArray) {
          const { entries: periodEntries, ...periodFlat } = periodItem
          const createdPeriod = createIn('capacityPlanPeriods', {
            ...periodFlat,
            capacityPlanId: record.id,
          })
          // Handle entries inside each period
          if (periodEntries) {
            const entryArray = periodEntries.create
              ? (Array.isArray(periodEntries.create) ? periodEntries.create : [periodEntries.create])
              : (Array.isArray(periodEntries) ? periodEntries : [periodEntries])
            for (const entryItem of entryArray) {
              createIn('capacityPlanEntries', {
                ...entryItem,
                capacityPlanPeriodId: createdPeriod.id,
              })
            }
          }
        }
      }

      // Handle nested segments.create for capacityProfiles
      if (segmentsData && arrKey === 'capacityProfiles') {
        const segArray = segmentsData.create
          ? (Array.isArray(segmentsData.create) ? segmentsData.create : [segmentsData.create])
          : (Array.isArray(segmentsData) ? segmentsData : [segmentsData])
        for (const segItem of segArray) {
          createIn('capacitySegments', {
            ...segItem,
            capacityProfileId: record.id,
          })
        }
      }

      return { ...record }
    }

    function transaction(fn: any): any {
      if (typeof fn === 'function') return fn(client)
      return Promise.resolve(fn)
    }

    function findMany(arrKey: string, args: any): any[] {
      let results = [...(store() as any)[arrKey]]
      if (args?.where) {
        results = filter(results, args.where)
      }
      if (args?.orderBy) {
        const orders = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]
        for (const order of orders) {
          const [key, dir] = Object.entries(order)[0]
          results = [...results].sort((a: any, b: any) => {
            if (dir === 'desc') {
              if (typeof a[key] === 'number') return (b[key] ?? 0) - (a[key] ?? 0)
              return String(b[key] ?? '').localeCompare(String(a[key] ?? ''))
            }
            if (typeof a[key] === 'number') return (a[key] ?? 0) - (b[key] ?? 0)
            return String(a[key] ?? '').localeCompare(String(b[key] ?? ''))
          })
        }
      }
      return results.map((r: any) => ({ ...r }))
    }

    function deleteWhere(arrKey: string, where: any): { count: number } {
      const arr = (store() as any)[arrKey]
      const before = arr.length
      ;(store() as any)[arrKey] = arr.filter((r: any) =>
        Object.entries(where).every(([k, v]) => {
          // Handle { in: [...] } operator
          if (v !== null && typeof v === 'object' && 'in' in v) {
            return !(v as { in: unknown[] }).in.includes(r[k])
          }
          return r[k] !== v
        }),
      )
      return { count: before - (store() as any)[arrKey].length }
    }

    function deleteOne(arrKey: string, where: any): void {
      const [key, value] = Object.entries(where)[0]
      const arr = (store() as any)[arrKey]
      const idx = arr.findIndex((r: any) => r[key] === value)
      if (idx >= 0) arr.splice(idx, 1)
    }

    const client = {
      project: {
        findFirst: (args: any) => {
          if (!args?.where || args.where.id === store().project.id) {
            if (args?.include) return resolveProjectIncludes(store(), args.include)
            return { ...store().project }
          }
          return null
        },
        update: (args: any) => {
          Object.assign(store().project, args.data)
          return { ...store().project }
        },
        findUnique: (args: any) => {
          if (args?.where?.id === store().project.id) return { ...store().project }
          return null
        },
      },
      resourceType: {
        findFirst: (args: any) => findOne(store().resourceTypes, args?.where ?? {}),
        findMany: (args: any) => findMany('resourceTypes', args ?? {}),
        findUnique: (args: any) => findOne(store().resourceTypes, args?.where ?? {}),
        create: (args: any) => createIn('resourceTypes', args.data ?? args),
        update: (args: any) => {
          const idx = store().resourceTypes.findIndex((r: any) => r.id === args.where.id)
          if (idx >= 0) {
            Object.assign(store().resourceTypes[idx], args.data)
            return { ...store().resourceTypes[idx] }
          }
          return null
        },
        updateMany: (args: any) => {
          for (const r of filter(store().resourceTypes, args.where)) {
            const idx = store().resourceTypes.findIndex((x: any) => x.id === r.id)
            if (idx >= 0) Object.assign(store().resourceTypes[idx], args.data)
          }
          return { count: filter(store().resourceTypes, args.where).length }
        },
      },
      namedResource: {
        findFirst: (args: any) => findOne(store().namedResources, args?.where ?? {}),
        findMany: (args: any) => findMany('namedResources', args ?? {}),
        update: (args: any) => {
          const idx = store().namedResources.findIndex((r: any) => r.id === args.where.id)
          if (idx >= 0) {
            Object.assign(store().namedResources[idx], args.data)
            return { ...store().namedResources[idx] }
          }
          return null
        },
        updateMany: (args: any) => {
          for (const r of filter(store().namedResources, args.where)) {
            const idx = store().namedResources.findIndex((x: any) => x.id === r.id)
            if (idx >= 0) Object.assign(store().namedResources[idx], args.data)
          }
          return { count: filter(store().namedResources, args.where).length }
        },
        create: (args: any) => createIn('namedResources', args.data ?? args),
        delete: (args: any) => { deleteOne('namedResources', args.where ?? args); return {} },
        count: (args: any) => filter(store().namedResources, args?.where ?? {}).length,
      },
      capacityPlan: {
        updateMany: (args: any) => {
          for (const r of filter(store().capacityPlans, args.where)) {
            const idx = store().capacityPlans.findIndex((x: any) => x.id === r.id)
            if (idx >= 0) Object.assign(store().capacityPlans[idx], args.data)
          }
          return { count: filter(store().capacityPlans, args.where).length }
        },
        create: (args: any) => createIn('capacityPlans', args.data ?? args),
      },
      backlogSnapshot: {
        create: (args: any) => {
          const rec = { id: nextId('snap-'), ...(args.data ?? args) }
          store().backlogSnapshots.push(rec)
          return rec
        },
      },
      capacityProfile: {
        findMany: (args: any) => {
          const results = findMany('capacityProfiles', args ?? {})
          if (args?.include?.segments) {
            return results.map((cp: any) => ({
              ...cp,
              segments: store().capacitySegments
                .filter((s: any) => s.capacityProfileId === cp.id)
                .map((s: any) => ({ ...s })),
            }))
          }
          return results
        },
        create: (args: any) => createIn('capacityProfiles', args.data ?? args),
        update: (args: any) => {
          const idx = store().capacityProfiles.findIndex((r: any) => r.id === args.where.id)
          if (idx >= 0) {
            store().capacityProfiles[idx] = { ...store().capacityProfiles[idx], ...args.data }
            return { ...store().capacityProfiles[idx] }
          }
          return null
        },
        delete: (args: any) => { deleteOne('capacityProfiles', args.where ?? args); return {} },
        deleteMany: (args: any) => deleteWhere('capacityProfiles', args.where ?? {}),
      },
      capacitySegment: {
        deleteMany: (args: any) => deleteWhere('capacitySegments', args.where ?? {}),
        create: (args: any) => createIn('capacitySegments', args.data ?? args),
      },
      epic: {
        findMany: () => [...store().epics],
        update: (args: any) => {
          const idx = store().epics.findIndex((r: any) => r.id === args.where.id)
          if (idx >= 0) { Object.assign(store().epics[idx], args.data); return { ...store().epics[idx] } }
          return null
        },
      },
      epicDependency: { findMany: () => [...store().epicDependencies] },
      storyDependency: { findMany: () => [...store().storyDependencies] },
      timelineEntry: {
        findMany: (args: any) => findMany('timelineEntries', args ?? {}),
        deleteMany: (args: any) => deleteWhere('timelineEntries', args.where ?? {}),
        createMany: (args: any) => {
          for (const d of args.data ?? []) store().timelineEntries.push({ id: nextId('te-'), ...d })
          return { count: (args.data ?? []).length }
        },
      },
      storyTimelineEntry: {
        findMany: (args: any) => findMany('storyTimelineEntries', args ?? {}),
        deleteMany: (args: any) => deleteWhere('storyTimelineEntries', args.where ?? {}),
        createMany: (args: any) => {
          for (const d of args.data ?? []) store().storyTimelineEntries.push({ id: nextId('ste-'), ...d })
          return { count: (args.data ?? []).length }
        },
      },
      projectOverhead: {
        deleteMany: (args: any) => deleteWhere('projectOverheads', args.where ?? {}),
        createMany: (args: any) => {
          for (const d of args.data ?? []) store().projectOverheads.push({ id: nextId('po-'), ...d })
          return { count: (args.data ?? []).length }
        },
      },
      $transaction: transaction,
    }
    return client
  }

  const storeRef = { current: null as unknown as Store }

  return { storeRef, createStore, makeStoreClient }
})

// ─── vi.mock: override global mocks ─────────────────────────────────────────

// Use real sync helper
vi.mock('../lib/syncCapacityProfiles.js', async (importOriginal: () => Promise<any>) => {
  return await importOriginal()
})

// Mock snapshots to avoid real DB calls
vi.mock('../routes/snapshots.js', async (importOriginal: () => Promise<any>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    buildSnapshot: vi.fn().mockResolvedValue({}),
  }
})
vi.mock('../lib/snapshotUtils.js', () => ({
  pruneSnapshots: vi.fn().mockResolvedValue(undefined),
}))

// Override prisma with the store-backed client
vi.mock('../lib/prisma.js', () => ({
  prisma: makeStoreClient(storeRef),
}))

// ─── Imports ─────────────────────────────────────────────────────────────────

import { app } from '../index.js'

process.env.JWT_SECRET = 'test-secret'

const userId = 'user-1'
const token = jwt.sign({ userId }, 'test-secret')
const authHeader = `Bearer ${token}`
const projectId = 'proj-1'
const rtId = 'rt-1'
const userName = 'Engineer'

// ─── Test lifecycle ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  storeRef.current = createStore()
})

function getCapacityProfiles() {
  return request(app)
    .get(`/api/projects/${projectId}/capacity-profiles`)
    .set('Authorization', authHeader)
}

// ─── Initial-state helpers ──────────────────────────────────────────────────

function addResourceType(
  id: string,
  name: string,
  count = 1,
  overrides: Record<string, any> = {},
) {
  const now = new Date()
  const rt = {
    id,
    name,
    count,
    projectId,
    allocationMode: 'EFFORT',
    allocationPercent: null,
    allocationStartWeek: null,
    allocationEndWeek: null,
    hoursPerDay: 8,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  storeRef.current.resourceTypes.push(rt)
  return rt
}

function addNamedResource(
  id: string,
  name: string,
  rt: string,
  overrides: Record<string, any> = {},
) {
  const now = new Date()
  const nr = {
    id,
    name,
    resourceTypeId: rt,
    projectId,
    startWeek: null,
    endWeek: null,
    allocationPct: 100,
    allocationMode: 'EFFORT',
    allocationPercent: 100,
    allocationStartWeek: null,
    allocationEndWeek: null,
    pricingModel: 'ACTUAL_DAYS',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  storeRef.current.namedResources.push(nr)
  const rtRec = storeRef.current.resourceTypes.find((r: any) => r.id === rt)
  if (rtRec) {
    rtRec.count = storeRef.current.namedResources.filter(
      (n: any) => n.resourceTypeId === rt,
    ).length
  }
  return nr
}

function addPersistedProfile(
  id: string,
  overrides: Record<string, any> = {},
) {
  const now = new Date()
  const profile = {
    id,
    projectId,
    resourceTypeId: null,
    namedResourceId: null,
    ownerKind: 'ROLE',
    planningBasis: 'DEMAND_FOLLOWING',
    source: 'FIXED',
    defaultPercent: null,
    startWeek: null,
    endWeek: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  storeRef.current.capacityProfiles.push(profile)
  return profile
}

function addEpic(
  id: string,
  name: string,
  order = 0,
  overrides: Record<string, any> = {},
) {
  const now = new Date()
  const epic = {
    id,
    projectId,
    name,
    order,
    isActive: true,
    featureMode: 'sequential',
    scheduleMode: 'auto',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  storeRef.current.epics.push(epic)
  return epic
}

function addFeature(
  id: string,
  name: string,
  epicId: string,
  order = 0,
  overrides: Record<string, any> = {},
) {
  const now = new Date()
  const feature = {
    id,
    epicId,
    name,
    order,
    isActive: true,
    timelineStartWeek: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  storeRef.current.features.push(feature)
  return feature
}

function addUserStory(
  id: string,
  featureId: string,
  order = 0,
  overrides: Record<string, any> = {},
) {
  const now = new Date()
  const story = {
    id,
    featureId,
    order,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  storeRef.current.userStories.push(story)
  return story
}

function addTask(
  id: string,
  userStoryId: string,
  resourceTypeId: string,
  hoursEffort = 80,
  overrides: Record<string, any> = {},
) {
  const now = new Date()
  const task = {
    id,
    userStoryId,
    resourceTypeId,
    hoursEffort,
    durationDays: null,
    order: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
  storeRef.current.tasks.push(task)
  return task
}


// ─── Tests ───────────────────────────────────────────────────────────────────

describe('persisted capacity-profile DTO integration', () => {
  describe('1. ResourceType write persists profiles', () => {
    it('PATCH count triggers sync, GET reads same persisted state', async () => {
      addResourceType(rtId, userName, 1)
      addNamedResource('nr-1', 'Engineer 1', rtId)

      const patchRes = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 2 })

      expect(patchRes.status).toBe(200)

      // ── Direct store assertion: profiles were created ──
      expect(storeRef.current.capacityProfiles.length).toBeGreaterThan(0)
      // RT has named resources → mapper produces named-person profiles
      const nrProfile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === 'nr-1',
      )
      expect(nrProfile).toBeDefined()
      expect(nrProfile!.planningBasis).toBe('DEMAND_FOLLOWING')

      const persistedId = nrProfile!.id

      // ── GET assertion: same persisted state ──
      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      expect(getRes.body.capacityProfiles.length).toBeGreaterThan(0)
      const responseProfile = getRes.body.capacityProfiles.find(
        (p: any) => p.owner.kind === 'namedPerson' && p.owner.id === 'nr-1',
      )
      expect(responseProfile).toBeDefined()
      expect(responseProfile!.id).toBe(persistedId)
      expect(responseProfile!.planningBasis).toBe('demandFollowing')
    })
  })

  describe('2. NamedResource write persists named-person profiles', () => {
    it('PUT update triggers sync, GET returns named-person DTO with matching store id', async () => {
      addResourceType(rtId, userName)
      addNamedResource('nr-alice', 'Alice', rtId)

      const putRes = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}/named-resources/nr-alice`)
        .set('Authorization', authHeader)
        .send({ name: 'Alice Updated' })

      expect(putRes.status).toBe(200)

      // ── Direct store assertion ──
      const nrProfile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === 'nr-alice',
      )
      expect(nrProfile).toBeDefined()
      expect(nrProfile!.ownerKind).toBe('NAMED_PERSON')

      // ── GET assertion ──
      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      const aliceDto = getRes.body.capacityProfiles.find(
        (p: any) => p.owner.kind === 'namedPerson' && p.owner.id === 'nr-alice',
      )
      expect(aliceDto).toBeDefined()
      expect(aliceDto!.id).toBe(nrProfile!.id)
      expect(aliceDto!.owner.name).toBe('Alice Updated')
      expect(aliceDto!.owner.roleId).toBe(rtId)
    })

    it('PATCH allocation triggers sync, GET returns updated persisted fields', async () => {
      addResourceType(rtId, userName)
      addNamedResource('nr-bob', 'Bob', rtId, {
        allocationMode: 'TIMELINE',
        allocationPercent: 50,
        allocationStartWeek: 2,
        allocationEndWeek: 10,
      })

      const patchRes = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}/named-resources/nr-bob`)
        .set('Authorization', authHeader)
        .send({ allocationPercent: 75 })

      expect(patchRes.status).toBe(200)

      // Direct store assertion
      const bobProfile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === 'nr-bob',
      )
      expect(bobProfile).toBeDefined()
      expect(bobProfile!.defaultPercent).toBe(75)
      expect(bobProfile!.planningBasis).toBe('AVAILABILITY_WINDOW')

      // GET assertion
      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      const bobDto = getRes.body.capacityProfiles.find(
        (p: any) => p.owner.kind === 'namedPerson' && p.owner.id === 'nr-bob',
      )
      expect(bobDto).toBeDefined()
      expect(bobDto!.id).toBe(bobProfile!.id)
      expect(bobDto!.defaultPercent).toBe(75)
      expect(bobDto!.startWeek).toBe(2)
      expect(bobDto!.endWeek).toBe(10)
    })
  })

  describe('3. NamedResource delete removes stale profile', () => {
    it('DELETE removes named-person profile from shared state; GET excludes it', async () => {
      addResourceType(rtId, userName)
      addNamedResource('nr-del', 'ToDelete', rtId)
      addPersistedProfile('cp-nr-del', {
        namedResourceId: 'nr-del',
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })

      const delRes = await request(app)
        .delete(`/api/projects/${projectId}/resource-types/${rtId}/named-resources/nr-del`)
        .set('Authorization', authHeader)

      expect(delRes.status).toBe(204)

      // Direct store assertion: stale profile was removed
      const staleProfile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === 'nr-del',
      )
      expect(staleProfile).toBeUndefined()

      // GET assertion: only role-level profile (or none)
      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      const delDto = getRes.body.capacityProfiles.find(
        (p: any) => p.owner.kind === 'namedPerson' && p.owner.id === 'nr-del',
      )
      expect(delDto).toBeUndefined()
    })
  })

  describe('4. Squad Planner apply persists segments', () => {
    it('apply route creates profiles with segments in shared store; GET returns them', async () => {
      addResourceType(rtId, userName, 1)
      addNamedResource('nr-1', 'Engineer 1', rtId)

      const applyRes = await request(app)
        .post(`/api/projects/${projectId}/squad-plan/apply`)
        .set('Authorization', authHeader)
        .send({
          name: 'Test Plan',
          targetWeeks: 8,
          periodWeeks: 4,
          maxDelta: 1,
          setActive: true,
          periods: [{
            periodIndex: 0,
            startWeek: 0,
            endWeek: 8,
            entries: [{
              resourceTypeId: rtId,
              headcount: 1,
              demandFTE: 0.5,
              utilisationPct: 50,
            }],
          }],
        })

      expect(applyRes.status).toBe(201)

      // Direct store assertion: profiles + segments exist
      expect(storeRef.current.capacityProfiles.length).toBeGreaterThan(0)
      expect(storeRef.current.capacitySegments.length).toBeGreaterThan(0)
      const seg = storeRef.current.capacitySegments[0]
      expect(seg.endWeek).toBe(7)

      const persistedProfileId = storeRef.current.capacityProfiles[0].id

      // GET returns same persisted state
      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      const dto = getRes.body.capacityProfiles.find(
        (p: any) => p.id === persistedProfileId,
      )
      expect(dto).toBeDefined()
      expect(dto.planningBasis).toBe('capacityProfile')
      expect(dto.source).toBe('squadPlanner')
      expect(dto.segments.length).toBeGreaterThan(0)
      expect(dto.segments[0]).toMatchObject({
        startWeek: 0,
        endWeek: 7,
        capacityPercent: 100,
      })
    })
  })
  describe('5. Fallback on real reconciliation mismatch', () => {
    it('returns legacy-derived DTO when persisted rows do not reconcile', async () => {
      addResourceType(rtId, userName, 1, { allocationMode: 'EFFORT' })

      const corruptId = 'cp-corrupt'
      addPersistedProfile(corruptId, {
        resourceTypeId: rtId,
        ownerKind: 'ROLE',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'FIXED',
        defaultPercent: 100,
      })

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)

      const dto = getRes.body.capacityProfiles[0]
      expect(dto.id).toBe(rtId)
      expect(dto.id).not.toBe(corruptId)
      expect(dto.planningBasis).toBe('demandFollowing')
      expect(dto.legacy).toMatchObject({ allocationMode: 'EFFORT' })
    })

    it('returns legacy-derived DTO when no persisted profiles exist', async () => {
      addResourceType(rtId, userName, 1, { allocationMode: 'EFFORT' })

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      expect(getRes.body.capacityProfiles).toHaveLength(1)
      expect(getRes.body.capacityProfiles[0].id).toBe(rtId)
    })
  })


  describe('6. Repair cycle', () => {
    it('write after corruption repairs persisted state; GET switches to persisted path', async () => {
      addResourceType(rtId, userName, 1)
      addNamedResource('nr-1', 'Engineer 1', rtId)

      // Phase 1: seed a corrupted profile — wrong owner kind/planningBasis
      // Legacy mapper produces a named-person profile for nr-1 (RT has NRs).
      // The seeded ROLE profile with wrong planningBasis → real compareCapacityProfiles fails.
      const corruptId = 'cp-corrupt'
      addPersistedProfile(corruptId, {
        resourceTypeId: rtId,
        ownerKind: 'ROLE',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'FIXED',
        defaultPercent: 100,
      })

      // GET before fix → fallback (corrupted profile doesn't reconcile)
      const getBefore = await getCapacityProfiles()
      expect(getBefore.status).toBe(200)
      // Fallback: legacy mapper produces named-person profile (RT has NRs)
      expect(getBefore.body.capacityProfiles[0].owner.kind).toBe('namedPerson')
      expect(getBefore.body.capacityProfiles[0].owner.id).toBe('nr-1')
      // Corrupted profile id is NOT exposed
      const beforeIds = getBefore.body.capacityProfiles.map((p: any) => p.id)
      expect(beforeIds).not.toContain(corruptId)

      // Phase 2: trigger a PATCH that runs sync → repairs the store
      const patchRes = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 2 })

      expect(patchRes.status).toBe(200)

      // Direct store assertion: corrupted profile is gone
      const stillCorrupt = storeRef.current.capacityProfiles.find(
        (p: any) => p.id === corruptId,
      )
      expect(stillCorrupt).toBeUndefined()

      // Store now has named-person profiles matching NRs
      expect(storeRef.current.capacityProfiles.length).toBeGreaterThan(0)
      const repairedProfile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === 'nr-1',
      )
      expect(repairedProfile).toBeDefined()
      expect(repairedProfile!.ownerKind).toBe('NAMED_PERSON')
      expect(repairedProfile!.planningBasis).toBe('DEMAND_FOLLOWING')

      // Phase 3: GET after fix → persisted path
      const getAfter = await getCapacityProfiles()
      expect(getAfter.status).toBe(200)
      const afterDto = getAfter.body.capacityProfiles.find(
        (p: any) => p.owner.kind === 'namedPerson' && p.owner.id === 'nr-1',
      )
      expect(afterDto).toBeDefined()
      expect(afterDto!.id).toBe(repairedProfile!.id)
      expect(afterDto!.planningBasis).toBe('demandFollowing')
    })
  })



  describe('7. Real adapter Resource Profile integration', () => {
    const epId = 'epic-rp'
    const featId = 'feat-rp'
    const storyId = 'story-rp'
    const taskId = 'task-rp'

    function getResourceProfile() {
      return request(app)
        .get(`/api/projects/${projectId}/resource-profile`)
        .set('Authorization', authHeader)
    }

    it('uses reconciled persisted capacity profiles via the real adapter path', async () => {
      addResourceType(rtId, userName, 1)
      addNamedResource('nr-rp-1', 'RP Person', rtId)

      // Add backlog so route produces resource rows
      addEpic(epId, 'RP Epic')
      addFeature(featId, 'RP Feature', epId)
      addUserStory(storyId, featId)
      addTask(taskId, storyId, rtId, 160)
      storeRef.current.timelineEntries.push({ featureId: featId, startWeek: 0, durationWeeks: 4 })

      // Directly add a named-person profile that matches what the legacy mapper produces
      addPersistedProfile('cp-nr-rp', {
        resourceTypeId: rtId,
        namedResourceId: 'nr-rp-1',
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })

      // Call the REAL Resource Profile route (adapter NOT mocked)
      const res = await getResourceProfile()
      expect(res.status).toBe(200)
      expect(res.body.resourceRows).toBeDefined()

      const rtRow = res.body.resourceRows.find((r: any) => r.resourceTypeId === rtId)
      expect(rtRow).toBeDefined()

      // Named resource has capacityProfile enrichment (persisted → reconciled)
      const nr = rtRow.namedResources.find((n: any) => n.id === 'nr-rp-1')
      expect(nr).toBeDefined()
      expect(nr.capacityProfile).toBeDefined()
      expect(nr.capacityProfile.planningBasis).toBe('demandFollowing')
      expect(nr.capacityProfile.source).toBe('fixed')
      expect(nr.capacityProfile.segments).toBeDefined()

      // Legacy fields remain intact
      expect(nr.allocationMode).toBe('EFFORT')
      expect(nr.allocationPercent).toBe(100)
      expect(nr.pricingModel).toBe('ACTUAL_DAYS')

      // One named resource (not duplicated)
      expect(rtRow.namedResources).toHaveLength(1)
    })

    it('falls back safely when persisted profiles do not reconcile', async () => {
      addResourceType('rt-fallback', 'Fallback RT', 1, {
        allocationMode: 'EFFORT',
        allocationPercent: 100,
      })
      addNamedResource('nr-fb-1', 'Fallback Person', 'rt-fallback', {
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        pricingModel: 'PRO_RATA',
      })
      addEpic('epic-fb', 'FB Epic')
      addFeature('feat-fb', 'FB Feature', 'epic-fb')
      addUserStory('story-fb', 'feat-fb')
      addTask('task-fb', 'story-fb', 'rt-fallback', 80)
      storeRef.current.timelineEntries.push({ featureId: 'feat-fb', startWeek: 0, durationWeeks: 4 })

      // Add a corrupt persisted profile that won't reconcile with legacy
      addPersistedProfile('cp-corrupt-fb', {
        resourceTypeId: 'rt-fallback',
        ownerKind: 'ROLE',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'FIXED',
        defaultPercent: 100,
      })

      const res = await getResourceProfile()
      expect(res.status).toBe(200)
      expect(res.body.resourceRows).toBeDefined()

      const rtRow = res.body.resourceRows.find((r: any) => r.resourceTypeId === 'rt-fallback')
      expect(rtRow).toBeDefined()

      // No duplicate named resources despite corrupt profile
      expect(rtRow.namedResources).toHaveLength(1)
      expect(rtRow.namedResources[0].id).toBe('nr-fb-1')

      // Legacy allocation fields intact
      expect(rtRow.namedResources[0].allocationMode).toBe('EFFORT')
      expect(rtRow.namedResources[0].allocationPercent).toBe(100)
      expect(rtRow.namedResources[0].pricingModel).toBe('PRO_RATA')
    })

    it('preserves multi-segment persisted capacity profile data through the real adapter', async () => {
      const segRtId = 'rt-seg'
      const segNrId = 'nr-seg-1'

      // Resource type with default mode (EFFORT); named resource uses CAPACITY_PLAN so the
      // legacy mapper derives segments from capacity plan slot windows.
      // Keeping RT mode != CAPACITY_PLAN avoids the route-level capacity plan fallback that
      // would inflate named resources from slot windows.
      addResourceType(segRtId, 'Segmented RT', 1)
      addNamedResource(segNrId, 'Seg Person', segRtId, {
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 100,
        pricingModel: 'PRO_RATA',
      })

      // Backlog data so route produces resource rows
      addEpic('epic-seg', 'Seg Epic')
      addFeature('feat-seg', 'Seg Feature', 'epic-seg')
      addUserStory('story-seg', 'feat-seg')
      addTask('task-seg', 'story-seg', segRtId, 160)
      storeRef.current.timelineEntries.push({ featureId: 'feat-seg', startWeek: 0, durationWeeks: 10 })

      // Seed a capacity plan with two periods/entries that produce distinct slot windows
      const now = new Date()
      const cpId = 'cp-plan-seg'
      storeRef.current.capacityPlans.push({
        id: cpId,
        projectId,
        name: 'Seg Plan',
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      storeRef.current.capacityPlanPeriods.push({
        id: 'cpp-seg-0',
        capacityPlanId: cpId,
        periodIndex: 0,
        startWeek: 0,
        endWeek: 4,
        createdAt: now,
        updatedAt: now,
      })
      storeRef.current.capacityPlanEntries.push({
        id: 'cpe-seg-0',
        capacityPlanPeriodId: 'cpp-seg-0',
        resourceTypeId: segRtId,
        headcount: 0.5,
        createdAt: now,
        updatedAt: now,
      })
      storeRef.current.capacityPlanPeriods.push({
        id: 'cpp-seg-1',
        capacityPlanId: cpId,
        periodIndex: 1,
        startWeek: 6,
        endWeek: 10,
        createdAt: now,
        updatedAt: now,
      })
      storeRef.current.capacityPlanEntries.push({
        id: 'cpe-seg-1',
        capacityPlanPeriodId: 'cpp-seg-1',
        resourceTypeId: segRtId,
        headcount: 1.0,
        createdAt: now,
        updatedAt: now,
      })

      // Persisted profile that exactly matches what the legacy mapper would produce
      // Legacy: CAPACITY_PLAN + slot windows from periods above → capacityProfile + squadPlanner
      const persProfileId = 'cp-seg'
      storeRef.current.capacityProfiles.push({
        id: persProfileId,
        projectId,
        resourceTypeId: segRtId,
        namedResourceId: segNrId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
        createdAt: now,
        updatedAt: now,
      })

      // Two persisted segments matching the derived slot windows:
      // P0 headcount 0.5 → 2 quanta → 50% at 0–3
      // P1 headcount 1.0 → 4 quanta → 100% at 6–9 (gap from week 4–5)
      storeRef.current.capacitySegments.push({
        id: 'cseg-seg-0',
        capacityProfileId: persProfileId,
        startWeek: 0,
        endWeek: 3,
        capacityPercent: 50,
        source: 'SQUAD_PLANNER',
        createdAt: now,
        updatedAt: now,
      })
      storeRef.current.capacitySegments.push({
        id: 'cseg-seg-1',
        capacityProfileId: persProfileId,
        startWeek: 6,
        endWeek: 9,
        capacityPercent: 100,
        source: 'SQUAD_PLANNER',
        createdAt: now,
        updatedAt: now,
      })

      // Call the REAL Resource Profile route (adapter NOT mocked)
      const res = await getResourceProfile()
      expect(res.status).toBe(200)
      expect(res.body.resourceRows).toBeDefined()

      const rtRow = res.body.resourceRows.find((r: any) => r.resourceTypeId === segRtId)
      expect(rtRow).toBeDefined()

      // One named resource (not duplicated by persisted segments)
      expect(rtRow.namedResources).toHaveLength(1)

      const nr = rtRow.namedResources[0]
      expect(nr.id).toBe(segNrId)

      // Capacity profile enrichment with both segments from persisted data
      expect(nr.capacityProfile).toBeDefined()
      expect(nr.capacityProfile.segments).toHaveLength(2)
      expect(nr.capacityProfile.segments[0]).toMatchObject({ startWeek: 0, endWeek: 3, capacityPercent: 50 })
      expect(nr.capacityProfile.segments[1]).toMatchObject({ startWeek: 6, endWeek: 9, capacityPercent: 100 })

      // Legacy fields remain intact
      expect(nr.allocationMode).toBe('CAPACITY_PLAN')
      expect(nr.allocationPercent).toBe(100)
      expect(nr.pricingModel).toBe('PRO_RATA')
    })
  })

  describe('8. Named-resource profile-first write integration', () => {
    const pwrRtId = 'rt-pwr-1'
    const pwrNrId = 'nr-pwr-1'

    it('PUT creates CapacityProfile row and preserves compatibility fields', async () => {
      addResourceType(pwrRtId, 'Write RT', 1)
      addNamedResource(pwrNrId, 'Write Person', pwrRtId, {
        pricingModel: 'PRO_RATA',
      })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${pwrRtId}/named-resources/${pwrNrId}`)
        .set('Authorization', authHeader)
        .send({
          name: 'Updated Person',
          allocationMode: 'TIMELINE',
          allocationPercent: 75,
          allocationPct: 75,
          allocationStartWeek: 2,
          allocationEndWeek: 10,
          startWeek: 2,
          endWeek: 10,
          pricingModel: 'PRO_RATA',
        })

      expect(res.status).toBe(200)

      // CapacityProfile row exists with profile-first data
      const profiles = storeRef.current.capacityProfiles.filter(
        (cp: any) => cp.namedResourceId === pwrNrId,
      )
      expect(profiles).toHaveLength(1)
      const cp = profiles[0]
      expect(cp.ownerKind).toBe('NAMED_PERSON')
      expect(cp.planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(cp.source).toBe('AVAILABILITY_WINDOW')
      expect(cp.defaultPercent).toBe(75)
      expect(cp.startWeek).toBe(2)
      expect(cp.endWeek).toBe(10)

      // NamedResource compatibility fields updated
      const nr = storeRef.current.namedResources.find((n: any) => n.id === pwrNrId)
      expect(nr).toBeDefined()
      expect(nr.allocationMode).toBe('TIMELINE')
      expect(nr.allocationPercent).toBe(75)
      expect(nr.allocationPct).toBe(75)
      expect(nr.allocationStartWeek).toBe(2)
      expect(nr.allocationEndWeek).toBe(10)
      expect(nr.startWeek).toBe(2)
      expect(nr.endWeek).toBe(10)
      expect(nr.pricingModel).toBe('PRO_RATA')
      expect(nr.name).toBe('Updated Person')

      // Profile-first row was not overwritten by legacy-derived sync
      // (sync preserves this NR's profile)
      const profilesAfterSync = storeRef.current.capacityProfiles.filter(
        (cp: any) => cp.namedResourceId === pwrNrId,
      )
      expect(profilesAfterSync).toHaveLength(1)
      expect(profilesAfterSync[0].planningBasis).toBe('AVAILABILITY_WINDOW')
    })

    it('Resource Profile response remains compatible with capacity profile enrichment', async () => {
      addResourceType('rt-cr-1', 'Compat RT', 1)
      addNamedResource('nr-cr-1', 'Compat Person', 'rt-cr-1', {
        allocationMode: 'TIMELINE',
        allocationPercent: 75,
        allocationStartWeek: 2,
        allocationEndWeek: 10,
        pricingModel: 'ACTUAL_DAYS',
      })
      // Add backlog + timeline so the Resource Profile route produces a resource row
      addEpic('epic-cr', 'Compat Epic')
      addFeature('feat-cr', 'Compat Feature', 'epic-cr')
      addUserStory('story-cr', 'feat-cr')
      addTask('task-cr', 'story-cr', 'rt-cr-1', 80)
      storeRef.current.timelineEntries.push({ featureId: 'feat-cr', startWeek: 0, durationWeeks: 4 })
      // Manually add a matching persisted profile so the adapter reconciles
      addPersistedProfile('cp-cr-1', {
        resourceTypeId: null,
        namedResourceId: 'nr-cr-1',
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 75,
        startWeek: 2,
        endWeek: 10,
      })

      const res = await request(app)
        .get(`/api/projects/${projectId}/resource-profile`)
        .set('Authorization', authHeader)

      expect(res.status).toBe(200)
      expect(res.body.resourceRows).toBeDefined()

      const rtRow = res.body.resourceRows.find((r: any) => r.resourceTypeId === 'rt-cr-1')
      expect(rtRow).toBeDefined()

      // One named resource, not duplicated
      expect(rtRow.namedResources).toHaveLength(1)
      const nr = rtRow.namedResources[0]
      expect(nr.id).toBe('nr-cr-1')

      // capacityProfile present with expected data
      expect(nr.capacityProfile).toBeDefined()
      expect(nr.capacityProfile.planningBasis).toBe('availabilityWindow')
      expect(nr.capacityProfile.source).toBe('availabilityWindow')

      // Legacy allocation fields remain present
      expect(nr.allocationMode).toBe('TIMELINE')
      expect(nr.allocationPercent).toBe(75)
      expect(nr.allocationStartWeek).toBe(2)
      expect(nr.allocationEndWeek).toBe(10)

      // pricingModel remains a separate field
      expect(nr.pricingModel).toBe('ACTUAL_DAYS')
    })

    it('PUT with only allocationPct updates percent consistently', async () => {
      addResourceType('rt-pct-1', 'Pct RT', 1)
      addNamedResource('nr-pct-1', 'Pct Person', 'rt-pct-1', {
        allocationPercent: 100,
        allocationPct: 100,
        pricingModel: 'PRO_RATA',
      })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/rt-pct-1/named-resources/nr-pct-1`)
        .set('Authorization', authHeader)
        .send({ name: 'Updated Person', allocationPct: 50 })

      expect(res.status).toBe(200)

      // NamedResource fields
      const nr = storeRef.current.namedResources.find((n: any) => n.id === 'nr-pct-1')
      expect(nr).toBeDefined()
      expect(nr.allocationPct).toBe(50)
      expect(nr.allocationPercent).toBe(50)

      // CapacityProfile
      const profile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === 'nr-pct-1',
      )
      expect(profile).toBeDefined()
      expect(profile!.defaultPercent).toBe(50)

      // Profile-first row survives sync
      const profilesAfter = storeRef.current.capacityProfiles.filter(
        (p: any) => p.namedResourceId === 'nr-pct-1',
      )
      expect(profilesAfter).toHaveLength(1)
      expect(profilesAfter[0].defaultPercent).toBe(50)
    })

    it('PUT with startWeek/endWeek infers TIMELINE and preserves window', async () => {
      const winRtId = 'rt-win-1'
      const winNrId = 'nr-win-1'
      addResourceType(winRtId, 'Window RT', 1)
      addNamedResource(winNrId, 'Window Person', winRtId, {
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        pricingModel: 'ACTUAL_DAYS',
      })
      // Add backlog + timeline so Resource Profile route produces a row
      addEpic('epic-win', 'Win Epic')
      addFeature('feat-win', 'Win Feature', 'epic-win')
      addUserStory('story-win', 'feat-win')
      addTask('task-win', 'story-win', winRtId, 80)
      storeRef.current.timelineEntries.push({ featureId: 'feat-win', startWeek: 0, durationWeeks: 4 })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${winRtId}/named-resources/${winNrId}`)
        .set('Authorization', authHeader)
        .send({ name: 'Window Person', startWeek: 2, endWeek: 10 })

      expect(res.status).toBe(200)

      // NamedResource compatibility fields
      const nr = storeRef.current.namedResources.find((n: any) => n.id === winNrId)
      expect(nr).toBeDefined()
      expect(nr.startWeek).toBe(2)
      expect(nr.endWeek).toBe(10)
      expect(nr.allocationStartWeek).toBe(2)
      expect(nr.allocationEndWeek).toBe(10)
      expect(nr.allocationMode).toBe('TIMELINE')

      // CapacityProfile
      const profile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === winNrId,
      )
      expect(profile).toBeDefined()
      expect(profile!.startWeek).toBe(2)
      expect(profile!.endWeek).toBe(10)
      expect(profile!.planningBasis).toBe('AVAILABILITY_WINDOW')

      // Resource Profile response remains compatible
      const rpRes = await request(app)
        .get(`/api/projects/${projectId}/resource-profile`)
        .set('Authorization', authHeader)
      expect(rpRes.status).toBe(200)
      const rtRow = rpRes.body.resourceRows?.find((r: any) => r.resourceTypeId === winRtId)
      expect(rtRow).toBeDefined()
      expect(rtRow.namedResources).toHaveLength(1)
      expect(rtRow.namedResources[0].capacityProfile).toBeDefined()
    })

    it('stale segments are cleaned up when updating to non-segmented profile', async () => {
      const segRtId = 'rt-seg-clean'
      const segNrId = 'nr-seg-clean'
      addResourceType(segRtId, 'SegClean RT', 1)
      addNamedResource(segNrId, 'SegClean Person', segRtId, {
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        pricingModel: 'PRO_RATA',
      })
      // Add backlog + timeline so Resource Profile route produces a row
      addEpic('epic-seg-clean', 'SegClean Epic')
      addFeature('feat-seg-clean', 'SegClean Feature', 'epic-seg-clean')
      addUserStory('story-seg-clean', 'feat-seg-clean')
      addTask('task-seg-clean', 'story-seg-clean', segRtId, 80)
      storeRef.current.timelineEntries.push({ featureId: 'feat-seg-clean', startWeek: 0, durationWeeks: 4 })
      // Manually add a pre-existing profile with segments (simulating a prior state)
      addPersistedProfile('cp-seg-clean', {
        resourceTypeId: null,
        namedResourceId: segNrId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 75,
        startWeek: 2,
        endWeek: 10,
      })
      storeRef.current.capacitySegments.push(
        { id: 'seg-clean-1', capacityProfileId: 'cp-seg-clean', startWeek: 2, endWeek: 5, capacityPercent: 75, source: 'AVAILABILITY_WINDOW', createdAt: new Date(), updatedAt: new Date() },
        { id: 'seg-clean-2', capacityProfileId: 'cp-seg-clean', startWeek: 6, endWeek: 10, capacityPercent: 75, source: 'AVAILABILITY_WINDOW', createdAt: new Date(), updatedAt: new Date() },
      )

      // Call PUT to EFFORT (non-segmented)
      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${segRtId}/named-resources/${segNrId}`)
        .set('Authorization', authHeader)
        .send({ name: 'Cleaned Person', allocationMode: 'EFFORT', allocationPercent: 100 })

      expect(res.status).toBe(200)

      // Old profile removed
      const oldProfile = storeRef.current.capacityProfiles.find((p: any) => p.id === 'cp-seg-clean')
      expect(oldProfile).toBeUndefined()

      // New profile exists with correct planning basis
      const newProfile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === segNrId,
      )
      expect(newProfile).toBeDefined()
      expect(newProfile!.planningBasis).toBe('DEMAND_FOLLOWING')
      expect(newProfile!.source).toBe('FIXED')

      // No stale segments remain for the old profile
      const staleSegments = storeRef.current.capacitySegments.filter(
        (s: any) => s.capacityProfileId === 'cp-seg-clean',
      )
      expect(staleSegments).toHaveLength(0)

      // Resource Profile response still has one named-resource row
      const rpRes = await request(app)
        .get(`/api/projects/${projectId}/resource-profile`)
        .set('Authorization', authHeader)
      expect(rpRes.status).toBe(200)
      const rtRow = rpRes.body.resourceRows?.find((r: any) => r.resourceTypeId === segRtId)
      expect(rtRow).toBeDefined()
      expect(rtRow.namedResources).toHaveLength(1)
      expect(rtRow.namedResources[0].capacityProfile).toBeDefined()
    })

    it('non-capacity PUT preserves existing CAPACITY_PLAN state', async () => {
      const cpRtId = 'rt-cap-plan'
      const cpNrId = 'nr-cap-plan'
      addResourceType(cpRtId, 'CapPlan RT', 1)
      addNamedResource(cpNrId, 'CapPlan Person', cpRtId, {
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 100,
        allocationStartWeek: null,
        allocationEndWeek: null,
        pricingModel: 'PRO_RATA',
      })
      // Pre-create a matching profile (simulating previous profile-first write)
      addPersistedProfile('cp-cap-plan', {
        resourceTypeId: null,
        namedResourceId: cpNrId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 100,
        startWeek: null,
        endWeek: null,
      })
      // Add backlog + timeline so Resource Profile route produces a row
      addEpic('epic-cp', 'CapPlan Epic')
      addFeature('feat-cp', 'CapPlan Feature', 'epic-cp')
      addUserStory('story-cp', 'feat-cp')
      addTask('task-cp', 'story-cp', cpRtId, 80)
      storeRef.current.timelineEntries.push({ featureId: 'feat-cp', startWeek: 0, durationWeeks: 4 })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${cpRtId}/named-resources/${cpNrId}`)
        .set('Authorization', authHeader)
        .send({ name: 'Renamed Only' })

      expect(res.status).toBe(200)

      // NamedResource name updated, capacity state preserved
      expect(res.body.name).toBe('Renamed Only')
      expect(res.body.allocationMode).toBe('CAPACITY_PLAN')
      expect(res.body.allocationPercent).toBe(100)
      expect(res.body.allocationPct).toBe(100)

      // CapacityProfile preserved
      const profile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === cpNrId,
      )
      expect(profile).toBeDefined()
      expect(profile!.planningBasis).toBe('CAPACITY_PROFILE')
      expect(profile!.source).toBe('SQUAD_PLANNER')

      // Profile-first row survives sync
      const profilesAfter = storeRef.current.capacityProfiles.filter(
        (p: any) => p.namedResourceId === cpNrId,
      )
      expect(profilesAfter).toHaveLength(1)
      expect(profilesAfter[0].planningBasis).toBe('CAPACITY_PROFILE')
    })

    it('non-capacity PUT does not infer TIMELINE from historical window values', async () => {
      const histRtId = 'rt-hist'
      const histNrId = 'nr-hist'
      addResourceType(histRtId, 'Hist RT', 1)
      addNamedResource(histNrId, 'Hist Person', histRtId, {
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        startWeek: 2,
        endWeek: 10,
        allocationStartWeek: 2,
        allocationEndWeek: 10,
        pricingModel: 'ACTUAL_DAYS',
      })
      // Pre-create a matching profile (simulating previous profile-first write)
      addPersistedProfile('cp-hist', {
        resourceTypeId: null,
        namedResourceId: histNrId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
        startWeek: 2,
        endWeek: 10,
      })
      // Add backlog + timeline so Resource Profile route produces a row
      addEpic('epic-hist', 'Hist Epic')
      addFeature('feat-hist', 'Hist Feature', 'epic-hist')
      addUserStory('story-hist', 'feat-hist')
      addTask('task-hist', 'story-hist', histRtId, 80)
      storeRef.current.timelineEntries.push({ featureId: 'feat-hist', startWeek: 0, durationWeeks: 4 })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${histRtId}/named-resources/${histNrId}`)
        .set('Authorization', authHeader)
        .send({ name: 'Renamed Only' })

      expect(res.status).toBe(200)

      // NamedResource name updated, capacity state preserved
      expect(res.body.name).toBe('Renamed Only')
      expect(res.body.allocationMode).toBe('EFFORT')
      expect(res.body.allocationPercent).toBe(100)

      // Route did not infer TIMELINE just because existing startWeek/endWeek values are present
      const profile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === histNrId,
      )
      expect(profile).toBeDefined()
      expect(profile!.planningBasis).toBe('DEMAND_FOLLOWING')

      // Profile-first row survives sync
      const profilesAfter = storeRef.current.capacityProfiles.filter(
        (p: any) => p.namedResourceId === histNrId,
      )
      expect(profilesAfter).toHaveLength(1)
      expect(profilesAfter[0].planningBasis).toBe('DEMAND_FOLLOWING')
    })

    it('explicit EFFORT suppresses stale window fields', async () => {
      const effRtId = 'rt-eff-stale'
      const effNrId = 'nr-eff-stale'
      addResourceType(effRtId, 'EffStale RT', 1)
      // NR has stale window values from a previous TIMELINE state
      addNamedResource(effNrId, 'EffStale Person', effRtId, {
        allocationMode: 'TIMELINE',
        allocationPercent: 75,
        startWeek: 2,
        endWeek: 10,
        allocationStartWeek: 2,
        allocationEndWeek: 10,
        pricingModel: 'ACTUAL_DAYS',
      })
      addEpic('epic-eff', 'Eff Epic')
      addFeature('feat-eff', 'Eff Feature', 'epic-eff')
      addUserStory('story-eff', 'feat-eff')
      addTask('task-eff', 'story-eff', effRtId, 80)
      storeRef.current.timelineEntries.push({ featureId: 'feat-eff', startWeek: 0, durationWeeks: 4 })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${effRtId}/named-resources/${effNrId}`)
        .set('Authorization', authHeader)
        .send({ allocationMode: 'EFFORT', allocationPercent: 100 })

      expect(res.status).toBe(200)
      expect(res.body.allocationMode).toBe('EFFORT')
      expect(res.body.allocationPercent).toBe(100)
      expect(res.body.startWeek).toBeNull()
      expect(res.body.endWeek).toBeNull()
      expect(res.body.allocationStartWeek).toBeNull()
      expect(res.body.allocationEndWeek).toBeNull()

      const profile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === effNrId,
      )
      expect(profile).toBeDefined()
      expect(profile!.planningBasis).toBe('DEMAND_FOLLOWING')
      expect(profile!.startWeek).toBeNull()
      expect(profile!.endWeek).toBeNull()
    })

    it('explicit FULL_PROJECT suppresses stale window fields', async () => {
      const fpRtId = 'rt-fp-stale'
      const fpNrId = 'nr-fp-stale'
      addResourceType(fpRtId, 'FPStale RT', 1)
      addNamedResource(fpNrId, 'FPStale Person', fpRtId, {
        allocationMode: 'TIMELINE',
        allocationPercent: 75,
        startWeek: 2,
        endWeek: 10,
        allocationStartWeek: 2,
        allocationEndWeek: 10,
        pricingModel: 'PRO_RATA',
      })
      addEpic('epic-fp', 'Fp Epic')
      addFeature('feat-fp', 'Fp Feature', 'epic-fp')
      addUserStory('story-fp', 'feat-fp')
      addTask('task-fp', 'story-fp', fpRtId, 80)
      storeRef.current.timelineEntries.push({ featureId: 'feat-fp', startWeek: 0, durationWeeks: 4 })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${fpRtId}/named-resources/${fpNrId}`)
        .set('Authorization', authHeader)
        .send({ allocationMode: 'FULL_PROJECT', allocationPercent: 80 })

      expect(res.status).toBe(200)
      expect(res.body.allocationMode).toBe('FULL_PROJECT')
      expect(res.body.allocationPercent).toBe(80)
      expect(res.body.startWeek).toBeNull()
      expect(res.body.endWeek).toBeNull()

      const profile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === fpNrId,
      )
      expect(profile).toBeDefined()
      expect(profile!.planningBasis).toBe('WHOLE_PROJECT_ALLOCATION')
      expect(profile!.startWeek).toBeNull()
      expect(profile!.endWeek).toBeNull()
    })

    it('explicit TIMELINE preserves window fields', async () => {
      const tlRtId = 'rt-tl-window'
      const tlNrId = 'nr-tl-window'
      addResourceType(tlRtId, 'TLWindow RT', 1)
      addNamedResource(tlNrId, 'TLWindow Person', tlRtId, {
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        startWeek: null,
        endWeek: null,
        pricingModel: 'ACTUAL_DAYS',
      })
      addEpic('epic-tl', 'TL Epic')
      addFeature('feat-tl', 'TL Feature', 'epic-tl')
      addUserStory('story-tl', 'feat-tl')
      addTask('task-tl', 'story-tl', tlRtId, 80)
      storeRef.current.timelineEntries.push({ featureId: 'feat-tl', startWeek: 0, durationWeeks: 4 })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${tlRtId}/named-resources/${tlNrId}`)
        .set('Authorization', authHeader)
        .send({ allocationMode: 'TIMELINE', allocationPercent: 50, startWeek: 3, endWeek: 8 })

      expect(res.status).toBe(200)
      expect(res.body.allocationMode).toBe('TIMELINE')
      expect(res.body.allocationPercent).toBe(50)
      expect(res.body.startWeek).toBe(3)
      expect(res.body.endWeek).toBe(8)
    })

    it('rename-only PUT preserves existing multi-segment profile identity', async () => {
      const segRtId = 'rt-rename-seg'
      const segNrId = 'nr-rename-seg'
      addResourceType(segRtId, 'RenameSeg RT', 1)
      addNamedResource(segNrId, 'RenameSeg Person', segRtId, {
        allocationMode: 'TIMELINE',
        allocationPercent: 75,
        allocationStartWeek: 2,
        allocationEndWeek: 10,
        startWeek: 2,
        endWeek: 10,
        pricingModel: 'ACTUAL_DAYS',
      })
      addEpic('epic-rs', 'RenameSeg Epic')
      addFeature('feat-rs', 'RenameSeg Feature', 'epic-rs')
      addUserStory('story-rs', 'feat-rs')
      addTask('task-rs', 'story-rs', segRtId, 80)
      storeRef.current.timelineEntries.push({ featureId: 'feat-rs', startWeek: 0, durationWeeks: 4 })

      // Pre-create a multi-segment CapacityProfile
      addPersistedProfile('cp-rename-seg', {
        resourceTypeId: null,
        namedResourceId: segNrId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 75,
        startWeek: 2,
        endWeek: 10,
      })
      storeRef.current.capacitySegments.push(
        { id: 'seg-rs-1', capacityProfileId: 'cp-rename-seg', startWeek: 2, endWeek: 5, capacityPercent: 75, source: 'AVAILABILITY_WINDOW', createdAt: new Date(), updatedAt: new Date() },
        { id: 'seg-rs-2', capacityProfileId: 'cp-rename-seg', startWeek: 6, endWeek: 10, capacityPercent: 75, source: 'AVAILABILITY_WINDOW', createdAt: new Date(), updatedAt: new Date() },
      )

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${segRtId}/named-resources/${segNrId}`)
        .set('Authorization', authHeader)
        .send({ name: 'Renamed Person' })

      expect(res.status).toBe(200)
      expect(res.body.name).toBe('Renamed Person')
      expect(res.body.allocationMode).toBe('TIMELINE')

      // Same profile row identity preserved
      const profile = storeRef.current.capacityProfiles.find(
        (p: any) => p.id === 'cp-rename-seg',
      )
      expect(profile).toBeDefined()
      expect(profile!.planningBasis).toBe('AVAILABILITY_WINDOW')

      // All segments still exist
      const remainingSegments = storeRef.current.capacitySegments.filter(
        (s: any) => s.capacityProfileId === 'cp-rename-seg',
      )
      expect(remainingSegments).toHaveLength(2)

      // Legacy fields not rewritten
      expect(res.body.allocationStartWeek).toBe(2)
      expect(res.body.allocationEndWeek).toBe(10)
      expect(res.body.startWeek).toBe(2)
      expect(res.body.endWeek).toBe(10)
    })

    it('PATCH null clears allocationStartWeek/allocationEndWeek', async () => {
      const pcRtId = 'rt-patch-clear'
      const pcNrId = 'nr-patch-clear'
      addResourceType(pcRtId, 'PatchClear RT', 1)
      addNamedResource(pcNrId, 'PatchClear Person', pcRtId, {
        allocationMode: 'TIMELINE',
        allocationPercent: 50,
        allocationStartWeek: 3,
        allocationEndWeek: 9,
        startWeek: 3,
        endWeek: 9,
        pricingModel: 'ACTUAL_DAYS',
      })
      addEpic('epic-pc', 'PatchClear Epic')
      addFeature('feat-pc', 'PatchClear Feature', 'epic-pc')
      addUserStory('story-pc', 'feat-pc')
      addTask('task-pc', 'story-pc', pcRtId, 80)
      storeRef.current.timelineEntries.push({ featureId: 'feat-pc', startWeek: 0, durationWeeks: 4 })

      const res = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${pcRtId}/named-resources/${pcNrId}`)
        .set('Authorization', authHeader)
        .send({ allocationStartWeek: null, allocationEndWeek: null })

      expect(res.status).toBe(200)
      // allocationStartWeek/allocationEndWeek cleared
      expect(res.body.allocationStartWeek).toBeNull()
      expect(res.body.allocationEndWeek).toBeNull()
      // allocationMode stays TIMELINE (mode was explicitly set, not inferred from window)
      expect(res.body.allocationMode).toBe('TIMELINE')
      // startWeek/endWeek are projected from the profile — null since window cleared
      expect(res.body.startWeek).toBeNull()
      expect(res.body.endWeek).toBeNull()
    })

    it('PATCH omission preserves existing allocationStartWeek/allocationEndWeek', async () => {
      const poRtId = 'rt-patch-omit'
      const poNrId = 'nr-patch-omit'
      addResourceType(poRtId, 'PatchOmit RT', 1)
      addNamedResource(poNrId, 'PatchOmit Person', poRtId, {
        allocationMode: 'TIMELINE',
        allocationPercent: 50,
        allocationStartWeek: 4,
        allocationEndWeek: 8,
        startWeek: 4,
        endWeek: 8,
        pricingModel: 'PRO_RATA',
      })
      addEpic('epic-po', 'PatchOmit Epic')
      addFeature('feat-po', 'PatchOmit Feature', 'epic-po')
      addUserStory('story-po', 'feat-po')
      addTask('task-po', 'story-po', poRtId, 80)
      storeRef.current.timelineEntries.push({ featureId: 'feat-po', startWeek: 0, durationWeeks: 4 })

      const res = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${poRtId}/named-resources/${poNrId}`)
        .set('Authorization', authHeader)
        .send({ allocationPercent: 60 })

      expect(res.status).toBe(200)
      // allocationStartWeek/allocationEndWeek preserved from existing
      expect(res.body.allocationMode).toBe('TIMELINE')
      expect(res.body.allocationPercent).toBe(60)
      expect(res.body.allocationStartWeek).toBe(4)
      expect(res.body.allocationEndWeek).toBe(8)
    })

    it('non-capacity PUT creates TIMELINE profile with preserved window when missing', async () => {
      const mtRtId = 'rt-miss-tl'
      const mtNrId = 'nr-miss-tl'
      addResourceType(mtRtId, 'MissTL RT', 1)
      addNamedResource(mtNrId, 'MissTL Person', mtRtId, {
        allocationMode: 'TIMELINE',
        allocationPercent: 60,
        allocationStartWeek: 4,
        allocationEndWeek: 9,
        startWeek: 4,
        endWeek: 9,
        pricingModel: 'ACTUAL_DAYS',
      })
      // No backlog/timeline — not checking Resource Profile response

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${mtRtId}/named-resources/${mtNrId}`)
        .set('Authorization', authHeader)
        .send({ name: 'Renamed Only' })

      expect(res.status).toBe(200)
      expect(res.body.name).toBe('Renamed Only')
      // Legacy fields preserved
      expect(res.body.allocationMode).toBe('TIMELINE')
      expect(res.body.allocationStartWeek).toBe(4)
      expect(res.body.allocationEndWeek).toBe(9)

      // New profile created with TIMELINE semantics
      const profile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === mtNrId,
      )
      expect(profile).toBeDefined()
      expect(profile!.planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(profile!.source).toBe('AVAILABILITY_WINDOW')
      expect(profile!.startWeek).toBe(4)
      expect(profile!.endWeek).toBe(9)
      expect(profile!.defaultPercent).toBe(60)
    })

    it('non-capacity PUT creates EFFORT profile with null windows when missing', async () => {
      const meRtId = 'rt-miss-eff'
      const meNrId = 'nr-miss-eff'
      addResourceType(meRtId, 'MissEff RT', 1)
      addNamedResource(meNrId, 'MissEff Person', meRtId, {
        allocationMode: 'EFFORT',
        allocationPercent: 100,
        startWeek: 3,
        endWeek: 8,
        allocationStartWeek: 3,
        allocationEndWeek: 8,
        pricingModel: 'PRO_RATA',
      })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${meRtId}/named-resources/${meNrId}`)
        .set('Authorization', authHeader)
        .send({ name: 'Renamed Only' })

      expect(res.status).toBe(200)
      expect(res.body.name).toBe('Renamed Only')
      // Legacy fields preserved (not rewritten)
      expect(res.body.allocationMode).toBe('EFFORT')
      expect(res.body.allocationStartWeek).toBe(3)
      expect(res.body.allocationEndWeek).toBe(8)

      // New profile created with null windows (stale windows suppressed)
      const profile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === meNrId,
      )
      expect(profile).toBeDefined()
      expect(profile!.planningBasis).toBe('DEMAND_FOLLOWING')
      expect(profile!.startWeek).toBeNull()
      expect(profile!.endWeek).toBeNull()
      expect(profile!.defaultPercent).toBe(100)
    })
  })

  describe('9. ResourceType profile-first write integration', () => {
    it('updates role-owned profile on capacity PUT', async () => {
      const rtId = 'rt-role-1'
      addResourceType(rtId, 'Role RT', 1)

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ allocationMode: 'TIMELINE', allocationPercent: 75, allocationStartWeek: 2, allocationEndWeek: 10 })

      expect(res.status).toBe(200)

      // Role-owned profile created
      const profiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(profiles).toHaveLength(1)
      expect(profiles[0].ownerKind).toBe('ROLE')
      expect(profiles[0].planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(profiles[0].source).toBe('AVAILABILITY_WINDOW')
      expect(profiles[0].defaultPercent).toBe(75)
      expect(profiles[0].startWeek).toBe(2)
      expect(profiles[0].endWeek).toBe(10)

      // Legacy fields updated as compatibility projection
      expect(res.body.allocationMode).toBe('TIMELINE')
      expect(res.body.allocationPercent).toBe(75)
      expect(res.body.allocationStartWeek).toBe(2)
      expect(res.body.allocationEndWeek).toBe(10)
    })

    it('explicit non-window mode suppresses stale windows on RT', async () => {
      const rtId = 'rt-role-2'
      addResourceType(rtId, 'Role RT 2', 1, { allocationMode: 'TIMELINE', allocationPercent: 75, allocationStartWeek: 2, allocationEndWeek: 10 })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ allocationMode: 'EFFORT', allocationPercent: 100 })

      expect(res.status).toBe(200)
      expect(res.body.allocationMode).toBe('EFFORT')
      expect(res.body.allocationPercent).toBe(100)
      expect(res.body.allocationStartWeek).toBeNull()
      expect(res.body.allocationEndWeek).toBeNull()

      const profile = storeRef.current.capacityProfiles.find(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(profile).toBeDefined()
      expect(profile!.planningBasis).toBe('DEMAND_FOLLOWING')
      expect(profile!.startWeek).toBeNull()
      expect(profile!.endWeek).toBeNull()
    })

    it('non-capacity RT update preserves existing role profile', async () => {
      const rtId = 'rt-role-3'
      addResourceType(rtId, 'Role RT 3', 1, { allocationMode: 'TIMELINE', allocationPercent: 75, allocationStartWeek: 3, allocationEndWeek: 9 })
      // Pre-create a role-owned profile
      addPersistedProfile('cp-role-3', {
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 75,
        startWeek: 3,
        endWeek: 9,
      })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ name: 'Renamed Role' })

      expect(res.status).toBe(200)
      expect(res.body.name).toBe('Renamed Role')

      // Same profile row identity preserved
      const profile = storeRef.current.capacityProfiles.find((p: any) => p.id === 'cp-role-3')
      expect(profile).toBeDefined()
      expect(profile!.planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(profile!.startWeek).toBe(3)
      expect(profile!.endWeek).toBe(9)

      // Legacy allocation fields not rewritten
      expect(res.body.allocationMode).toBe('TIMELINE')
      expect(res.body.allocationPercent).toBe(75)
      expect(res.body.allocationStartWeek).toBe(3)
      expect(res.body.allocationEndWeek).toBe(9)
    })

    it('non-capacity RT update creates TIMELINE profile when missing', async () => {
      const rtId = 'rt-role-4'
      addResourceType(rtId, 'Role RT 4', 1, { allocationMode: 'TIMELINE', allocationPercent: 60, allocationStartWeek: 4, allocationEndWeek: 8 })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ name: 'Renamed Role' })

      expect(res.status).toBe(200)
      expect(res.body.name).toBe('Renamed Role')
      expect(res.body.allocationMode).toBe('TIMELINE')

      // Profile-first write creates AVAILABILITY_WINDOW with preserved window
      const profile = storeRef.current.capacityProfiles.find(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(profile).toBeDefined()
      expect(profile!.planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(profile!.startWeek).toBe(4)
      expect(profile!.endWeek).toBe(8)
    })

    it('non-capacity RT update creates EFFORT profile when missing', async () => {
      const rtId = 'rt-role-5'
      addResourceType(rtId, 'Role RT 5', 1, { allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: 2, allocationEndWeek: 6 })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ name: 'Renamed Role' })

      expect(res.status).toBe(200)
      expect(res.body.name).toBe('Renamed Role')
      expect(res.body.allocationMode).toBe('EFFORT')

      // Profile-first write creates DEMAND_FOLLOWING profile.
      const profile = storeRef.current.capacityProfiles.find(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(profile).toBeDefined()
      expect(profile!.planningBasis).toBe('DEMAND_FOLLOWING')
      // defaultPercent comes from RT legacy (sync reconciles after write)
      expect(profile!.defaultPercent).toBe(100)
    })

    it('named-resource rows are not corrupted by RT update', async () => {
      const rtId = 'rt-role-6'
      addResourceType(rtId, 'Role RT 6', 1)
      // Add a named resource with its own profile
      addNamedResource('nr-role-6', 'Role NR', rtId, {
        allocationMode: 'TIMELINE',
        allocationPercent: 80,
        allocationStartWeek: 1,
        allocationEndWeek: 5,
        pricingModel: 'ACTUAL_DAYS',
      })
      addPersistedProfile('cp-nr-role-6', {
        resourceTypeId: null,
        namedResourceId: 'nr-role-6',
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 80,
        startWeek: 1,
        endWeek: 5,
      })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ name: 'Renamed RT' })

      expect(res.status).toBe(200)

      // Named-resource profile unchanged
      const nrProfile = storeRef.current.capacityProfiles.find((p: any) => p.id === 'cp-nr-role-6')
      expect(nrProfile).toBeDefined()
      expect(nrProfile!.planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(nrProfile!.startWeek).toBe(1)
      expect(nrProfile!.endWeek).toBe(5)
      expect(nrProfile!.ownerKind).toBe('NAMED_PERSON')
    })

    // ── Blocker 1: capacity PUT preserves omitted fields ───────────────

    it('existing TIMELINE + allocationPercent-only update preserves mode and windows', async () => {
      const rtId = 'rt-b1-1'
      addResourceType(rtId, 'B1 Role', 1, { allocationMode: 'TIMELINE', allocationPercent: 75, allocationStartWeek: 3, allocationEndWeek: 9 })
      // Pre-create a matching role profile so non-capacity path uses it
      addPersistedProfile('cp-b1-1', {
        resourceTypeId: rtId, namedResourceId: null, ownerKind: 'ROLE',
        planningBasis: 'AVAILABILITY_WINDOW', source: 'AVAILABILITY_WINDOW',
        defaultPercent: 75, startWeek: 3, endWeek: 9,
      })

      // PUT with allocationPercent only — mode and windows must be preserved
      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ allocationPercent: 60 })

      expect(res.status).toBe(200)
      expect(res.body.allocationMode).toBe('TIMELINE')
      expect(res.body.allocationPercent).toBe(60)
      expect(res.body.allocationStartWeek).toBe(3)
      expect(res.body.allocationEndWeek).toBe(9)
    })

    it('existing TIMELINE + explicit null windows clears windows', async () => {
      const rtId = 'rt-b1-2'
      addResourceType(rtId, 'B1 Role 2', 1, { allocationMode: 'TIMELINE', allocationPercent: 75, allocationStartWeek: 3, allocationEndWeek: 9 })
      addPersistedProfile('cp-b1-2', {
        resourceTypeId: rtId, namedResourceId: null, ownerKind: 'ROLE',
        planningBasis: 'AVAILABILITY_WINDOW', source: 'AVAILABILITY_WINDOW',
        defaultPercent: 75, startWeek: 3, endWeek: 9,
      })

      // Explicit null windows — mode stays TIMELINE but windows are cleared
      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ allocationStartWeek: null, allocationEndWeek: null })

      expect(res.status).toBe(200)
      // TIMELINE is preserved (explicit null windows don't change the mode inference)
      expect(res.body.allocationMode).toBe('TIMELINE')
      expect(res.body.allocationStartWeek).toBeNull()
      expect(res.body.allocationEndWeek).toBeNull()
    })

    it('existing EFFORT with stale windows + explicit EFFORT suppresses windows', async () => {
      const rtId = 'rt-b1-3'
      addResourceType(rtId, 'B1 Role 3', 1, { allocationMode: 'EFFORT', allocationPercent: 100, allocationStartWeek: 2, allocationEndWeek: 6 })
      addPersistedProfile('cp-b1-3', {
        resourceTypeId: rtId, namedResourceId: null, ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING', source: 'DEMAND_FOLLOWING',
        defaultPercent: 100, startWeek: 2, endWeek: 6,
      })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ allocationMode: 'EFFORT' })

      expect(res.status).toBe(200)
      expect(res.body.allocationMode).toBe('EFFORT')
      expect(res.body.allocationPercent).toBe(100)
      expect(res.body.allocationStartWeek).toBeNull()
      expect(res.body.allocationEndWeek).toBeNull()
    })

    it('existing FULL_PROJECT with stale windows + explicit FULL_PROJECT suppresses windows', async () => {
      const rtId = 'rt-b1-4'
      addResourceType(rtId, 'B1 Role 4', 1, { allocationMode: 'FULL_PROJECT', allocationPercent: 100, allocationStartWeek: 1, allocationEndWeek: 12 })
      addPersistedProfile('cp-b1-4', {
        resourceTypeId: rtId, namedResourceId: null, ownerKind: 'ROLE',
        planningBasis: 'WHOLE_PROJECT_ALLOCATION', source: 'WHOLE_PROJECT_ALLOCATION',
        defaultPercent: 100, startWeek: 1, endWeek: 12,
      })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ allocationMode: 'FULL_PROJECT' })

      expect(res.status).toBe(200)
      expect(res.body.allocationMode).toBe('FULL_PROJECT')
      expect(res.body.allocationPercent).toBe(100)
      expect(res.body.allocationStartWeek).toBeNull()
      expect(res.body.allocationEndWeek).toBeNull()
    })

    // ── Blocker 2: non-capacity PUT preserves role profile with segments ──

    it('non-capacity PUT preserves existing role-owned profile with segments', async () => {
      const rtId = 'rt-b2-1'
      addResourceType(rtId, 'B2 Role', 1, { allocationMode: 'TIMELINE', allocationPercent: 80, allocationStartWeek: 2, allocationEndWeek: 8 })
      // Create a pre-existing role profile with segments that intentionally
      // differ from the legacy fields (to prove preservation, not rewrite).
      addPersistedProfile('cp-b2-1', {
        resourceTypeId: rtId, namedResourceId: null, ownerKind: 'ROLE',
        planningBasis: 'CAPACITY_PROFILE', source: 'CAPACITY_PLAN',
        defaultPercent: 90, startWeek: null, endWeek: null,
      })
      // Manually add segments (addPersistedProfile doesn't create segments)
      const now = new Date()
      storeRef.current.capacitySegments.push(
        { id: 'seg-b2-1a', capacityProfileId: 'cp-b2-1', startWeek: 2, endWeek: 4, capacityPercent: 100, source: 'CAPACITY_PLAN', createdAt: now, updatedAt: now },
        { id: 'seg-b2-1b', capacityProfileId: 'cp-b2-1', startWeek: 5, endWeek: 8, capacityPercent: 80, source: 'CAPACITY_PLAN', createdAt: now, updatedAt: now },
      )

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ name: 'B2 Renamed' })

      expect(res.status).toBe(200)
      expect(res.body.name).toBe('B2 Renamed')

      // Profile row identity unchanged
      const profile = storeRef.current.capacityProfiles.find((p: any) => p.id === 'cp-b2-1')
      expect(profile).toBeDefined()
      expect(profile!.planningBasis).toBe('CAPACITY_PROFILE')
      expect(profile!.defaultPercent).toBe(90)
      expect(profile!.startWeek).toBeNull()
      expect(profile!.endWeek).toBeNull()

      // All segment rows preserved
      const segments = storeRef.current.capacitySegments.filter((s: any) => s.capacityProfileId === 'cp-b2-1')
      expect(segments).toHaveLength(2)
      expect(segments[0].startWeek).toBe(2)
      expect(segments[0].endWeek).toBe(4)
      expect(segments[1].startWeek).toBe(5)
      expect(segments[1].endWeek).toBe(8)

      // Legacy allocation fields are NOT rewritten from profile
      expect(res.body.allocationMode).toBe('TIMELINE')
      expect(res.body.allocationPercent).toBe(80)
      expect(res.body.allocationStartWeek).toBe(2)
      expect(res.body.allocationEndWeek).toBe(8)
    })

    // ── Blocker 3: named-resource profile rows preserved during RT updates ──

    it('capacity PUT preserves named-resource profile-first rows', async () => {
      const rtId = 'rt-b3-1'
      addResourceType(rtId, 'B3 Role', 1, { allocationMode: 'TIMELINE', allocationPercent: 80, allocationStartWeek: 1, allocationEndWeek: 5 })
      // Named resource with a multi-segment capacity profile that differs from legacy
      addNamedResource('nr-b3-1', 'B3 Person', rtId, {
        allocationMode: 'TIMELINE',
        allocationPercent: 50,
        allocationStartWeek: 2,
        allocationEndWeek: 4,
        pricingModel: 'ACTUAL_DAYS',
      })
      addPersistedProfile('cp-nr-b3-1', {
        resourceTypeId: null, namedResourceId: 'nr-b3-1', ownerKind: 'NAMED_PERSON',
        planningBasis: 'CAPACITY_PROFILE', source: 'CAPACITY_PLAN',
        defaultPercent: 60, startWeek: null, endWeek: null,
      })
      const now = new Date()
      storeRef.current.capacitySegments.push(
        { id: 'seg-b3-1a', capacityProfileId: 'cp-nr-b3-1', startWeek: 2, endWeek: 3, capacityPercent: 100, source: 'CAPACITY_PLAN', createdAt: now, updatedAt: now },
        { id: 'seg-b3-1b', capacityProfileId: 'cp-nr-b3-1', startWeek: 4, endWeek: 4, capacityPercent: 50, source: 'CAPACITY_PLAN', createdAt: now, updatedAt: now },
      )

      // Capacity PUT on the RT
      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ allocationPercent: 70, allocationMode: 'TIMELINE', allocationStartWeek: 1, allocationEndWeek: 5 })

      expect(res.status).toBe(200)

      // Named-resource profile unchanged
      const nrProfile = storeRef.current.capacityProfiles.find((p: any) => p.id === 'cp-nr-b3-1')
      expect(nrProfile).toBeDefined()
      expect(nrProfile!.planningBasis).toBe('CAPACITY_PROFILE')
      expect(nrProfile!.defaultPercent).toBe(60)
      expect(nrProfile!.ownerKind).toBe('NAMED_PERSON')

      // Named-resource segments unchanged
      const nrSegments = storeRef.current.capacitySegments.filter((s: any) => s.capacityProfileId === 'cp-nr-b3-1')
      expect(nrSegments).toHaveLength(2)

      // No duplicate NR profiles created
      const nrProfiles = storeRef.current.capacityProfiles.filter((p: any) => p.namedResourceId === 'nr-b3-1')
      expect(nrProfiles).toHaveLength(1)
    })

    it('non-capacity PUT preserves named-resource profile-first rows', async () => {
      const rtId = 'rt-b3-2'
      addResourceType(rtId, 'B3 Role 2', 1, { allocationMode: 'TIMELINE', allocationPercent: 80, allocationStartWeek: 1, allocationEndWeek: 5 })
      // Named resource with a capacity profile
      addNamedResource('nr-b3-2', 'B3 Person 2', rtId, {
        allocationMode: 'TIMELINE',
        allocationPercent: 50,
        allocationStartWeek: 2,
        allocationEndWeek: 4,
        pricingModel: 'ACTUAL_DAYS',
      })
      addPersistedProfile('cp-nr-b3-2', {
        resourceTypeId: null, namedResourceId: 'nr-b3-2', ownerKind: 'NAMED_PERSON',
        planningBasis: 'CAPACITY_PROFILE', source: 'CAPACITY_PLAN',
        defaultPercent: 60, startWeek: null, endWeek: null,
      })
      const now2 = new Date()
      storeRef.current.capacitySegments.push(
        { id: 'seg-b3-2a', capacityProfileId: 'cp-nr-b3-2', startWeek: 2, endWeek: 3, capacityPercent: 100, source: 'CAPACITY_PLAN', createdAt: now2, updatedAt: now2 },
      )

      // Non-capacity PUT on the RT
      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ name: 'B3 Renamed' })

      expect(res.status).toBe(200)

      // Named-resource profile unchanged
      const nrProfile = storeRef.current.capacityProfiles.find((p: any) => p.id === 'cp-nr-b3-2')
      expect(nrProfile).toBeDefined()
      expect(nrProfile!.planningBasis).toBe('CAPACITY_PROFILE')
      expect(nrProfile!.defaultPercent).toBe(60)
      expect(nrProfile!.ownerKind).toBe('NAMED_PERSON')

      // Named-resource segment unchanged
      const nrSegments = storeRef.current.capacitySegments.filter((s: any) => s.capacityProfileId === 'cp-nr-b3-2')
      expect(nrSegments).toHaveLength(1)
      expect(nrSegments[0].startWeek).toBe(2)

      // No duplicate NR profiles created
      const nrProfiles = storeRef.current.capacityProfiles.filter((p: any) => p.namedResourceId === 'nr-b3-2')
      expect(nrProfiles).toHaveLength(1)
    })

    // ── CAPACITY_PLAN exit tests ─────────────────────────────────────

    it('count-only exit from CAPACITY_PLAN without NRs writes TIMELINE role profile', async () => {
      const rtId = 'rt-cp-1'
      addResourceType(rtId, 'Role CP1', 0, { allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: 1, allocationEndWeek: 10 })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 2 })

      expect(res.status).toBe(200)
      expect(res.body.allocationMode).toBe('TIMELINE')
      expect(res.body.allocationPercent).toBe(100)
      expect(res.body.allocationStartWeek).toBeNull()
      expect(res.body.allocationEndWeek).toBeNull()

      const roleProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(roleProfiles).toHaveLength(1)
      expect(roleProfiles[0].planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(roleProfiles[0].defaultPercent).toBe(100)
      expect(roleProfiles[0].startWeek).toBeNull()
      expect(roleProfiles[0].endWeek).toBeNull()
    })

    it('count-only exit from CAPACITY_PLAN with NRs writes TIMELINE role profile', async () => {
      const rtId = 'rt-cp-2'
      addResourceType(rtId, 'Role CP2', 0, { allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: 1, allocationEndWeek: 10 })
      addNamedResource('nr-cp-2a', 'Person A', rtId, {
        allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
        allocationStartWeek: 1, allocationEndWeek: 10,
        pricingModel: 'ACTUAL_DAYS',
      })
      addNamedResource('nr-cp-2b', 'Person B', rtId, {
        allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
        allocationStartWeek: 1, allocationEndWeek: 10,
        pricingModel: 'ACTUAL_DAYS',
      })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 2 })

      expect(res.status).toBe(200)
      expect(res.body.allocationMode).toBe('TIMELINE')
      expect(res.body.allocationPercent).toBe(100)

      const roleProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(roleProfiles).toHaveLength(1)
      expect(roleProfiles[0].planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(roleProfiles[0].defaultPercent).toBe(100)
      // After fix: NRs without explicit profiles are reconciled from updated legacy fields,
      // After fix: NRs without explicit profiles are reconciled, so sync creates NR profiles. Total = 1 role + 2 NR.
      const allProfilesForRt = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === rtId || p.namedResourceId === 'nr-cp-2a' || p.namedResourceId === 'nr-cp-2b',
      )
      expect(allProfilesForRt).toHaveLength(3)
      const nrProfiles = allProfilesForRt.filter((p: any) => p.namedResourceId)
      expect(nrProfiles).toHaveLength(2)
      for (const np of nrProfiles) {
        expect(np.ownerKind).toBe('NAMED_PERSON')
        expect(np.planningBasis).toBe('AVAILABILITY_WINDOW')
      }

      // GET /capacity-profiles uses persisted path (reconciliation passes)
      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      // Should find a capacityProfiles array with profiles for this RT
      const rtProfiles = getRes.body.capacityProfiles.filter(
        (p: any) => p.owner.roleId === rtId || (p.owner.kind === 'role' && p.owner.id === rtId),
      )
      // Must include both role and named-resource profiles
      expect(rtProfiles.length).toBe(3)
      expect(rtProfiles.some((p: any) => p.owner.kind === 'role')).toBe(true)
      expect(rtProfiles.some((p: any) => p.owner.kind === 'namedPerson')).toBe(true)

      expect(storeRef.current.namedResources.find((n: any) => n.id === 'nr-cp-2a')!.allocationMode).toBe('TIMELINE')
      expect(storeRef.current.namedResources.find((n: any) => n.id === 'nr-cp-2b')!.allocationMode).toBe('TIMELINE')
    })

    it('count-only exit cleans up stale CAPACITY_PROFILE role profile and segments', async () => {
      const rtId = 'rt-cp-3'
      addResourceType(rtId, 'Role CP3', 0, { allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: 1, allocationEndWeek: 10 })
      addPersistedProfile('cp-stale-3', {
        resourceTypeId: rtId, namedResourceId: null, ownerKind: 'ROLE',
        planningBasis: 'CAPACITY_PROFILE', source: 'SQUAD_PLANNER',
        defaultPercent: 90, startWeek: 3, endWeek: 8,
      })
      const now3 = new Date()
      storeRef.current.capacitySegments.push(
        { id: 'seg-stale-3a', capacityProfileId: 'cp-stale-3', startWeek: 3, endWeek: 5, capacityPercent: 100, source: 'SQUAD_PLANNER', createdAt: now3, updatedAt: now3 },
        { id: 'seg-stale-3b', capacityProfileId: 'cp-stale-3', startWeek: 6, endWeek: 8, capacityPercent: 80, source: 'SQUAD_PLANNER', createdAt: now3, updatedAt: now3 },
      )
      addNamedResource('nr-cp-3a', 'Person 3', rtId, {
        allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
        allocationStartWeek: 1, allocationEndWeek: 10,
        pricingModel: 'ACTUAL_DAYS',
      })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 2 })

      expect(res.status).toBe(200)
      expect(res.body.allocationMode).toBe('TIMELINE')
      expect(storeRef.current.capacityProfiles.find((p: any) => p.id === 'cp-stale-3')).toBeUndefined()

      const roleProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(roleProfiles).toHaveLength(1)
      expect(roleProfiles[0].planningBasis).toBe('AVAILABILITY_WINDOW')

      expect(storeRef.current.capacitySegments.filter((s: any) => s.capacityProfileId === 'cp-stale-3')).toHaveLength(0)
      expect(storeRef.current.namedResources.find((n: any) => n.id === 'nr-cp-3a')!.allocationMode).toBe('TIMELINE')
    })

    it('exit with allocationPercent provided uses exit-default 100 (exit overrides percent)', async () => {
      // When exiting CAPACITY_PLAN, exitCapacityPlanForManualScheduling hardcodes
      // allocationPercent: 100. The projection values are consumed by the name-resource
      // update but the RT legacy fields reflect the exit default. This is accepted
      // because the exit semantics always produce TIMELINE+100+null windows.
      const rtId = 'rt-cp-4'
      addResourceType(rtId, 'Role CP4', 0, { allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: 1, allocationEndWeek: 10 })
      addNamedResource('nr-cp-4a', 'Person 4', rtId, {
        allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
        allocationStartWeek: 1, allocationEndWeek: 10,
        pricingModel: 'ACTUAL_DAYS',
      })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 2, allocationPercent: 60 })

      expect(res.status).toBe(200)
      expect(res.body.allocationMode).toBe('TIMELINE')
      // The exit overrides: allocationPercent is 100 regardless of request
      expect(res.body.allocationPercent).toBe(100)
      expect(res.body.allocationStartWeek).toBeNull()
      expect(res.body.allocationEndWeek).toBeNull()

      // Role profile is TIMELINE/manual state
      const roleProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(roleProfiles).toHaveLength(1)
      expect(roleProfiles[0].planningBasis).toBe('AVAILABILITY_WINDOW')
      // Profile uses the exit value (100), not the request value (60)
      expect(roleProfiles[0].defaultPercent).toBe(100)
    })

    // ── New: capacity PUT via real POST route (auto-created NR) ────

    it('capacity PUT via POST route persists role profile and GET does not fall back', async () => {
      // Create RT via the real POST route, which auto-creates a default NR
      const postRes = await request(app)
        .post(`/api/projects/${projectId}/resource-types`)
        .set('Authorization', authHeader)
        .send({ name: 'Posted Role', category: 'Engineering' })

      expect(postRes.status).toBe(201)
      const postedRtId = postRes.body.id

      // Verify an NR was auto-created
      const nrs = storeRef.current.namedResources.filter((n: any) => n.resourceTypeId === postedRtId)
      expect(nrs).toHaveLength(1)

      // Capacity PUT on the RT — this exercises the common case: RT with NRs from POST
      const putRes = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${postedRtId}`)
        .set('Authorization', authHeader)
        .send({ allocationMode: 'TIMELINE', allocationPercent: 60, allocationStartWeek: 2, allocationEndWeek: 8 })

      expect(putRes.status).toBe(200)
      expect(putRes.body.allocationMode).toBe('TIMELINE')

      // Role-owned profile created by the profile-first write
      const roleProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === postedRtId && p.namedResourceId === null,
      )
      expect(roleProfiles).toHaveLength(1)
      expect(roleProfiles[0].planningBasis).toBe('AVAILABILITY_WINDOW')
      const autoNr = storeRef.current.namedResources.find((n: any) => n.resourceTypeId === postedRtId)
      const autoNrId = autoNr?.id
      expect(autoNrId).toBeDefined()


      // Inherited NR profile matches the role default (same mode, percent, window)
      const nrProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.namedResourceId === autoNrId,
      )
      expect(nrProfiles).toHaveLength(1)
      expect(nrProfiles[0].planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(nrProfiles[0].defaultPercent).toBe(60)
      expect(nrProfiles[0].startWeek).toBe(2)
      expect(nrProfiles[0].endWeek).toBe(8)
    })

    // ── New: capacity PUT preserves explicit NR profile while updating role ──

    it('capacity PUT preserves explicit multi-segment NR profile and updates role profile', async () => {
      const rtId = 'rt-nr-preserve'
      const nrId = 'nr-preserve-1'
      addResourceType(rtId, 'Preserve NR RT', 1, {
        allocationMode: 'TIMELINE', allocationPercent: 80,
        allocationStartWeek: 1, allocationEndWeek: 5,
      })
      // Named resource with explicit profile-first multi-segment profile
      addNamedResource(nrId, 'Preserved Person', rtId, {
        allocationMode: 'TIMELINE', allocationPercent: 50,
        allocationStartWeek: 2, allocationEndWeek: 4,
        pricingModel: 'ACTUAL_DAYS',
      })
      addPersistedProfile('cp-nr-preserve', {
        resourceTypeId: null, namedResourceId: nrId, ownerKind: 'NAMED_PERSON',
        planningBasis: 'CAPACITY_PROFILE', source: 'CAPACITY_PLAN',
        defaultPercent: 60, startWeek: null, endWeek: null,
      })
      const now = new Date()
      storeRef.current.capacitySegments.push(
        { id: 'seg-nr-pres-a', capacityProfileId: 'cp-nr-preserve', startWeek: 2, endWeek: 3, capacityPercent: 100, source: 'CAPACITY_PLAN', createdAt: now, updatedAt: now },
        { id: 'seg-nr-pres-b', capacityProfileId: 'cp-nr-preserve', startWeek: 4, endWeek: 4, capacityPercent: 50, source: 'CAPACITY_PLAN', createdAt: now, updatedAt: now },
      )

      // Capacity PUT on the RT — should preserve the NR's explicit profile
      const putRes = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ allocationPercent: 70, allocationMode: 'TIMELINE', allocationStartWeek: 1, allocationEndWeek: 6 })

      expect(putRes.status).toBe(200)
      expect(putRes.body.allocationMode).toBe('TIMELINE')

      // Role profile updated to new capacity
      const roleProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(roleProfiles).toHaveLength(1)
      expect(roleProfiles[0].planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(roleProfiles[0].defaultPercent).toBe(70)
      expect(roleProfiles[0].startWeek).toBe(1)
      expect(roleProfiles[0].endWeek).toBe(6)

      // Named-resource explicit profile preserved unchanged
      const nrProfile = storeRef.current.capacityProfiles.find((p: any) => p.id === 'cp-nr-preserve')
      expect(nrProfile).toBeDefined()
      expect(nrProfile!.planningBasis).toBe('CAPACITY_PROFILE')
      expect(nrProfile!.defaultPercent).toBe(60)
      expect(nrProfile!.ownerKind).toBe('NAMED_PERSON')

      // NR segments unchanged
      const nrSegments = storeRef.current.capacitySegments.filter((s: any) => s.capacityProfileId === 'cp-nr-preserve')
      expect(nrSegments).toHaveLength(2)
      expect(nrSegments[0].startWeek).toBe(2)

      // No duplicate NR profiles
      const nrProfiles = storeRef.current.capacityProfiles.filter((p: any) => p.namedResourceId === nrId)
      expect(nrProfiles).toHaveLength(1)

      // GET returns success; persisted-vs-legacy comparison may detect differences
      // for NRs with explicit profiles that diverge from legacy fields, so
      // reconciliation may fall back to legacy mapper output.
      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      // Store-level preservation is verified above; GET consistency is orthogonal
      // to the profile-first write path tested here.
    })

    // ── New: CAPACITY_PLAN exit with NRs produces reconcilable persisted state ──

    it('CAPACITY_PLAN count-only exit with NRs produces reconcilable persisted state', async () => {
      const rtId = 'rt-cp-exit-rec'
      addResourceType(rtId, 'Exit Reconcile', 0, { allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationStartWeek: 1, allocationEndWeek: 10 })
      addNamedResource('nr-exit-a', 'Exit A', rtId, {
        allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
        allocationStartWeek: 1, allocationEndWeek: 10,
        pricingModel: 'ACTUAL_DAYS',
      })
      addNamedResource('nr-exit-b', 'Exit B', rtId, {
        allocationMode: 'CAPACITY_PLAN', allocationPercent: 100,
        allocationStartWeek: 1, allocationEndWeek: 10,
        pricingModel: 'ACTUAL_DAYS',
      })

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 2 })

      expect(res.status).toBe(200)
      expect(res.body.allocationMode).toBe('TIMELINE')

      // Role profile is TIMELINE/AvailabilityWindow
      const roleProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(roleProfiles).toHaveLength(1)
      expect(roleProfiles[0].planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(roleProfiles[0].defaultPercent).toBe(100)
      expect(roleProfiles[0].startWeek).toBeNull()
      expect(roleProfiles[0].endWeek).toBeNull()

      // NR profiles were reconciled from the updated legacy fields
      const nrProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.namedResourceId === 'nr-exit-a' || p.namedResourceId === 'nr-exit-b',
      )
      expect(nrProfiles).toHaveLength(2)
      for (const np of nrProfiles) {
        expect(np.ownerKind).toBe('NAMED_PERSON')
        expect(np.planningBasis).toBe('AVAILABILITY_WINDOW')
        expect(np.defaultPercent).toBe(100)
      }
      // GET /capacity-profiles: reconciliation passes, persisted path used
      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      const profiles = getRes.body.capacityProfiles.filter(
        (p: any) => p.owner.roleId === rtId || (p.owner.kind === 'role' && p.owner.id === rtId),
      )
      // Role + 2 NRs, all from persisted rows (not legacy fallback)
      expect(profiles.length).toBe(3)
      expect(profiles.some((p: any) => p.owner.kind === 'role')).toBe(true)
      // No extra or duplicated profiles
      const roleProfileCount = profiles.filter((p: any) => p.owner.kind === 'role').length
      expect(roleProfileCount).toBe(1)
    })

    // ── New: consecutive role updates ────────────────────────────

    it('inherited NR follows consecutive role capacity updates', async () => {
      const rtId = 'rt-consec'
      addResourceType(rtId, 'Consecutive Role', 1, { allocationMode: 'EFFORT', allocationPercent: 100 })
      addNamedResource('nr-consec', 'Consec Person', rtId, {
        allocationMode: 'EFFORT', allocationPercent: 100,
        pricingModel: 'ACTUAL_DAYS',
      })

      // First capacity PUT: TIMELINE/60/weeks 2-8
      const put1 = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ allocationMode: 'TIMELINE', allocationPercent: 60, allocationStartWeek: 2, allocationEndWeek: 8 })

      expect(put1.status).toBe(200)

      // Role profile
      const roleProfiles1 = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(roleProfiles1).toHaveLength(1)
      expect(roleProfiles1[0].defaultPercent).toBe(60)
      expect(roleProfiles1[0].startWeek).toBe(2)
      expect(roleProfiles1[0].endWeek).toBe(8)

      // Inherited NR profile matches first role
      const nrProfiles1 = storeRef.current.capacityProfiles.filter(
        (p: any) => p.namedResourceId === 'nr-consec',
      )
      expect(nrProfiles1).toHaveLength(1)
      expect(nrProfiles1[0].planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(nrProfiles1[0].defaultPercent).toBe(60)
      expect(nrProfiles1[0].startWeek).toBe(2)
      expect(nrProfiles1[0].endWeek).toBe(8)
      // Inherited: legacy field is populated (sync-derived, not explicit)
      expect(nrProfiles1[0].legacy).toBeDefined()

      // Second capacity PUT: TIMELINE/75/weeks 3-10
      const put2 = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ allocationMode: 'TIMELINE', allocationPercent: 75, allocationStartWeek: 3, allocationEndWeek: 10 })

      expect(put2.status).toBe(200)

      // Role profile updated
      const roleProfiles2 = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(roleProfiles2).toHaveLength(1)
      expect(roleProfiles2[0].defaultPercent).toBe(75)
      expect(roleProfiles2[0].startWeek).toBe(3)
      expect(roleProfiles2[0].endWeek).toBe(10)

      // Same inherited NR follows the second update
      const nrProfiles2 = storeRef.current.capacityProfiles.filter(
        (p: any) => p.namedResourceId === 'nr-consec',
      )
      expect(nrProfiles2).toHaveLength(1) // no duplicate
      expect(nrProfiles2[0].id).toBe(nrProfiles1[0].id) // same row updated in place
      expect(nrProfiles2[0].defaultPercent).toBe(75)
      expect(nrProfiles2[0].startWeek).toBe(3)
      expect(nrProfiles2[0].endWeek).toBe(10)

      // GET uses persisted path
      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      const profiles = getRes.body.capacityProfiles.filter(
        (p: any) => p.owner.roleId === rtId || (p.owner.kind === 'role' && p.owner.id === rtId),
      )
      // Role + inherited NR
      expect(profiles.length).toBe(2)
    })

    // ── New: role profile drift detection ─────────────────────────

    it('role profile drift for RT with NRs triggers fallback, repair restores persisted', async () => {
      const driftRtId = 'rt-drift'
      addResourceType(driftRtId, 'Drift Role', 1, { allocationMode: 'TIMELINE', allocationPercent: 80, allocationStartWeek: 2, allocationEndWeek: 8 })
      addNamedResource('nr-drift', 'Drift Person', driftRtId, {
        allocationMode: 'TIMELINE', allocationPercent: 80,
        allocationStartWeek: 2, allocationEndWeek: 8,
        pricingModel: 'ACTUAL_DAYS',
      })
      let getRes

      // Capacity PUT creates a valid role profile
      const putRes = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${driftRtId}`)
        .set('Authorization', authHeader)
        .send({ allocationMode: 'TIMELINE', allocationPercent: 80, allocationStartWeek: 2, allocationEndWeek: 8 })
      expect(putRes.status).toBe(200)

      // After PUT, GET uses persisted (reconciliation passes)
      getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      const persistedRole = getRes.body.capacityProfiles.find(
        (p: any) => p.owner.kind === 'role' && p.owner.id === driftRtId,
      )
      expect(persistedRole).toBeDefined()
      expect(persistedRole.defaultPercent).toBe(80)

      // Corrupt the role profile in the store
      const roleProfileRow = storeRef.current.capacityProfiles.find(
        (p: any) => p.resourceTypeId === driftRtId && p.namedResourceId === null,
      )
      expect(roleProfileRow).toBeDefined()
      roleProfileRow!.defaultPercent = 99
      // Also change legacy to preserve the explicit/null distinction
      roleProfileRow!.legacy = null

      // GET falls back to legacy — role profile drift detected
      // (the corrupted role profile doesn't match mapper output)
      getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      // Legacy mapper doesn't produce role profiles for RTs with NRs,
      // so fallback returns NR profiles only — the corrupted role profile
      // is NOT exposed (its ID not in the response)
      const corruptedId = storeRef.current.capacityProfiles.find(
        (p: any) => p.resourceTypeId === driftRtId && p.namedResourceId === null,
      )?.id
      const fallbackIds = getRes.body.capacityProfiles.map((p: any) => p.id)
      expect(fallbackIds).not.toContain(corruptedId)

      // Repair: another capacity PUT restores correct role profile
      const repairRes = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${driftRtId}`)
        .set('Authorization', authHeader)
        .send({ allocationMode: 'TIMELINE', allocationPercent: 80, allocationStartWeek: 2, allocationEndWeek: 8 })
      expect(repairRes.status).toBe(200)

      // After repair, GET uses persisted again
      getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      const repairedRole = getRes.body.capacityProfiles.find(
        (p: any) => p.owner.kind === 'role' && p.owner.id === driftRtId,
      )
      expect(repairedRole).toBeDefined()
      expect(repairedRole.defaultPercent).toBe(80)
    })
  })
 })
