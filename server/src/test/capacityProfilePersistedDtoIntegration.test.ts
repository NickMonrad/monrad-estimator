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
    return arr.filter(r => entries.every(([k, v]) => r[k] === v))
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
      let profiles = store.capacityProfiles
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
      const before = (store() as any)[arrKey].length
      ;(store() as any)[arrKey] = (store() as any)[arrKey].filter(
        (r: any) => !Object.entries(where).every(([k, v]) => r[k] === v),
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
})
