/**
 * capacityProfileProvenanceSnapshots.integration.test.ts — Real PostgreSQL
 * tests for the issue #405 snapshot evolution (V4 restore translation and
 * V5 create/restore round-trip).
 *
 * Scenario A — V4 historical restore: a stored V4 snapshot whose
 * capacityProfiles carry each behaviourally relevant pre-#405 legacy payload
 * restores with the equivalent explicit provenance (same rules as the #405
 * database migration). Projection-only/unknown JSON restores as NULL; the
 * removed legacy column is never recreated.
 *
 * Scenario B — V5 create/restore round-trip: a current snapshot (schema
 * version 5) persists all four provenance values plus NULL directly and
 * restores them verbatim.
 *
 * V1/V2/V3 remain non-restorable (covered by the existing snapshot
 * retirement suite); this suite only exercises the V4→V5 contract.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Prisma, PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { app } from '../app.js'
import { buildSnapshot } from '../lib/projectSnapshotService.js'
import { rollbackProjectSnapshot } from '../lib/projectSnapshotService.js'
import type { SnapshotV4 } from '../lib/projectSnapshotTypes.js'

// Integration runs use the real Prisma client (setup.ts mocks it for unit runs).
vi.mock('../lib/prisma.js', async (importOriginal) => {
  return await importOriginal()
})

const runIntegration = process.env.INTEGRATION_TEST === 'true'
const describeIf = runIntegration ? describe : describe.skip

let prisma: PrismaClient
let authHeader: string
let userId: string

beforeAll(async () => {
  if (!runIntegration) return
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required for integration tests. '
      + 'Set INTEGRATION_TEST=true and DATABASE_URL to a running PostgreSQL 15 instance.',
    )
  }
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })
  await prisma.$connect()
  const email = `provenance-snap-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@example.com`
  const user = await prisma.user.create({
    data: { email, name: 'Snapshot Provenance', password: 'test-hash' },
  })
  userId = user.id
  const token = jwt.sign({ userId: user.id, role: 'USER' }, process.env.JWT_SECRET!)
  authHeader = `Bearer ${token}`
})

afterAll(async () => {
  if (!runIntegration || !prisma) return
  if (userId) {
    await prisma.project.deleteMany({ where: { ownerId: userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
  }
  await prisma.$disconnect()
})

async function createProject(): Promise<string> {
  const res = await request(app)
    .post('/api/projects')
    .set('Authorization', authHeader)
    .send({ name: 'Provenance Snapshot' })
  expect(res.status).toBe(201)
  return res.body.id as string
}

async function createResourceType(projectId: string, name: string): Promise<string> {
  const res = await request(app)
    .post(`/api/projects/${projectId}/resource-types`)
    .set('Authorization', authHeader)
    .send({ name, category: 'ENGINEERING', count: 1 })
  expect(res.status).toBe(201)
  return res.body.id as string
}

async function createNamedResource(projectId: string, rtId: string, name: string): Promise<string> {
  const res = await request(app)
    .post(`/api/projects/${projectId}/resource-types/${rtId}/named-resources`)
    .set('Authorization', authHeader)
    .send({ name })
  expect(res.status).toBe(201)
  return res.body.id as string
}

/** Minimal V4 snapshot payload scaffold sharing the live project identity. */
async function buildV4Payload(
  rtIds: Array<{ id: string; name: string }>,
  nrIds: Array<{ id: string; name: string; resourceTypeId: string }>,
  capacityProfiles: SnapshotV4['capacityProfiles'],
): Promise<SnapshotV4> {
  return {
    schemaVersion: 4,
    epics: [],
    project: null,
    resourceTypes: rtIds.map(rt => ({
      id: rt.id, name: rt.name, category: 'ENGINEERING' as const,
      count: nrIds.filter(nr => nr.resourceTypeId === rt.id).length,
      hoursPerDay: null, dayRate: null, globalTypeId: null,
    })),
    namedResources: nrIds.map(nr => ({
      id: nr.id, resourceTypeId: nr.resourceTypeId, name: nr.name,
      pricingModel: 'ACTUAL_DAYS',
    })),
    timelineEntries: [],
    storyTimelineEntries: [],
    epicDependencies: [],
    featureDependencies: [],
    overheadItems: [],
    capacityProfiles,
  }
}

