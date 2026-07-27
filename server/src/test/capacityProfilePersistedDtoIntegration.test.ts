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
        createMany: (args: any) => {
          for (const d of args.data ?? []) createIn('namedResources', d)
          return { count: (args.data ?? []).length }
        },
        delete: (args: any) => { deleteOne('namedResources', args.where ?? args); return {} },
        count: (args: any) => filter(store().namedResources, args?.where ?? {}).length,
      },
      capacityPlan: {
        findFirst: () => null,
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
        delete: async (args: any) => deleteOne('backlogSnapshots', args.where ?? args),
      },
      capacityProfile: {
        findFirst: (args: any) => findOne(store().capacityProfiles, args?.where ?? {}),
        findMany: (args: any) => {
          let results = findMany('capacityProfiles', args ?? {})

          // Auto-create a synthetic role profile when queries for a non-existent
          // ROLE profile. This keeps profile-first routes functional.
          if (results.length === 0 && args?.where?.resourceTypeId && args?.where?.namedResourceId === null) {
            const rtId = args.where.resourceTypeId
            const rt = store().resourceTypes.find((r: any) => r.id === rtId)
            if (rt) {
              ensureRoleProfiles()
              results = findMany('capacityProfiles', args ?? {})
            }
          }

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
        createMany: (args: any) => {
          for (const d of args.data ?? []) createIn('capacitySegments', d)
          return { count: (args.data ?? []).length }
        },
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

// Ensure every RT has a synthetic role profile for profile-first routes.
// Tests that set up specific profile state via addPersistedProfile override this.
// Tests testing missing-profile scenarios should add RTs without addResourceType.
function ensureRoleProfiles() {
  for (const rt of storeRef.current.resourceTypes) {
    const hasProfile = storeRef.current.capacityProfiles.some(
      (cp: any) => cp.resourceTypeId === rt.id && cp.namedResourceId === null,
    )
    if (!hasProfile) {
      const now = new Date()
      storeRef.current.capacityProfiles.push({
        id: `cp-role-auto-${rt.id}`,
        projectId: rt.projectId,
        resourceTypeId: rt.id,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: rt.allocationMode === 'CAPACITY_PLAN' ? 'CAPACITY_PROFILE' :
          rt.allocationMode === 'TIMELINE' ? 'AVAILABILITY_WINDOW' :
          rt.allocationMode === 'FULL_PROJECT' ? 'WHOLE_PROJECT_ALLOCATION' :
          'DEMAND_FOLLOWING',
        source: rt.allocationMode === 'CAPACITY_PLAN' ? 'SQUAD_PLANNER' :
          rt.allocationMode === 'TIMELINE' ? 'AVAILABILITY_WINDOW' :
          'FIXED',
        defaultPercent: rt.allocationPercent ?? 100,
        startWeek: rt.allocationMode === 'TIMELINE' ? (rt.allocationStartWeek ?? null) : null,
        endWeek: rt.allocationMode === 'TIMELINE' ? (rt.allocationEndWeek ?? null) : null,
        createdAt: now,
        updatedAt: now,
        segments: [],
      })
    }
  }
}
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
      addNamedResource('nr-1', 'Engineer 1', rtId, { allocationMode: 'CAPACITY_PLAN' })
      addPersistedProfile('cp-nr-1', {
        namedResourceId: 'nr-1',
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
      })

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

      const persistedProfileId = storeRef.current.capacityProfiles.find(
        (p: any) => p.ownerKind === 'PLANNED_RESOURCE',
      )?.id

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
  describe('5. Persisted authority and fallback', () => {
    it('returns persisted DTO as authority even when planningBasis differs from legacy', async () => {
      addResourceType(rtId, userName, 1, { allocationMode: 'EFFORT' })

      const persistedId = 'cp-persisted-authority'
      addPersistedProfile(persistedId, {
        resourceTypeId: rtId,
        ownerKind: 'ROLE',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'FIXED',
        defaultPercent: 100,
      })

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)

      const dto = getRes.body.capacityProfiles[0]
      // Persisted profile IS structurally valid — returned as authority
      expect(dto.id).toBe(persistedId)
      expect(dto.planningBasis).toBe('availabilityWindow')
      // Legacy fields are null for persisted-authority path
      expect(dto.legacy.allocationMode).toBeNull()
    })

    it('returns legacy-derived DTO when no persisted profiles exist', async () => {
      addResourceType(rtId, userName, 1, { allocationMode: 'EFFORT' })

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      expect(getRes.body.capacityProfiles).toHaveLength(1)
      expect(getRes.body.capacityProfiles[0].id).toBe(rtId)
      expect(getRes.body.capacityProfiles[0].legacy).toMatchObject({ allocationMode: 'EFFORT' })
    })
  })


  describe('6. Persisted-authority repair cycle', () => {
    it('complete persisted profiles remain authoritative; sync creates new NR profiles', async () => {
      addResourceType(rtId, userName, 1)
      addNamedResource('nr-1', 'Engineer 1', rtId)

      // Seed ROLE and named-resource profiles that differ from what the legacy
      // mapper would produce. Both owners are required for persisted authority
      // when a resource type has named resources.
      const roleProfileId = 'cp-role-persisted'
      addPersistedProfile(roleProfileId, {
        resourceTypeId: rtId,
        ownerKind: 'ROLE',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'FIXED',
        defaultPercent: 100,
      })
      const namedProfileId = 'cp-nr-1-persisted'
      addPersistedProfile(namedProfileId, {
        namedResourceId: 'nr-1',
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'FIXED',
        defaultPercent: 100,
      })

      // GET before PATCH — structurally valid complete profiles are
      // returned as authority.
      const getBefore = await getCapacityProfiles()
      expect(getBefore.status).toBe(200)
      expect(getBefore.body.capacityProfiles.length).toBeGreaterThanOrEqual(2)
      const roleDto = getBefore.body.capacityProfiles.find(
        (p: any) => p.owner.kind === 'role' && p.owner.id === rtId,
      )
      expect(roleDto).toBeDefined()
      expect(roleDto!.id).toBe(roleProfileId)
      // Legacy fields are null (persisted-authority path)
      expect(roleDto!.legacy.allocationMode).toBeNull()

      // Phase 2: trigger a PATCH that runs sync → creates profiles for new NRs
      await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 2 })

      // Original profiles survive (structurally valid, preserved by
      // preserveResourceTypeIds).
      const stillRole = storeRef.current.capacityProfiles.find(
        (p: any) => p.id === roleProfileId,
      )
      expect(stillRole).toBeDefined()
      expect(stillRole!.ownerKind).toBe('ROLE')
      const stillNamed = storeRef.current.capacityProfiles.find(
        (p: any) => p.id === namedProfileId,
      )
      expect(stillNamed).toBeDefined()
      expect(stillNamed!.ownerKind).toBe('NAMED_PERSON')

      // The new named resource (created by PATCH count increase) gets a
      // persisted profile from sync.
      const newNr = storeRef.current.namedResources.find(
        (n: any) => n.name === `${userName} 2`,
      )
      expect(newNr).toBeDefined()
      const newNRProfile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === newNr!.id,
      )
      expect(newNRProfile).toBeDefined()
      expect(newNRProfile!.ownerKind).toBe('NAMED_PERSON')

      // Phase 3: GET returns the old role profile and both NR profiles.
      const getAfter = await getCapacityProfiles()
      expect(getAfter.status).toBe(200)

      const roleDtoAfter = getAfter.body.capacityProfiles.find(
        (p: any) => p.owner.kind === 'role' && p.owner.id === rtId,
      )
      expect(roleDtoAfter).toBeDefined()
      expect(roleDtoAfter!.id).toBe(roleProfileId)

      const newNrDto = getAfter.body.capacityProfiles.find(
        (p: any) => p.owner.kind === 'namedPerson' && p.owner.id === newNr!.id,
      )
      expect(newNrDto).toBeDefined()
      expect(newNrDto!.planningBasis).toMatch(/demandFollowing|availabilityWindow/)

      const existingNrDto = getAfter.body.capacityProfiles.find(
        (p: any) => p.owner.kind === 'namedPerson' && p.owner.id === 'nr-1',
      )
      expect(existingNrDto).toBeDefined()
      expect(existingNrDto!.id).toBe(namedProfileId)
    })
    })


  describe('6b. Structural validation fallback', () => {
    it('falls back to legacy when persisted profile has duplicate owner keys', async () => {
      addResourceType(rtId, userName, 1, { allocationMode: 'EFFORT' })

      addPersistedProfile('cp-dupe-1', {
        resourceTypeId: rtId,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })
      addPersistedProfile('cp-dupe-2', {
        resourceTypeId: rtId,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      // Falls back to legacy — duplicate owner keys fail structural validation
      expect(getRes.body.capacityProfiles[0].id).toBe(rtId)
      expect(getRes.body.capacityProfiles[0].legacy).toMatchObject({ allocationMode: 'EFFORT' })
    })

    it('falls back to legacy when persisted profile references non-existent named resource', async () => {
      addResourceType(rtId, userName, 1, { allocationMode: 'EFFORT' })

      addPersistedProfile('cp-orphan-nr', {
        namedResourceId: 'nr-missing',
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      // Falls back — orphan owner FK fails structural validation
      expect(getRes.body.capacityProfiles[0].id).toBe(rtId)
    })

    it('falls back to legacy when persisted profile has both owner FKs set', async () => {
      addResourceType(rtId, userName, 1, { allocationMode: 'EFFORT' })
      addNamedResource('nr-both', 'Both FK', rtId)

      addPersistedProfile('cp-both-fk', {
        resourceTypeId: rtId,
        namedResourceId: 'nr-both',
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      // RT has named resource → legacy fallback returns named-person profile
      expect(getRes.body.capacityProfiles[0].owner.kind).toBe('namedPerson')
      expect(getRes.body.capacityProfiles[0].owner.id).toBe('nr-both')
      // Corrupt persisted profile id is NOT exposed
      const ids = getRes.body.capacityProfiles.map((p: any) => p.id)
      expect(ids).not.toContain('cp-both-fk')
    })

    it('falls back to legacy when persisted profile has neither owner FK set', async () => {
      addResourceType(rtId, userName, 1, { allocationMode: 'EFFORT' })

      addPersistedProfile('cp-no-fk', {
        resourceTypeId: null,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      expect(getRes.body.capacityProfiles[0].id).toBe(rtId)
    })

    it('falls back to legacy when ROLE profile has namedResourceId but no resourceTypeId', async () => {
      addResourceType(rtId, userName, 1, { allocationMode: 'EFFORT' })
      addNamedResource('nr-role-wrong', 'Wrong Role', rtId)

      addPersistedProfile('cp-role-nr', {
        resourceTypeId: null,
        namedResourceId: 'nr-role-wrong',
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      // RT has named resource → legacy fallback returns named-person profile
      expect(getRes.body.capacityProfiles[0].owner.kind).toBe('namedPerson')
      expect(getRes.body.capacityProfiles[0].owner.id).toBe('nr-role-wrong')
      // Corrupt persisted profile id is NOT exposed
      const ids = getRes.body.capacityProfiles.map((p: any) => p.id)
      expect(ids).not.toContain('cp-role-nr')
    })

    it('falls back to legacy when NAMED_PERSON profile has resourceTypeId but no namedResourceId', async () => {
      addResourceType(rtId, userName, 1, { allocationMode: 'EFFORT' })

      addPersistedProfile('cp-nr-rt', {
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 100,
      })

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      expect(getRes.body.capacityProfiles[0].id).toBe(rtId)
    })

    it('falls back to legacy when persisted profile has invalid source enum', async () => {
      addResourceType(rtId, userName, 1, { allocationMode: 'EFFORT' })

      addPersistedProfile('cp-bad-source', {
        resourceTypeId: rtId,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'BOGUS',
        defaultPercent: 100,
      })

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      expect(getRes.body.capacityProfiles[0].id).toBe(rtId)
    })

    it('falls back to legacy when segments overlap', async () => {
      addResourceType(rtId, userName, 1, { allocationMode: 'CAPACITY_PLAN' })
      addPersistedProfile('cp-overlap-segs', {
        resourceTypeId: rtId,
        ownerKind: 'ROLE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 100,
      })
      storeRef.current.capacitySegments.push(
        { id: 'seg-overlap-1', capacityProfileId: 'cp-overlap-segs', startWeek: 0, endWeek: 6, capacityPercent: 100, source: 'SQUAD_PLANNER', createdAt: new Date(), updatedAt: new Date() },
        { id: 'seg-overlap-2', capacityProfileId: 'cp-overlap-segs', startWeek: 4, endWeek: 8, capacityPercent: 50, source: 'SQUAD_PLANNER', createdAt: new Date(), updatedAt: new Date() },
      )

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      expect(getRes.body.capacityProfiles[0].id).toBe(rtId)
    })

    it('falls back to legacy when segment has invalid source', async () => {
      addResourceType(rtId, userName, 1, { allocationMode: 'CAPACITY_PLAN' })
      addPersistedProfile('cp-bad-seg-source', {
        resourceTypeId: rtId,
        ownerKind: 'ROLE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 100,
      })
      storeRef.current.capacitySegments.push(
        { id: 'seg-bad-source', capacityProfileId: 'cp-bad-seg-source', startWeek: 0, endWeek: 6, capacityPercent: 100, source: 'INVALID_SEG_SOURCE', createdAt: new Date(), updatedAt: new Date() },
      )

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      expect(getRes.body.capacityProfiles[0].id).toBe(rtId)
    })

    it('falls back to legacy when segment has negative startWeek', async () => {
      addResourceType(rtId, userName, 1, { allocationMode: 'CAPACITY_PLAN' })
      addPersistedProfile('cp-neg-start', {
        resourceTypeId: rtId,
        ownerKind: 'ROLE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 100,
      })
      storeRef.current.capacitySegments.push(
        { id: 'seg-neg', capacityProfileId: 'cp-neg-start', startWeek: -1, endWeek: 6, capacityPercent: 100, source: 'SQUAD_PLANNER', createdAt: new Date(), updatedAt: new Date() },
      )

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      expect(getRes.body.capacityProfiles[0].id).toBe(rtId)
    })

    it('keeps ROLE profiles authoritative when segment capacity exceeds 100%', async () => {
      addResourceType(rtId, userName, 1, { allocationMode: 'CAPACITY_PLAN' })
      addPersistedProfile('cp-role-over-100', {
        resourceTypeId: rtId,
        ownerKind: 'ROLE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 100,
      })
      storeRef.current.capacitySegments.push(
        { id: 'seg-role-over-100', capacityProfileId: 'cp-role-over-100', startWeek: 0, endWeek: 6, capacityPercent: 150, source: 'SQUAD_PLANNER', createdAt: new Date(), updatedAt: new Date() },
      )

      const getRes = await getCapacityProfiles()
      expect(getRes.status).toBe(200)
      expect(getRes.body.capacityProfiles[0].id).toBe('cp-role-over-100')
      expect(getRes.body.capacityProfiles[0].segments[0].capacityPercent).toBe(150)
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

      // Display fields projected from profile
      expect(nr.allocationMode).toBe('CAPACITY_PLAN')
      expect(nr.allocationPercent).toBe(75)
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

      // PUT with capacity fields on a segmented profile is BLOCKED by the capacity-edit
      // protection guard (PROFILE_MANAGED_CAPACITY). State must remain unchanged.
      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${segRtId}/named-resources/${segNrId}`)
        .set('Authorization', authHeader)
        .send({ name: 'Cleaned Person', allocationMode: 'EFFORT', allocationPercent: 100 })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')

      // Old profile and segments preserved
      const oldProfile = storeRef.current.capacityProfiles.find((p: any) => p.id === 'cp-seg-clean')
      expect(oldProfile).toBeDefined()
      expect(oldProfile!.planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(oldProfile!.defaultPercent).toBe(75)

      const segments = storeRef.current.capacitySegments.filter(
        (s: any) => s.capacityProfileId === 'cp-seg-clean',
      )
      expect(segments).toHaveLength(2)
      expect(segments[0].startWeek).toBe(2)
      expect(segments[0].endWeek).toBe(5)
      expect(segments[1].startWeek).toBe(6)
      expect(segments[1].endWeek).toBe(10)

      // Weekly demand cache unchanged (same {})
      expect(storeRef.current.project.weeklyDemandCache).toEqual({})
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
      expect(storeRef.current.capacityProfiles.filter((p: any) => p.resourceTypeId === rtId)).toHaveLength(1)

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
        allocationMode: 'CAPACITY_PLAN', allocationPercent: 90,
        allocationPct: 90,
        allocationStartWeek: 3, allocationEndWeek: 8,
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
  })

  describe('10. Two-RT cross-contamination regression', () => {
    it('capacity and non-capacity PUT on RT B leaves RT A profiles and segments unchanged', async () => {
      // ── Setup ────────────────────────────────────────────────────────
      const rtAId = 'rt-a-1'
      const nrAId = 'nr-a-1'
      const rtBId = 'rt-b-1'
      const nrBId = 'nr-b-1'

      // RT A: TIMELINE/100, one named resource
      addResourceType(rtAId, 'RT A', 1)
      addNamedResource(nrAId, 'RT A 1', rtAId)

      // RT B: EFFORT/100, one named resource
      addResourceType(rtBId, 'RT B', 1, {
        allocationMode: 'EFFORT', allocationPercent: 100,
        allocationStartWeek: null, allocationEndWeek: null,
      })
      addNamedResource(nrBId, 'RT B 1', rtBId)

      // Trigger sync to seed initial state
      const syncBefore = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtAId}`)
        .set('Authorization', authHeader)
        .send({ count: 1 })
      expect(syncBefore.status).toBe(200)

      const syncBeforeB = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtBId}`)
        .set('Authorization', authHeader)
        .send({ count: 1 })
      expect(syncBeforeB.status).toBe(200)

      // Snapshot RT A profiles and segments
      const snapshotA = () => {
        const profiles = storeRef.current.capacityProfiles
          .filter((p: any) => p.resourceTypeId === rtAId)
          .map((p: any) => JSON.parse(JSON.stringify(p)))
        const segments = storeRef.current.capacitySegments
          .filter((s: any) => profiles.some((p: any) => p.id === s.capacityProfileId))
          .map((s: any) => JSON.parse(JSON.stringify(s)))
        return { profiles, segments }
      }
      const beforeA = snapshotA()

      // ── Test 1: capacity PUT on RT B ──────────────────────────────────
      const putCapB = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtBId}`)
        .set('Authorization', authHeader)
        .send({ allocationMode: 'TIMELINE', allocationPercent: 80, allocationStartWeek: 2, allocationEndWeek: 10 })
      expect(putCapB.status).toBe(200)
      // RT A profiles and segments unchanged
      const afterPut = snapshotA()
      expect(JSON.stringify(beforeA.profiles)).toBe(JSON.stringify(afterPut.profiles))
      expect(JSON.stringify(beforeA.segments)).toBe(JSON.stringify(afterPut.segments))

      // ── Test 2: non-capacity PUT on RT B ──────────────────────────────
      const putNonCapB = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtBId}`)
        .set('Authorization', authHeader)
        .send({ name: 'RT B Renamed' })
      expect(putNonCapB.status).toBe(200)
      // RT A profiles and segments unchanged
      const afterNonCap = snapshotA()
      expect(JSON.stringify(beforeA.profiles)).toBe(JSON.stringify(afterNonCap.profiles))
      expect(JSON.stringify(beforeA.segments)).toBe(JSON.stringify(afterNonCap.segments))
    })
  })

  describe('11. PATCH regression coverage on persisted store', () => {
    let rtId: string, nrInhId: string, nrExpSegId: string, nrExpPlanned: string

    beforeEach(() => {
      rtId = 'patch-rt-1'
      nrInhId = 'patch-nr-inh'
      nrExpSegId = 'patch-nr-seg'
      nrExpPlanned = 'patch-nr-plan'

      // Clean slate for each test
      storeRef.current = createStore()

      // RT: CAPACITY_PLAN/25/W4-W8, 3 NRs
      addResourceType(rtId, 'Patch Role', 3, {
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 25,
        allocationStartWeek: 4,
        allocationEndWeek: 8,
      })

      // Inherited NR: matches CAPACITY_PLAN/25/W4-W8, no profile
      addNamedResource(nrInhId, 'Patch Inherited', rtId, {
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 25,
        allocationPct: 25,
        allocationStartWeek: 4,
        allocationEndWeek: 8,
      })

      // Explicit NR: segmented profile with CAPACITY_PLAN/25/W4-W8 compatibility
      addNamedResource(nrExpSegId, 'Patch Segmented', rtId, {
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 25,
        allocationPct: 25,
        allocationStartWeek: 4,
        allocationEndWeek: 8,
      })
      addPersistedProfile('cp-seg-1', {
        namedResourceId: nrExpSegId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'EFFORT',
        defaultPercent: 50,
        startWeek: 3,
        endWeek: 7,
        // Populated legacy field ensures protection derives from segments, not null-legacy
        legacy: { allocationMode: 'CAPACITY_PLAN', allocationPercent: 25, allocationPct: 25, allocationStartWeek: 4, allocationEndWeek: 8 },
      })
      const segNow = new Date()
      storeRef.current.capacitySegments.push(
        { id: 'seg-explicit-1', capacityProfileId: 'cp-seg-1', startWeek: 3, endWeek: 5, capacityPercent: 100, source: 'EFFORT', createdAt: segNow, updatedAt: segNow },
        { id: 'seg-explicit-2', capacityProfileId: 'cp-seg-1', startWeek: 6, endWeek: 7, capacityPercent: 50, source: 'EFFORT', createdAt: segNow, updatedAt: segNow },
      )

      // Explicit NR: PLANNED_RESOURCE profile (backfilled)
      addNamedResource(nrExpPlanned, 'Patch Planned', rtId, {
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 25,
        allocationPct: 25,
        allocationStartWeek: 4,
        allocationEndWeek: 8,
      })
      addPersistedProfile('cp-plan-1', {
        namedResourceId: nrExpPlanned,
        ownerKind: 'PLANNED_RESOURCE',
        planningBasis: 'CAPACITY_PLAN',
        source: 'CAPACITY_PLAN',
        defaultPercent: 100,
      })
    })

    it('count increase preserves authoritative role profile and explicit multi-segment NR while creating inherited NR at role defaults', async () => {
      const res = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 4 })
      expect(res.status).toBe(200)

      // Role profile still exists (preserved by preserveResourceTypeIds)
      const roleProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(roleProfiles.length).toBeGreaterThanOrEqual(1)
      // CAPACITY_PLAN exit upserts role profile as TIMELINE → AVAILABILITY_WINDOW
      expect(roleProfiles[0].planningBasis).toBe('AVAILABILITY_WINDOW')

      // Explicit segmented NR profile unchanged
      const segProfile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === nrExpSegId,
      )
      expect(segProfile).toBeDefined()
      expect(segProfile!.planningBasis).toBe('DEMAND_FOLLOWING')
      expect(segProfile!.defaultPercent).toBe(50)

      // Planned NR profile unchanged
      const planProfile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === nrExpPlanned,
      )
      expect(planProfile).toBeDefined()
      expect(planProfile!.ownerKind).toBe('PLANNED_RESOURCE')

      // New NR created and has a named-person profile
      const allNRs = storeRef.current.namedResources.filter(
        (nr: any) => nr.resourceTypeId === rtId,
      )
      const newNR = allNRs.find((nr: any) => !['patch-nr-inh', 'patch-nr-seg', 'patch-nr-plan'].includes(nr.id))
      expect(newNR).toBeDefined()
      const newNrProfile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === newNR!.id,
      )
      expect(newNrProfile!.ownerKind).toBe('NAMED_PERSON')

      // Blocker 1: CAPACITY_PLAN exit does NOT clone old role segments to new NR
      expect(newNrProfile!.planningBasis).not.toBe('CAPACITY_PROFILE')
      const newNRSegments = storeRef.current.capacitySegments.filter(
        (s: any) => s.capacityProfileId === newNrProfile!.id,
      )
      expect(newNRSegments.length).toBe(0)
    })

    it('CAPACITY_PLAN mixed ownership: only inherited compatibility fields change on exit', async () => {
      // ── Snapshot pre-mutation explicit segment state ────────────────
      const beforeSegProfile = JSON.parse(JSON.stringify(
        storeRef.current.capacityProfiles.find((p: any) => p.id === 'cp-seg-1'),
      ))
      const beforeSegments = JSON.parse(JSON.stringify(
        storeRef.current.capacitySegments.filter(
          (s: any) => s.capacityProfileId === 'cp-seg-1',
        ),
      ))

      const res = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 3 })
      expect(res.status).toBe(200)

      // ── ResourceType fields transitioned to TIMELINE/100 ────────────
      const roleRT = storeRef.current.resourceTypes.find((rt: any) => rt.id === rtId)
      expect(roleRT).toBeDefined()
      expect(roleRT!.allocationMode).toBe('TIMELINE')
      expect(roleRT!.allocationPercent).toBe(100)

      // ── Role profile exists (preserved by preserveResourceTypeIds) ──
      const roleProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(roleProfiles.length).toBeGreaterThanOrEqual(1)

      // ── Inherited NR: compatibility fields changed to TIMELINE/100 ──
      const inheritedNR = storeRef.current.namedResources.find(
        (nr: any) => nr.id === nrInhId,
      )
      expect(inheritedNR).toBeDefined()
      expect(inheritedNR!.allocationMode).toBe('TIMELINE')
      expect(inheritedNR!.allocationPercent).toBe(100)

      // ── Explicit NRs (segmented, planned): fields UNCHANGED ─────────
      const segNR = storeRef.current.namedResources.find(
        (nr: any) => nr.id === nrExpSegId,
      )
      expect(segNR).toBeDefined()
      expect(segNR!.allocationMode).toBe('CAPACITY_PLAN')
      expect(segNR!.allocationPercent).toBe(25)

      const planNR = storeRef.current.namedResources.find(
        (nr: any) => nr.id === nrExpPlanned,
      )
      expect(planNR).toBeDefined()
      expect(planNR!.allocationMode).toBe('CAPACITY_PLAN')
      expect(planNR!.allocationPercent).toBe(25)

      // ── Segmented NR profile unchanged ──────────────────────────────
      const segProfile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === nrExpSegId,
      )
      expect(segProfile).toBeDefined()
      expect(segProfile!.planningBasis).toBe('DEMAND_FOLLOWING')
      expect(segProfile!.defaultPercent).toBe(50)

      // ── Segments preserved byte-for-byte ────────────────────────────
      const afterSegProfile = JSON.parse(JSON.stringify(
        storeRef.current.capacityProfiles.find((p: any) => p.id === 'cp-seg-1'),
      ))
      const afterSegments = JSON.parse(JSON.stringify(
        storeRef.current.capacitySegments.filter(
          (s: any) => s.capacityProfileId === 'cp-seg-1',
        ),
      ))
      expect(JSON.stringify(beforeSegProfile)).toBe(JSON.stringify(afterSegProfile))
      expect(JSON.stringify(beforeSegments)).toBe(JSON.stringify(afterSegments))
    })

    it('no-op count PATCH leaves full scoped profile and segment snapshot byte-identical', async () => {
      // Guarantee initial sync
      const syncRes = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 3 })
      expect(syncRes.status).toBe(200)

      // Snapshot
      const before = JSON.parse(JSON.stringify(storeRef.current.capacityProfiles))
      const beforeSegments = JSON.parse(JSON.stringify(storeRef.current.capacitySegments))

      // No-op PATCH
      const noop = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 3 })
      expect(noop.status).toBe(200)

      // Byte-identical
      const after = JSON.parse(JSON.stringify(storeRef.current.capacityProfiles))
      const afterSegments = JSON.parse(JSON.stringify(storeRef.current.capacitySegments))
      expect(JSON.stringify(before)).toBe(JSON.stringify(after))
      expect(JSON.stringify(beforeSegments)).toBe(JSON.stringify(afterSegments))
    })

    it('safe reduction with multiple inherited and protected NRs: deletes eligible inherited only, warns, count matches actual', async () => {
      // Create two more inherited NRs (same CAPACITY_PLAN defaults as role → inherited)
      addNamedResource('patch-nr-inh-2', 'Patch Inh 2', rtId, {
        allocationMode: 'CAPACITY_PLAN', allocationPercent: 25,
        allocationPct: 25, allocationStartWeek: 4, allocationEndWeek: 8,
      })
      addNamedResource('patch-nr-inh-3', 'Patch Inh 3', rtId, {
        allocationMode: 'CAPACITY_PLAN', allocationPercent: 25,
        allocationPct: 25, allocationStartWeek: 4, allocationEndWeek: 8,
      })

      // Update store count
      const existingRT = storeRef.current.resourceTypes.find((rt: any) => rt.id === rtId)
      if (existingRT) existingRT.count = 5


      // PATCH to reduce to 1 — 2 protected NRs exist
      const res = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 1 })
      expect(res.status).toBe(200)

      // Only inherited NRs with no profiles are deletable
      const remainingNRs = storeRef.current.namedResources.filter(
        (nr: any) => nr.resourceTypeId === rtId,
      )
      // 2 protected (segmented, planned) remain — all inherited NRs were removed
      expect(remainingNRs.length).toBe(2)

      // Warning returned with exact values
      expect(res.body.warnings).toBeDefined()
      expect(res.body.warnings.length).toBe(1)
      const warning = res.body.warnings[0]
      expect(warning).toBe(
        'Could not reduce resource count to 1 because 2 resource(s) have custom or protected capacity settings. Actual count remains 2.',
      )

      // Persisted count equals actual (2, not requested 1)
      const updatedRT = storeRef.current.resourceTypes.find((rt: any) => rt.id === rtId)
      expect(updatedRT!.count).toBe(2)
    })

    it('safe reduction: reachable target with protected NRs produces no warning', async () => {
      // Setup: 2 protected NRs, 3 inherited NRs, current count = 5, requested count = 3
      addNamedResource('patch-nr-inh-r2', 'Patch Inh R2', rtId, {
        allocationMode: 'CAPACITY_PLAN', allocationPercent: 25,
        allocationPct: 25, allocationStartWeek: 4, allocationEndWeek: 8,
      })
      addNamedResource('patch-nr-inh-r3', 'Patch Inh R3', rtId, {
        allocationMode: 'CAPACITY_PLAN', allocationPercent: 25,
        allocationPct: 25, allocationStartWeek: 4, allocationEndWeek: 8,
      })
      const existingRT = storeRef.current.resourceTypes.find((rt: any) => rt.id === rtId)
      if (existingRT) existingRT.count = 5

      const res = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 3 })
      expect(res.status).toBe(200)

      // 2 inherited NRs removed → 3 NRs remain (2 protected + 1 inherited)
      const remaining = storeRef.current.namedResources.filter(
        (nr: any) => nr.resourceTypeId === rtId,
      )
      expect(remaining.length).toBe(3)

      // No warning — requested count was reached
      expect(res.body.warnings).toBeUndefined()

      // Persisted count is 3
      const updated = storeRef.current.resourceTypes.find((rt: any) => rt.id === rtId)
      expect(updated!.count).toBe(3)
    })

    it('two-RT isolation: directly seeded RT A profiles unchanged after B increase, reduction, same-count, and PUT', async () => {
      // ── Direct seed: RT A with role profile, NR, NR profile, and segments ──
      const rtAId = 'patch-iso-a'
      const nrAId = 'patch-iso-a-1'

      addResourceType(rtAId, 'Isolate A', 1, {
        allocationMode: 'TIMELINE', allocationPercent: 100,
      })
      addNamedResource(nrAId, 'Isolate A 1', rtAId, {
        allocationMode: 'TIMELINE', allocationPercent: 100, allocationPct: 100,
      })
      // Role-owned profile for A
      addPersistedProfile('cp-iso-role-a', {
        resourceTypeId: rtAId, namedResourceId: null, ownerKind: 'ROLE',
        planningBasis: 'AVAILABILITY_WINDOW', source: 'MANUAL',
        defaultPercent: 100, startWeek: null, endWeek: null,
      })
      // Role segments
      storeRef.current.capacitySegments.push(
        { id: 'seg-iso-role-a1', capacityProfileId: 'cp-iso-role-a', startWeek: 1, endWeek: 6, capacityPercent: 100, source: 'MANUAL', createdAt: new Date(), updatedAt: new Date() },
        { id: 'seg-iso-role-a2', capacityProfileId: 'cp-iso-role-a', startWeek: 7, endWeek: 12, capacityPercent: 50, source: 'MANUAL', createdAt: new Date(), updatedAt: new Date() },
      )
      // NR-owned profile for A
      addPersistedProfile('cp-iso-nr-a', {
        namedResourceId: nrAId, ownerKind: 'NAMED_PERSON',
        planningBasis: 'AVAILABILITY_WINDOW', source: 'MANUAL',
        defaultPercent: 75, startWeek: 1, endWeek: 12,
      })
      // NR segments
      storeRef.current.capacitySegments.push(
        { id: 'seg-iso-nr-a1', capacityProfileId: 'cp-iso-nr-a', startWeek: 1, endWeek: 6, capacityPercent: 100, source: 'MANUAL', createdAt: new Date(), updatedAt: new Date() },
      )

      // ── Build snapshot with correct ownership scope ──────────────────
      const rtANRIds = new Set(
        storeRef.current.namedResources
          .filter((nr: any) => nr.resourceTypeId === rtAId)
          .map((nr: any) => nr.id),
      )
      const snapshotA = () => {
        const rts = storeRef.current.resourceTypes
          .filter((r: any) => r.id === rtAId)
          .map((r: any) => JSON.parse(JSON.stringify(r)))
        const nrs = storeRef.current.namedResources
          .filter((nr: any) => nr.resourceTypeId === rtAId)
          .map((nr: any) => JSON.parse(JSON.stringify(nr)))
        const profiles = storeRef.current.capacityProfiles
          .filter((p: any) =>
            p.resourceTypeId === rtAId ||
            (p.namedResourceId != null && rtANRIds.has(p.namedResourceId)),
          )
          .map((p: any) => JSON.parse(JSON.stringify(p)))
        const relatedProfileIds = new Set(profiles.map((p: any) => p.id))
        const segments = storeRef.current.capacitySegments
          .filter((s: any) => relatedProfileIds.has(s.capacityProfileId))
          .map((s: any) => JSON.parse(JSON.stringify(s)))
        return { rts, nrs, profiles, segments }
      }

      // ── RT B with role profile ───────────────────────────────────────
      const rtBId = 'patch-iso-b'
      const nrBId = 'patch-iso-b-1'

      addResourceType(rtBId, 'Isolate B', 1, {
        allocationMode: 'EFFORT', allocationPercent: 100,
      })
      addNamedResource(nrBId, 'Isolate B 1', rtBId, {
        allocationMode: 'EFFORT', allocationPercent: 100, allocationPct: 100,
      })
      addPersistedProfile('cp-iso-role-b', {
        resourceTypeId: rtBId, namedResourceId: null, ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
        defaultPercent: 100,
      })

      const beforeA = snapshotA()

      // 1. Count increase on B
      const incB = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtBId}`)
        .set('Authorization', authHeader)
        .send({ count: 3 })
      expect(incB.status).toBe(200)
      expect(JSON.stringify(beforeA)).toBe(JSON.stringify(snapshotA()))

      // 2. Count reduction on B
      const decB = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtBId}`)
        .set('Authorization', authHeader)
        .send({ count: 1 })
      expect(decB.status).toBe(200)
      expect(JSON.stringify(beforeA)).toBe(JSON.stringify(snapshotA()))

      // 3. Same-count PATCH on B
      const sameB = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtBId}`)
        .set('Authorization', authHeader)
        .send({ count: 1 })
      expect(sameB.status).toBe(200)
      expect(JSON.stringify(beforeA)).toBe(JSON.stringify(snapshotA()))

      // 4. Normal role-capacity PUT on B
      const putB = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${rtBId}`)
        .set('Authorization', authHeader)
        .send({ allocationMode: 'EFFORT', allocationPercent: 80 })
      expect(putB.status).toBe(200)
      expect(JSON.stringify(beforeA)).toBe(JSON.stringify(snapshotA()))
    })
  })
  describe('12. Non-CAPACITY_PLAN role route integration', () => {
    const rtId = 'ncp-rt'
    const roleProfileId = 'ncp-role-pro'
    const roleSeg1 = 'ncp-role-seg-1'
    const roleSeg2 = 'ncp-role-seg-2'
    const roleSeg3 = 'ncp-role-seg-3'

    beforeEach(() => {
      storeRef.current = createStore()

      // ResourceType compatibility (stale — kept for legacy fallback)
      addResourceType(rtId, 'Non-CP RT', 2, {
        allocationMode: 'TIMELINE',
        allocationPercent: 72,
        allocationStartWeek: 1,
        allocationEndWeek: 12,
      })

      // Role-owned non-CAPACITY_PLAN profile with segments (AVAILABILITY_WINDOW)
      const now = new Date()
      storeRef.current.capacityProfiles.push({
        id: roleProfileId,
        projectId,
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'AVAILABILITY_WINDOW',
        defaultPercent: 75,
        startWeek: 1,
        endWeek: 12,
        legacy: null,
        createdAt: now,
        updatedAt: now,
      })
      storeRef.current.capacitySegments.push(
        { id: roleSeg1, capacityProfileId: roleProfileId, startWeek: 1, endWeek: 4, capacityPercent: 50, source: 'AVAILABILITY_WINDOW', createdAt: now, updatedAt: now },
        { id: roleSeg2, capacityProfileId: roleProfileId, startWeek: 5, endWeek: 8, capacityPercent: 75, source: 'AVAILABILITY_WINDOW', createdAt: now, updatedAt: now },
        { id: roleSeg3, capacityProfileId: roleProfileId, startWeek: 9, endWeek: 12, capacityPercent: 100, source: 'AVAILABILITY_WINDOW', createdAt: now, updatedAt: now },
      )

      // Inherited NR: matches authoritative role default projection (TIMELINE/75/W1-W12)
      addNamedResource('ncp-nr-inh', 'Inherited', rtId, {
        allocationMode: 'TIMELINE', allocationPercent: 75, allocationPct: 75,
        allocationStartWeek: 1, allocationEndWeek: 12,
      })

      // Explicit NR with explicit profile (segments/legacy)
      const expNrId = 'ncp-nr-exp'
      addNamedResource(expNrId, 'Explicit', rtId, {
        allocationMode: 'TIMELINE', allocationPercent: 72, allocationPct: 72,
        allocationStartWeek: 1, allocationEndWeek: 12,
      })
      storeRef.current.capacityProfiles.push({
        id: 'ncp-exp-pro',
        projectId,
        namedResourceId: expNrId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 60,
        startWeek: null,
        endWeek: null,
        legacy: { allocationMode: 'EFFORT', allocationPercent: 60, allocationPct: 60 },
        createdAt: now,
        updatedAt: now,
      })
    })

    // ── Blocker 4: Multi-segment clone test ─────────────────────────────
    it('non-CAPACITY_PLAN count increase clones role segments to new NR', async () => {
      const res = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 4 })
      expect(res.status).toBe(200)

      // ── Original role profile preserved ───────────────────────────
      const roleProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.id === roleProfileId,
      )
      expect(roleProfiles.length).toBe(1)
      const rp = roleProfiles[0]
      expect(rp.resourceTypeId).toBe(rtId)
      expect(rp.namedResourceId).toBeNull()
      expect(rp.planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(rp.source).toBe('AVAILABILITY_WINDOW')
      expect(rp.defaultPercent).toBe(75)
      expect(rp.startWeek).toBe(1)
      expect(rp.endWeek).toBe(12)

      // ── Role segment IDs unchanged ────────────────────────────────
      const roleSegs = storeRef.current.capacitySegments
        .filter((s: any) => s.capacityProfileId === roleProfileId)
        .sort((a: any, b: any) => a.startWeek - b.startWeek)
      expect(roleSegs.length).toBe(3)
      expect(roleSegs[0].id).toBe(roleSeg1)
      expect(roleSegs[0].capacityPercent).toBe(50)
      expect(roleSegs[1].id).toBe(roleSeg2)
      expect(roleSegs[1].capacityPercent).toBe(75)
      expect(roleSegs[2].id).toBe(roleSeg3)
      expect(roleSegs[2].capacityPercent).toBe(100)

      // ── New NR exists ─────────────────────────────────────────────
      const allNRs = storeRef.current.namedResources.filter((nr: any) => nr.resourceTypeId === rtId)
      expect(allNRs.length).toBe(4)
      const newNR = allNRs.find((nr: any) =>
        !['ncp-nr-inh', 'ncp-nr-exp'].includes(nr.id),
      )
      expect(newNR).toBeDefined()

      // ── New NR compatibility: lossy projection of multi-segment role profile ──
      expect(newNR!.allocationMode).toBe('TIMELINE')
      expect(newNR!.allocationPercent).toBe(75)
      expect(newNR!.allocationPct).toBe(75)
      expect(newNR!.allocationStartWeek).toBe(1)
      expect(newNR!.allocationEndWeek).toBe(12)
      expect(newNR!.startWeek).toBe(1)
      expect(newNR!.endWeek).toBe(12)

      // ── New NR has cloned profile with NAMED_PERSON owner ─────────
      const newNRProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.namedResourceId === newNR!.id,
      )
      expect(newNRProfiles.length).toBe(1)
      const nrp = newNRProfiles[0]
      expect(nrp.id).not.toBe(roleProfileId)
      expect(nrp.ownerKind).toBe('NAMED_PERSON')
      expect(nrp.resourceTypeId).toBeNull()
      expect(nrp.namedResourceId).toBe(newNR!.id)
      expect(nrp.planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(nrp.source).toBe('AVAILABILITY_WINDOW')
      expect(nrp.defaultPercent).toBe(75)
      expect(nrp.startWeek).toBe(1)
      expect(nrp.endWeek).toBe(12)

      // ── Cloned segments ───────────────────────────────────────────
      const clonedSegs = storeRef.current.capacitySegments
        .filter((s: any) => s.capacityProfileId === nrp.id)
        .sort((a: any, b: any) => a.startWeek - b.startWeek)
      expect(clonedSegs[0].capacityPercent).toBe(50)
      expect(clonedSegs[0].startWeek).toBe(1)
      expect(clonedSegs[0].endWeek).toBe(4)
      expect(clonedSegs[1].capacityPercent).toBe(75)
      expect(clonedSegs[1].startWeek).toBe(5)
      expect(clonedSegs[1].endWeek).toBe(8)
      expect(clonedSegs[2].capacityPercent).toBe(100)
      expect(clonedSegs[2].startWeek).toBe(9)
      expect(clonedSegs[2].endWeek).toBe(12)

      // All cloned segment IDs differ from role segment IDs
      expect(clonedSegs[0].id).not.toBe(roleSeg1)
      expect(clonedSegs[1].id).not.toBe(roleSeg2)
      expect(clonedSegs[2].id).not.toBe(roleSeg3)

      // Every cloned segment references the cloned NR profile
      clonedSegs.forEach((s: any) => expect(s.capacityProfileId).toBe(nrp.id))


      // ── GET returns clone as named-person owned (legacy fallback, no segments) ──
      // Note: legacy mapper skips role profiles when NRs exist, and the
      // cloned profile has segments that cause reconciliation fallback,
      // so segments are not included in the legacy-derived DTO.
      const getRes = await request(app)
        .get(`/api/projects/${projectId}/capacity-profiles`)
        .set('Authorization', authHeader)
      expect(getRes.status).toBe(200)
      const profiles = getRes.body.capacityProfiles
      expect(Array.isArray(profiles)).toBe(true)

      // New NR's cloned profile appears as named-person owner
      const nrDTOs = profiles.filter(
        (p: any) => p.owner?.kind === 'namedPerson' && p.owner?.id === newNR!.id,
      )
      expect(nrDTOs.length).toBe(1)
      expect(nrDTOs[0].planningBasis).toBe('availabilityWindow')
      expect(nrDTOs[0].defaultPercent).toBe(75)
    })

    // ── Blocker 7a: count reduction preserves non-CP role profile ────
    it('count reduction preserves non-CAPACITY_PLAN role profile and segments; deletes only inherited NR', async () => {
      const res = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 1 })
      expect(res.status).toBe(200)

      // Only the protected NR remains
      const remaining = storeRef.current.namedResources.filter(
        (nr: any) => nr.resourceTypeId === rtId,
      )
      expect(remaining.length).toBe(1)
      expect(remaining[0].id).toBe('ncp-nr-exp')
      expect(storeRef.current.namedResources.find((nr: any) => nr.id === 'ncp-nr-inh')).toBeUndefined()

      // Persisted count equals requested count (target reached)
      const updatedRT = storeRef.current.resourceTypes.find((rt: any) => rt.id === rtId)
      expect(updatedRT!.count).toBe(1)

      // No warning — target was reachable
      expect(res.body.warnings).toBeUndefined()

      // Role profile unchanged
      const roleProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.id === roleProfileId,
      )
      expect(roleProfiles.length).toBe(1)
      const rp = roleProfiles[0]
      expect(rp.planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(rp.defaultPercent).toBe(75)
      expect(rp.startWeek).toBe(1)
      expect(rp.endWeek).toBe(12)

      // Role segments unchanged
      const roleSegs = storeRef.current.capacitySegments
        .filter((s: any) => s.capacityProfileId === roleProfileId)
        .sort((a: any, b: any) => a.startWeek - b.startWeek)
      expect(roleSegs.length).toBe(3)
      expect(roleSegs[0].id).toBe(roleSeg1)
      expect(roleSegs[0].capacityPercent).toBe(50)
      expect(roleSegs[0].startWeek).toBe(1)
      expect(roleSegs[0].endWeek).toBe(4)
      expect(roleSegs[1].id).toBe(roleSeg2)
      expect(roleSegs[1].capacityPercent).toBe(75)
      expect(roleSegs[1].startWeek).toBe(5)
      expect(roleSegs[1].endWeek).toBe(8)
      expect(roleSegs[2].id).toBe(roleSeg3)
      expect(roleSegs[2].capacityPercent).toBe(100)
      expect(roleSegs[2].startWeek).toBe(9)
      expect(roleSegs[2].endWeek).toBe(12)

      // No duplicate role profile
      expect(
        storeRef.current.capacityProfiles.filter(
          (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
        ).length,
      ).toBe(1)
    })
    // ── Blocker 7b: same-count no-op preserves everything ────────────
    it('same-count PATCH preserves non-CAPACITY_PLAN profiles and segments unchanged', async () => {
      // Snapshot before
      const beforeProfiles = JSON.parse(JSON.stringify(
        storeRef.current.capacityProfiles.filter(
          (p: any) => p.resourceTypeId === rtId || p.namedResourceId !== null,
        ),
      ))
      const beforeSegments = JSON.parse(JSON.stringify(
        storeRef.current.capacitySegments,
      ))

      const res = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 2 })
      expect(res.status).toBe(200)

      // Byte-identical
      const afterProfiles = JSON.parse(JSON.stringify(
        storeRef.current.capacityProfiles.filter(
          (p: any) => p.resourceTypeId === rtId || p.namedResourceId !== null,
        ),
      ))
      const afterSegments = JSON.parse(JSON.stringify(
        storeRef.current.capacitySegments,
      ))
      expect(JSON.stringify(beforeProfiles)).toBe(JSON.stringify(afterProfiles))
      expect(JSON.stringify(beforeSegments)).toBe(JSON.stringify(afterSegments))
    })

    // ── Blocker 3: EFFORT/70 route integration test ──────────────────
    it('count increase with EFFORT/70 role profile creates NR at correct inherited state', async () => {
      storeRef.current = createStore()
      const rtId = 'eff70-rt'
      const roleProfileId = 'eff70-role'

      addResourceType(rtId, 'Effort70 RT', 1, {
        allocationMode: 'TIMELINE',
        allocationPercent: 100,
      })
      addNamedResource('eff70-nr-1', 'Existing E70', rtId, {
        allocationMode: 'EFFORT', allocationPercent: 70, allocationPct: 70,
      })
      storeRef.current.capacityProfiles.push({
        id: roleProfileId,
        projectId,
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 70,
        startWeek: null,
        endWeek: null,
        legacy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      const res = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 2 })
      expect(res.status).toBe(200)

      // New NR created
      const newNR = storeRef.current.namedResources.find(
        (nr: any) => nr.id !== 'eff70-nr-1' && nr.resourceTypeId === rtId,
      )
      expect(newNR).toBeDefined()

      // Assert every compatibility field explicitly
      expect(newNR!.allocationMode).toBe('EFFORT')
      expect(newNR!.allocationPercent).toBe(70)
      expect(newNR!.allocationPct).toBe(70)
      expect(newNR!.allocationStartWeek).toBeNull()
      expect(newNR!.allocationEndWeek).toBeNull()
      expect(newNR!.startWeek).toBeNull()
      expect(newNR!.endWeek).toBeNull()

      // Assert persisted NR profile
      const nrProfile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === newNR!.id,
      )
      expect(nrProfile).toBeDefined()
      expect(nrProfile!.ownerKind).toBe('NAMED_PERSON')
      expect(nrProfile!.resourceTypeId).toBeNull()
      expect(nrProfile!.namedResourceId).toBe(newNR!.id)
      expect(nrProfile!.planningBasis).toBe('DEMAND_FOLLOWING')
      expect(nrProfile!.defaultPercent).toBe(70)
      expect(nrProfile!.startWeek).toBeNull()
      expect(nrProfile!.endWeek).toBeNull()

      // Role profile unchanged
      const roleProfile = storeRef.current.capacityProfiles.find(
        (p: any) => p.id === roleProfileId,
      )
      expect(roleProfile).toBeDefined()
      expect(roleProfile!.resourceTypeId).toBe(rtId)
      expect(roleProfile!.namedResourceId).toBeNull()
      expect(roleProfile!.planningBasis).toBe('DEMAND_FOLLOWING')
      expect(roleProfile!.source).toBe('FIXED')
      expect(roleProfile!.defaultPercent).toBe(70)

      // No duplicate role profile
      const allRoleProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(allRoleProfiles.length).toBe(1)
    })

    // ── Blocker 8: Scheduling drift tests ─────────────────────────────

    it('drift A: legacy CAPACITY_PLAN but authoritative DEMAND_FOLLOWING/70 does not exit to TIMELINE', async () => {
      storeRef.current = createStore()
      const rtId = 'drift-a-rt'
      const roleProfileId = 'drift-a-role'

      // RT legacy: CAPACITY_PLAN/100 (stale — role profile overrides)
      addResourceType(rtId, 'Drift A', 1, {
        allocationMode: 'CAPACITY_PLAN',
        allocationPercent: 100,
        allocationStartWeek: 1,
        allocationEndWeek: 12,
      })
      addNamedResource('drift-a-nr-1', 'Drift A NR', rtId, {
        allocationMode: 'EFFORT', allocationPercent: 70, allocationPct: 70,
      })
      // Authoritative role profile: DEMAND_FOLLOWING/FIXED/70 (not CAPACITY_PROFILE)
      storeRef.current.capacityProfiles.push({
        id: roleProfileId,
        projectId,
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 70,
        startWeek: null,
        endWeek: null,
        legacy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      const res = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 2 })
      expect(res.status).toBe(200)

      // ResourceType NOT transitioned to TIMELINE/100 — should remain unchanged
      const updatedRT = storeRef.current.resourceTypes.find((rt: any) => rt.id === rtId)
      expect(updatedRT!.allocationMode).toBe('CAPACITY_PLAN')
      expect(updatedRT!.allocationPercent).toBe(100)

      // Role profile unchanged
      const roleProfile = storeRef.current.capacityProfiles.find(
        (p: any) => p.id === roleProfileId,
      )
      expect(roleProfile).toBeDefined()
      expect(roleProfile!.planningBasis).toBe('DEMAND_FOLLOWING')
      expect(roleProfile!.defaultPercent).toBe(70)

      // New NR created at EFFORT/70 (not at TIMELINE/100 exit values)
      const newNR = storeRef.current.namedResources.find(
        (nr: any) => nr.id !== 'drift-a-nr-1' && nr.resourceTypeId === rtId,
      )
      expect(newNR).toBeDefined()
      expect(newNR!.allocationMode).toBe('EFFORT')
      expect(newNR!.allocationPercent).toBe(70)

      // No CAPACITY_PLAN exit — role profile not replaced
      expect(
        storeRef.current.capacityProfiles.filter(
          (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
        ).length,
      ).toBe(1)
    })

    it('drift B: legacy EFFORT/100 but authoritative CAPACITY_PROFILE exits to manual scheduling', async () => {
      storeRef.current = createStore()
      const rtId = 'drift-b-rt'
      const roleProfileId = 'drift-b-role'

      // RT legacy: EFFORT/100 (stale)
      addResourceType(rtId, 'Drift B', 1, {
        allocationMode: 'EFFORT',
        allocationPercent: 100,
      })
      addNamedResource('drift-b-nr-1', 'Drift B NR', rtId, {
        allocationMode: 'CAPACITY_PLAN', allocationPercent: 100, allocationPct: 100,
        allocationStartWeek: 2, allocationEndWeek: 4,
      })
      // Authoritative role profile: CAPACITY_PROFILE with segments
      storeRef.current.capacityProfiles.push({
        id: roleProfileId,
        projectId,
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'CAPACITY_PLAN',
        defaultPercent: 90,
        startWeek: null,
        endWeek: null,
        legacy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      storeRef.current.capacitySegments.push(
        { id: 'drift-b-seg-1', capacityProfileId: roleProfileId, startWeek: 2, endWeek: 4, capacityPercent: 100, source: 'CAPACITY_PLAN', createdAt: new Date(), updatedAt: new Date() },
      )

      // PATCH same count (count=1) to trigger CAPACITY_PLAN detection
      const res = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 1 })
      expect(res.status).toBe(200)

      // Route detected authoritative CAPACITY_PLAN → exit to manual scheduling
      const updatedRT = storeRef.current.resourceTypes.find((rt: any) => rt.id === rtId)
      expect(updatedRT!.allocationMode).toBe('TIMELINE')
      expect(updatedRT!.allocationPercent).toBe(100)

      // Inherited NR transitions
      const inheritedNR = storeRef.current.namedResources.find(
        (nr: any) => nr.id === 'drift-b-nr-1',
      )
      expect(inheritedNR).toBeDefined()
      expect(inheritedNR!.allocationMode).toBe('TIMELINE')
      expect(inheritedNR!.allocationPercent).toBe(100)

      // Role profile replaced with exit-manual (AVAILABILITY_WINDOW)
      const roleProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(roleProfiles.length).toBe(1)
      expect(roleProfiles[0].planningBasis).toBe('AVAILABILITY_WINDOW')
    })

    // ── Blocker 2: authoritative CAPACITY_PROFILE count-increase ──────
    it('count increase with authoritative CAPACITY_PROFILE role profile exits to manual and does not clone old segments', async () => {
      storeRef.current = createStore()
      const rtId = 'cp-auth-inc'
      const roleProfileId = 'cp-auth-role'
      const roleSeg1 = 'cp-auth-seg-1'
      const roleSeg2 = 'cp-auth-seg-2'
      const inhNrId = 'cp-auth-inh'
      const protNrId = 'cp-auth-prot'
      const protProfId = 'cp-auth-prot-pro'

      // RT legacy: EFFORT/100 (stale — authoritative role profile overrides)
      addResourceType(rtId, 'Auth CP RT', 2, {
        allocationMode: 'EFFORT',
        allocationPercent: 100,
      })

      // Authoritative role profile: CAPACITY_PROFILE with multiple segments
      const now = new Date()
      storeRef.current.capacityProfiles.push({
        id: roleProfileId,
        projectId,
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'CAPACITY_PROFILE',
        source: 'SQUAD_PLANNER',
        defaultPercent: 90,
        startWeek: null,
        endWeek: null,
        legacy: null,
        createdAt: now,
        updatedAt: now,
      })
      storeRef.current.capacitySegments.push(
        { id: roleSeg1, capacityProfileId: roleProfileId, startWeek: 2, endWeek: 4, capacityPercent: 100, source: 'SQUAD_PLANNER', createdAt: now, updatedAt: now },
        { id: roleSeg2, capacityProfileId: roleProfileId, startWeek: 5, endWeek: 7, capacityPercent: 50, source: 'SQUAD_PLANNER', createdAt: now, updatedAt: now },
      )

      // Inherited NR: matches effective CAPACITY_PLAN state (projected from role profile)
      addNamedResource(inhNrId, 'Inherited CP', rtId, {
        allocationMode: 'CAPACITY_PLAN', allocationPercent: 75, allocationPct: 75,
        allocationStartWeek: 2, allocationEndWeek: 7,
      })

      // Protected NR: custom profile with segments
      addNamedResource(protNrId, 'Protected CP', rtId, {
        allocationMode: 'TIMELINE', allocationPercent: 60, allocationPct: 60,
        allocationStartWeek: 3, allocationEndWeek: 6,
      })
      storeRef.current.capacityProfiles.push({
        id: protProfId,
        projectId,
        namedResourceId: protNrId,
        ownerKind: 'NAMED_PERSON',
        planningBasis: 'AVAILABILITY_WINDOW',
        source: 'MANUAL',
        defaultPercent: 60,
        startWeek: 3,
        endWeek: 6,
        legacy: null,
        createdAt: now,
        updatedAt: now,
      })
      const protSeg1 = 'cp-auth-prot-seg-1'
      storeRef.current.capacitySegments.push(
        { id: protSeg1, capacityProfileId: protProfId, startWeek: 3, endWeek: 6, capacityPercent: 60, source: 'MANUAL', createdAt: now, updatedAt: now },
      )

      // Snapshot protected NR state before mutation
      const beforeProtNR = JSON.parse(JSON.stringify(
        storeRef.current.namedResources.find((nr: any) => nr.id === protNrId),
      ))
      const beforeProtProf = JSON.parse(JSON.stringify(
        storeRef.current.capacityProfiles.find((p: any) => p.id === protProfId),
      ))
      const beforeProtSegs = JSON.parse(JSON.stringify(
        storeRef.current.capacitySegments.filter((s: any) => s.capacityProfileId === protProfId),
      ))

      // PATCH count upward: 2 → 3
      const res = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 3 })
      expect(res.status).toBe(200)

      // ── Role exited to manual scheduling despite stale RT legacy ──
      const updatedRT = storeRef.current.resourceTypes.find((r: any) => r.id === rtId)
      expect(updatedRT!.allocationMode).toBe('TIMELINE')
      expect(updatedRT!.allocationPercent).toBe(100)
      expect(updatedRT!.allocationStartWeek).toBeNull()
      expect(updatedRT!.allocationEndWeek).toBeNull()

      // Exactly one manual role profile — old CAPACITY_PROFILE replaced
      const roleProfiles = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(roleProfiles.length).toBe(1)
      expect(roleProfiles[0].planningBasis).not.toBe('CAPACITY_PROFILE')
      expect(roleProfiles[0].planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(roleProfiles[0].defaultPercent).toBe(100)

      // Old role segments not retained as active template
      const oldRoleSegs = storeRef.current.capacitySegments.filter(
        (s: any) => s.capacityProfileId === roleProfileId,
      )
      expect(oldRoleSegs.length).toBe(0)

      // ── Inherited NR transitioned ──
      const inhNR = storeRef.current.namedResources.find((nr: any) => nr.id === inhNrId)
      expect(inhNR).toBeDefined()
      expect(inhNR!.allocationMode).toBe('TIMELINE')
      expect(inhNR!.allocationPercent).toBe(100)
      expect(inhNR!.allocationPct).toBe(100)
      expect(inhNR!.allocationStartWeek).toBeNull()
      expect(inhNR!.allocationEndWeek).toBeNull()
      expect(inhNR!.startWeek).toBeNull()
      expect(inhNR!.endWeek).toBeNull()

      // ── Protected NR unchanged ──
      const afterProtNR = storeRef.current.namedResources.find((nr: any) => nr.id === protNrId)
      expect(JSON.stringify(afterProtNR)).toBe(JSON.stringify(beforeProtNR))
      const afterProtProf = storeRef.current.capacityProfiles.find((p: any) => p.id === protProfId)
      expect(JSON.stringify(afterProtProf)).toBe(JSON.stringify(beforeProtProf))
      const afterProtSegs = storeRef.current.capacitySegments.filter(
        (s: any) => s.capacityProfileId === protProfId,
      )
      expect(JSON.stringify(afterProtSegs)).toBe(JSON.stringify(beforeProtSegs))

      // ── New NR exists ──
      const allNRs = storeRef.current.namedResources.filter((nr: any) => nr.resourceTypeId === rtId)
      expect(allNRs.length).toBe(3)
      const newNR = allNRs.find((nr: any) => nr.id !== inhNrId && nr.id !== protNrId)
      expect(newNR).toBeDefined()

      // ── New NR is TIMELINE/100 with null windows ──
      expect(newNR!.allocationMode).toBe('TIMELINE')
      expect(newNR!.allocationPercent).toBe(100)
      expect(newNR!.allocationPct).toBe(100)
      expect(newNR!.allocationStartWeek).toBeNull()
      expect(newNR!.allocationEndWeek).toBeNull()
      expect(newNR!.startWeek).toBeNull()
      expect(newNR!.endWeek).toBeNull()

      // ── New NR does NOT receive CAPACITY_PROFILE ──
      const newNRProfile = storeRef.current.capacityProfiles.find(
        (p: any) => p.namedResourceId === newNR!.id,
      )
      expect(newNRProfile).toBeDefined()
      expect(newNRProfile!.planningBasis).not.toBe('CAPACITY_PROFILE')
      // Should be scalar manual (AVAILABILITY_WINDOW or DEMAND_FOLLOWING)
      expect(newNRProfile!.planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(newNRProfile!.defaultPercent).toBe(100)

      // ── New NR has no cloned segments ──
      const newNRSegments = storeRef.current.capacitySegments.filter(
        (s: any) => s.capacityProfileId === newNRProfile!.id,
      )
      expect(newNRSegments.length).toBe(0)

      // ── GET reports new NR as manually scheduled ──
      const getRes = await request(app)
        .get(`/api/projects/${projectId}/capacity-profiles`)
        .set('Authorization', authHeader)
      expect(getRes.status).toBe(200)
      const profiles = getRes.body.capacityProfiles
      expect(Array.isArray(profiles)).toBe(true)
      const nrDTOs = profiles.filter(
        (p: any) => p.owner?.kind === 'namedPerson' && p.owner?.id === newNR!.id,
      )
      expect(nrDTOs.length).toBe(1)
      expect(nrDTOs[0].planningBasis).toBe('availabilityWindow')
      expect(nrDTOs[0].defaultPercent).toBe(100)
      expect(nrDTOs[0].segments).toBeDefined()
      expect(nrDTOs[0].segments.length).toBe(0)
    })

    // ── Blocker 4 (extension): GET capacity-profiles returns correct EFFORT/70 ──
    it('GET capacity-profiles returns correct EFFORT/70 ownership and capacity for new NR after count increase', async () => {
      storeRef.current = createStore()
      const rtId = 'cp-get-rt'
      const roleProfileId = 'cp-get-role'

      addResourceType(rtId, 'CPGet RT', 1, {
        allocationMode: 'EFFORT', allocationPercent: 70,
      })
      addNamedResource('cp-get-nr-1', 'CPGet Existing', rtId, {
        allocationMode: 'EFFORT', allocationPercent: 70, allocationPct: 70,
      })
      storeRef.current.capacityProfiles.push({
        id: roleProfileId,
        projectId,
        resourceTypeId: rtId,
        namedResourceId: null,
        ownerKind: 'ROLE',
        planningBasis: 'DEMAND_FOLLOWING',
        source: 'FIXED',
        defaultPercent: 70,
        startWeek: null,
        endWeek: null,
        legacy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

      await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${rtId}`)
        .set('Authorization', authHeader)
        .send({ count: 2 })

      // GET /api/projects/:projectId/capacity-profiles (via GET resource-type? or project?)
      // Use the capacity-profiles route to verify the DTO
      const getRes = await request(app)
        .get(`/api/projects/${projectId}/capacity-profiles`)
        .set('Authorization', authHeader)
      expect(getRes.status).toBe(200)
      // Debug: check store has role profile with the right ID
      const roleInStore = storeRef.current.capacityProfiles.filter(
        (p: any) => p.resourceTypeId === rtId && p.namedResourceId === null,
      )
      expect(roleInStore.length).toBe(1)
      expect(roleInStore[0].id).toBe(roleProfileId)
      const profiles = getRes.body.capacityProfiles
      expect(Array.isArray(profiles)).toBe(true)

      const newNR = storeRef.current.namedResources.find(
        (nr: any) => nr.id !== 'cp-get-nr-1' && nr.resourceTypeId === rtId,
      )
      expect(newNR).toBeDefined()

      // The DTO uses owner.kind/owner.id instead of raw namedResourceId/resourceTypeId
      const nrProfiles = profiles.filter(
        (p: any) => p.owner?.kind === 'namedPerson' && p.owner?.id === newNR!.id,
      )
      expect(nrProfiles.length).toBeGreaterThanOrEqual(1)
      expect(nrProfiles[0].defaultPercent).toBe(70)
      expect(nrProfiles[0].planningBasis).toBe('demandFollowing')

      // Role profile still present
      const roleInDTO = profiles.filter(
        (p: any) => p.owner?.kind === 'role' && p.owner?.id === rtId,
      )
      expect(roleInDTO.length).toBe(1)
      expect(roleInDTO[0].id).toBe(roleProfileId)
      expect(roleInDTO[0].defaultPercent).toBe(70)
    })
  })

  describe('13. Capacity-edit protection guard (PROFILE_MANAGED_CAPACITY)', () => {
    const guardRtId = 'rt-guard-1'
    const guardNrId = 'nr-guard-1'
    const guardCpId = 'cp-guard-1'
    const scalarNrId = 'nr-scalar-1'
    const scalarCpId = 'cp-scalar-1'

    beforeEach(() => {
      addResourceType(guardRtId, 'Guard RT', 2)
      // Segmented named person (protected)
      addNamedResource(guardNrId, 'Guard Person', guardRtId, {
        allocationMode: 'TIMELINE', allocationPercent: 50, allocationPct: 50,
        allocationStartWeek: 2, allocationEndWeek: 8, startWeek: 2, endWeek: 8,
      })
      addPersistedProfile(guardCpId, {
        namedResourceId: guardNrId, ownerKind: 'NAMED_PERSON',
        planningBasis: 'AVAILABILITY_WINDOW', source: 'MANUAL',
        defaultPercent: 50, startWeek: 2, endWeek: 8,
      })
      storeRef.current.capacitySegments.push(
        { id: 'cseg-guard-a', capacityProfileId: guardCpId, startWeek: 2, endWeek: 4, capacityPercent: 100, source: 'MANUAL', createdAt: new Date(), updatedAt: new Date() },
        { id: 'cseg-guard-b', capacityProfileId: guardCpId, startWeek: 5, endWeek: 8, capacityPercent: 50, source: 'MANUAL', createdAt: new Date(), updatedAt: new Date() },
      )
      // Scalar-safe named person (not protected)
      addNamedResource(scalarNrId, 'Scalar Person', guardRtId, {
        allocationMode: 'TIMELINE', allocationPercent: 60, allocationPct: 60,
        allocationStartWeek: 3, allocationEndWeek: 9, startWeek: 3, endWeek: 9,
      })
      addPersistedProfile(scalarCpId, {
        namedResourceId: scalarNrId, ownerKind: 'NAMED_PERSON',
        planningBasis: 'AVAILABILITY_WINDOW', source: 'MANUAL',
        defaultPercent: 60, startWeek: 3, endWeek: 9,
      })
      // Scalar-safe named person — segmentless, not protected
      // No segment entries added to capacitySegments for this profile
      // Set a distinguishable weekly demand cache value to prove it is unchanged by rejection
      storeRef.current.project.weeklyDemandCache = { week0: { hours: 40 } }
    })

    it('capacity PUT on segmented named person returns 409 and does not change state', async () => {
      const before = JSON.parse(JSON.stringify(storeRef.current))

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${guardRtId}/named-resources/${guardNrId}`)
        .set('Authorization', authHeader)
        .send({ allocationPercent: 75, startWeek: 0, endWeek: 10 })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')

      const after = JSON.parse(JSON.stringify(storeRef.current))
      expect(after).toEqual(before)
    })

    it('capacity PATCH on segmented named person returns 409 and does not change state', async () => {
      const before = JSON.parse(JSON.stringify(storeRef.current))

      const res = await request(app)
        .patch(`/api/projects/${projectId}/resource-types/${guardRtId}/named-resources/${guardNrId}`)
        .set('Authorization', authHeader)
        .send({ allocationPercent: 50 })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')

      const after = JSON.parse(JSON.stringify(storeRef.current))
      expect(after).toEqual(before)
    })

    it('name-only PUT on segmented named person succeeds and changes only the name', async () => {

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${guardRtId}/named-resources/${guardNrId}`)
        .set('Authorization', authHeader)
        .send({ name: 'Renamed Person' })

      expect(res.status).toBe(200)
      expect(res.body.name).toBe('Renamed Person')

      // Named resource name changed
      const nr = storeRef.current.namedResources.find((n: any) => n.id === guardNrId)
      expect(nr.name).toBe('Renamed Person')
      // Other NR fields unchanged
      expect(nr.pricingModel).toBe('ACTUAL_DAYS')
      expect(nr.allocationMode).toBe('TIMELINE')
      expect(nr.allocationPercent).toBe(50)
      expect(nr.startWeek).toBe(2)
      expect(nr.endWeek).toBe(8)
      // Profile unchanged
      const profile = storeRef.current.capacityProfiles.find((p: any) => p.id === guardCpId)
      expect(profile.defaultPercent).toBe(50)
      expect(profile.planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(profile.ownerKind).toBe('NAMED_PERSON')
      // Segments unchanged (count and order)
      const segments = storeRef.current.capacitySegments.filter((s: any) => s.capacityProfileId === guardCpId)
      expect(segments).toHaveLength(2)
      expect(segments[0].startWeek).toBe(2)
      expect(segments[0].endWeek).toBe(4)
      expect(segments[1].startWeek).toBe(5)
      expect(segments[1].endWeek).toBe(8)
      // Weekly demand cache cleared after successful transaction
      expect(storeRef.current.project.weeklyDemandCache).toEqual({})
    })

    it('pricing-only PUT on segmented named person succeeds and changes only pricing', async () => {
      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${guardRtId}/named-resources/${guardNrId}`)
        .set('Authorization', authHeader)
        .send({ pricingModel: 'PRO_RATA' })

      expect(res.status).toBe(200)
      expect(res.body.pricingModel).toBe('PRO_RATA')

      // Name unchanged
      const nr = storeRef.current.namedResources.find((n: any) => n.id === guardNrId)
      expect(nr.pricingModel).toBe('PRO_RATA')
      expect(nr.name).toBe('Guard Person')
      // Profile unchanged
      const profile = storeRef.current.capacityProfiles.find((p: any) => p.id === guardCpId)
      expect(profile.defaultPercent).toBe(50)
      // Segments unchanged
      const segments = storeRef.current.capacitySegments.filter((s: any) => s.capacityProfileId === guardCpId)
      expect(segments).toHaveLength(2)
      // Weekly demand cache cleared after successful transaction
      expect(storeRef.current.project.weeklyDemandCache).toEqual({})
    })

    it('scalar-safe PUT on segmentless named person writes capacity and updates compatibility fields', async () => {
      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${guardRtId}/named-resources/${scalarNrId}`)
        .set('Authorization', authHeader)
        .send({ startWeek: 4, endWeek: 9, allocationPct: 70 })

      expect(res.status).toBe(200)

      // Compatibility fields updated
      const nr = storeRef.current.namedResources.find((n: any) => n.id === scalarNrId)
      expect(nr.startWeek).toBe(4)
      expect(nr.endWeek).toBe(9)
      expect(nr.allocationPct).toBe(70)
      expect(nr.allocationPercent).toBe(70)
      expect(nr.allocationStartWeek).toBe(4)
      expect(nr.allocationEndWeek).toBe(9)
      // Weekly demand cache cleared
      expect(storeRef.current.project.weeklyDemandCache).toEqual({})
    })

    it('rejected mixed-field PUT on segmented named person rolls back all changes, including non-capacity fields', async () => {
      const before = JSON.parse(JSON.stringify(storeRef.current))

      // Send PUT containing both non-capacity fields AND scalar capacity: all must be rejected
      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${guardRtId}/named-resources/${guardNrId}`)
        .set('Authorization', authHeader)
        .send({
          name: 'Must Roll Back',
          pricingModel: 'PRO_RATA',
          allocationPercent: 75,
          startWeek: 2,
          endWeek: 10,
        })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')

      // Exact state preservation: nothing changed
      const after = JSON.parse(JSON.stringify(storeRef.current))
      expect(after).toEqual(before)
    })

    it('capacity PUT on segmentless CAPACITY_PROFILE named person returns 409', async () => {
      const capProfNrId = 'nr-capacity-profile-1'
      const capProfCpId = 'cp-capacity-profile-1'

      addNamedResource(capProfNrId, 'Capacity Profile Person', guardRtId, {
        allocationMode: 'CAPACITY_PROFILE', allocationPercent: 100, allocationPct: 100,
        allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null,
      })
      addPersistedProfile(capProfCpId, {
        namedResourceId: capProfNrId, ownerKind: 'NAMED_PERSON',
        planningBasis: 'CAPACITY_PROFILE', source: 'MANUAL',
      })

      const before = JSON.parse(JSON.stringify(storeRef.current))

      const res = await request(app)
        .put(`/api/projects/${projectId}/resource-types/${guardRtId}/named-resources/${capProfNrId}`)
        .set('Authorization', authHeader)
        .send({ allocationPercent: 80, startWeek: 1 })

      expect(res.status).toBe(409)
      expect(res.body.code).toBe('PROFILE_MANAGED_CAPACITY')

      const after = JSON.parse(JSON.stringify(storeRef.current))
      expect(after).toEqual(before)
    })
  })

  })