describeIf('capacity-profile provenance snapshot evolution (#405)', () => {
  it('V4 restore translates recognised legacy provenance and discards the rest', async () => {
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, 'V4 Restore Role')
    const rtBId = await createResourceType(projectId, 'V4 Restore Role B')
    const nrClone = await createNamedResource(projectId, rtId, 'Clone')
    const nrOpt = await createNamedResource(projectId, rtId, 'Optimised')
    const nrPlanned = await createNamedResource(projectId, rtId, 'Planned')
    const nrMapper = await createNamedResource(projectId, rtId, 'Mapper')
    const nrEditor = await createNamedResource(projectId, rtBId, 'Edited')
    const nrUnknown = await createNamedResource(projectId, rtBId, 'Unknown')

    const v4: SnapshotV4 = await buildV4Payload([
      { id: rtId, name: 'V4 Restore Role' },
      { id: rtBId, name: 'V4 Restore Role B' },
    ], [
      { id: nrClone, name: 'Clone', resourceTypeId: rtId },
      { id: nrOpt, name: 'Optimised', resourceTypeId: rtId },
      { id: nrPlanned, name: 'Planned', resourceTypeId: rtId },
      { id: nrMapper, name: 'Mapper', resourceTypeId: rtId },
      { id: nrEditor, name: 'Edited', resourceTypeId: rtBId },
      { id: nrUnknown, name: 'Unknown', resourceTypeId: rtBId },
    ], [
      // ROLE_DEFAULT clone payload
      {
        id: 'v4-clone', ownerKind: 'NAMED_PERSON', resourceTypeId: null, namedResourceId: nrClone,
        planningBasis: 'AVAILABILITY_WINDOW', source: 'DERIVED',
        defaultPercent: 100, startWeek: null, endWeek: null,
        legacy: { kind: 'VALUE', value: { version: 1, writer: 'ROLE_DEFAULT' } },
        segments: [],
      },
      // RESOURCE_OPTIMISER payload
      {
        id: 'v4-opt', ownerKind: 'NAMED_PERSON', resourceTypeId: null, namedResourceId: nrOpt,
        planningBasis: 'AVAILABILITY_WINDOW', source: 'DERIVED',
        defaultPercent: 60, startWeek: 2, endWeek: 10,
        legacy: { kind: 'VALUE', value: { version: 1, writer: 'RESOURCE_OPTIMISER' } },
        segments: [],
      },
      // transferred planned-resource payload
      {
        id: 'v4-transfer', ownerKind: 'PLANNED_RESOURCE', resourceTypeId: null, namedResourceId: nrPlanned,
        planningBasis: 'CAPACITY_PROFILE', source: 'MANUAL',
        defaultPercent: 100, startWeek: 0, endWeek: 10,
        legacy: { kind: 'VALUE', value: { version: 1, writer: 'transfer-to-manual' } },
        segments: [],
      },
      // strict mapper NAMED payload (EFFORT pair)
      {
        id: 'v4-mapper', ownerKind: 'NAMED_PERSON', resourceTypeId: null, namedResourceId: nrMapper,
        planningBasis: 'DEMAND_FOLLOWING', source: 'FIXED',
        defaultPercent: 100, startWeek: null, endWeek: null,
        legacy: {
          kind: 'VALUE',
          value: {
            allocationMode: 'EFFORT', allocationPercent: 100, allocationPct: 100,
            allocationStartWeek: null, allocationEndWeek: null, startWeek: null, endWeek: null,
          },
        },
        segments: [],
      },
      // projection-only payload → NULL
      {
        id: 'v4-editor', ownerKind: 'NAMED_PERSON', resourceTypeId: null, namedResourceId: nrEditor,
        planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL',
        defaultPercent: 100, startWeek: null, endWeek: null,
        legacy: { kind: 'VALUE', value: { version: 1, writer: 'manual-editor' } },
        segments: [],
      },
      // unknown JSON → NULL
      {
        id: 'v4-unknown', ownerKind: 'NAMED_PERSON', resourceTypeId: null, namedResourceId: nrUnknown,
        planningBasis: 'DEMAND_FOLLOWING', source: 'MANUAL',
        defaultPercent: 80, startWeek: null, endWeek: null,
        legacy: { kind: 'VALUE', value: { foo: 'bar' } },
        segments: [],
      },
    ])

    const snap = await prisma.backlogSnapshot.create({
      data: {
        projectId, label: 'v4 provenance fixture', trigger: 'manual',
        snapshot: v4 as unknown as Prisma.InputJsonObject, createdById: userId,
      },
    })

    await rollbackProjectSnapshot({ projectId, snapshotId: snap.id, userId, db: prisma })

    const rows = await prisma.capacityProfile.findMany({
      where: { projectId },
      select: { id: true, provenance: true },
      orderBy: { id: 'asc' },
    })
    const byId = new Map(rows.map(r => [r.id, r.provenance]))
    expect(byId.get('v4-clone')).toBe('ROLE_DEFAULT')
    expect(byId.get('v4-opt')).toBe('RESOURCE_OPTIMISER')
    expect(byId.get('v4-transfer')).toBe('TRANSFERRED_FROM_SQUAD_PLANNER')
    expect(byId.get('v4-mapper')).toBe('LEGACY_MAPPER')
    expect(byId.get('v4-editor')).toBeNull()
    expect(byId.get('v4-unknown')).toBeNull()

    // The removed column is never recreated
    const legacyCols = await prisma.$queryRaw<Array<{ column_name: string }>>(
      Prisma.sql`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'CapacityProfile' AND column_name = 'legacy'`,
    )
    expect(legacyCols).toHaveLength(0)
  })

  it('V5 create/restore round-trips all four provenance values and null', async () => {
    const projectId = await createProject()
    const rtId = await createResourceType(projectId, 'V5 Roundtrip Role')
    // Create the named resources directly (no role-default clone profiles)
    const nrA = await prisma.namedResource.create({ data: { name: 'A', resourceTypeId: rtId } }).then(r => r.id)
    const nrB = await prisma.namedResource.create({ data: { name: 'B', resourceTypeId: rtId } }).then(r => r.id)
    const nrC = await prisma.namedResource.create({ data: { name: 'C', resourceTypeId: rtId } }).then(r => r.id)
    const nrD = await prisma.namedResource.create({ data: { name: 'D', resourceTypeId: rtId } }).then(r => r.id)
    const nrE = await prisma.namedResource.create({ data: { name: 'E', resourceTypeId: rtId } }).then(r => r.id)

    // Author profiles with every provenance value plus null
    const profileSpecs: Array<{ nr: string; provenance: string | null; source: string; basis: string }> = [
      { nr: nrA, provenance: 'ROLE_DEFAULT', source: 'DERIVED', basis: 'AVAILABILITY_WINDOW' },
      { nr: nrB, provenance: 'RESOURCE_OPTIMISER', source: 'DERIVED', basis: 'AVAILABILITY_WINDOW' },
      { nr: nrC, provenance: 'TRANSFERRED_FROM_SQUAD_PLANNER', source: 'MANUAL', basis: 'CAPACITY_PROFILE' },
      { nr: nrD, provenance: 'LEGACY_MAPPER', source: 'FIXED', basis: 'DEMAND_FOLLOWING' },
      { nr: nrE, provenance: null, source: 'MANUAL', basis: 'DEMAND_FOLLOWING' },
    ]
    for (const spec of profileSpecs) {
      await prisma.capacityProfile.create({
        data: {
          projectId, ownerKind: 'NAMED_PERSON', resourceTypeId: null, namedResourceId: spec.nr,
          planningBasis: spec.basis as never, source: spec.source as never,
          defaultPercent: 100, startWeek: null, endWeek: null,
          provenance: spec.provenance as never,
        },
      })
    }

    // Current snapshot creation is V5
    const snapshot = await buildSnapshot(projectId, prisma)
    expect(snapshot.schemaVersion).toBe(5)
    const snap = await prisma.backlogSnapshot.create({
      data: {
        projectId, label: 'v5 provenance round-trip', trigger: 'manual',
        snapshot: snapshot as unknown as Prisma.InputJsonObject, createdById: userId,
      },
    })

    // Disturb the profiles, then restore the V5 snapshot
    await prisma.capacityProfile.updateMany({
      where: { projectId },
      data: { provenance: 'LEGACY_MAPPER' },
    })
    await rollbackProjectSnapshot({ projectId, snapshotId: snap.id, userId, db: prisma })

    const rows = await prisma.capacityProfile.findMany({
      where: { projectId, namedResourceId: { not: null } },
      select: { namedResourceId: true, provenance: true },
      orderBy: { namedResourceId: 'asc' },
    })
    const byNr = new Map(rows.map(r => [r.namedResourceId, r.provenance]))
    expect(byNr.get(nrA)).toBe('ROLE_DEFAULT')
    expect(byNr.get(nrB)).toBe('RESOURCE_OPTIMISER')
    expect(byNr.get(nrC)).toBe('TRANSFERRED_FROM_SQUAD_PLANNER')
    expect(byNr.get(nrD)).toBe('LEGACY_MAPPER')
    expect(byNr.get(nrE)).toBeNull()
  })
})
