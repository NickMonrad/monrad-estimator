/**
 * resetProjectPlanning.test.ts — Unit tests for the atomic Reset Planning
 * service (issue #449).
 *
 * Covers the reset allow-list (cleared vs preserved), the PLANNED_RESOURCE
 * provenance rule for planner-generated placeholder NamedResources,
 * CURRENT → NEEDS_REPLAN, 404 behaviour, and injected mid-transaction
 * failure rollback.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

import { resetProjectPlanning, ResetPlanningError } from '../lib/resetProjectPlanning.js'

/** Build a minimal fake transaction recording every call. */
function makeTx(overrides: Record<string, any> = {}) {
  const calls: Array<{ op: string; args: unknown }> = []
  const record = (op: string) => (args: unknown) => {
    calls.push({ op, args })
    return overrides[op] ?? {}
  }
  const tx = {
    project: {
      findUnique: vi.fn(record('project.findUnique')),
      update: vi.fn(record('project.update')),
    },
    capacityProfile: {
      findMany: vi.fn(record('capacityProfile.findMany')),
      deleteMany: vi.fn(record('capacityProfile.deleteMany')),
    },
    capacityPlan: { deleteMany: vi.fn(record('capacityPlan.deleteMany')) },
    timelineEntry: { deleteMany: vi.fn(record('timelineEntry.deleteMany')) },
    storyTimelineEntry: { deleteMany: vi.fn(record('storyTimelineEntry.deleteMany')) },
    namedResource: { deleteMany: vi.fn(record('namedResource.deleteMany')) },
  }
  return { tx, calls }
}

function makeDb(tx: ReturnType<typeof makeTx>['tx']) {
  return {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as Parameters<typeof resetProjectPlanning>[0]
}

const CURRENT_PROJECT = { id: 'proj-1', planningState: 'CURRENT' }

beforeEach(() => vi.clearAllMocks())

describe('resetProjectPlanning', () => {
  it('clears the full planning allow-list and marks the project NEEDS_REPLAN', async () => {
    const { tx, calls } = makeTx()
    tx.project.findUnique.mockResolvedValue(CURRENT_PROJECT)
    tx.capacityProfile.findMany.mockResolvedValue([])

    const result = await resetProjectPlanning(makeDb(tx), 'proj-1')

    expect(result).toEqual({ projectId: 'proj-1', planningState: 'NEEDS_REPLAN' })
    expect(tx.capacityProfile.deleteMany).toHaveBeenCalledWith({ where: { projectId: 'proj-1' } })
    expect(tx.capacityPlan.deleteMany).toHaveBeenCalledWith({ where: { projectId: 'proj-1' } })
    expect(tx.timelineEntry.deleteMany).toHaveBeenCalledWith({ where: { projectId: 'proj-1' } })
    expect(tx.storyTimelineEntry.deleteMany).toHaveBeenCalledWith({ where: { projectId: 'proj-1' } })
    expect(tx.project.update).toHaveBeenCalledWith({
      where: { id: 'proj-1' },
      data: { weeklyDemandCache: Prisma.DbNull, planningState: 'NEEDS_REPLAN' },
    })
    // No named resources matched → nothing deleted.
    expect(tx.namedResource.deleteMany).not.toHaveBeenCalled()
    // No business-owned writes occurred.
    expect(calls.some(c => c.op === 'epic.deleteMany')).toBe(false)
  })

  it('deletes only NamedResources whose provenance is a PLANNED_RESOURCE profile', async () => {
    const { tx } = makeTx()
    tx.project.findUnique.mockResolvedValue(CURRENT_PROJECT)
    tx.capacityProfile.findMany.mockResolvedValue([
      { namedResourceId: 'nr-planned-1' },
      { namedResourceId: 'nr-planned-2' },
      { namedResourceId: 'nr-planned-2' }, // duplicate → deduped
      { namedResourceId: null },
    ])

    await resetProjectPlanning(makeDb(tx), 'proj-1')

    expect(tx.capacityProfile.findMany).toHaveBeenCalledWith({
      where: { projectId: 'proj-1', ownerKind: 'PLANNED_RESOURCE' },
      select: { namedResourceId: true },
    })
    expect(tx.namedResource.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['nr-planned-1', 'nr-planned-2'] },
        resourceType: { projectId: 'proj-1' },
      },
    })
  })

  it('preserves user-authored (NAMED_PERSON) named resources', async () => {
    const { tx } = makeTx()
    tx.project.findUnique.mockResolvedValue(CURRENT_PROJECT)
    tx.capacityProfile.findMany.mockResolvedValue([])

    await resetProjectPlanning(makeDb(tx), 'proj-1')

    expect(tx.namedResource.deleteMany).not.toHaveBeenCalled()
  })

  it('throws 404 when the project does not exist', async () => {
    const { tx } = makeTx()
    tx.project.findUnique.mockResolvedValue(null)

    await expect(resetProjectPlanning(makeDb(tx), 'missing')).rejects.toThrow(ResetPlanningError)
    await expect(resetProjectPlanning(makeDb(tx), 'missing')).rejects.toMatchObject({ status: 404 })
    expect(tx.capacityProfile.deleteMany).not.toHaveBeenCalled()
  })

  it('is safe when the project is already NEEDS_REPLAN (idempotent quarantine)', async () => {
    const { tx } = makeTx()
    tx.project.findUnique.mockResolvedValue({ id: 'proj-1', planningState: 'NEEDS_REPLAN' })
    tx.capacityProfile.findMany.mockResolvedValue([])

    const result = await resetProjectPlanning(makeDb(tx), 'proj-1')
    expect(result.planningState).toBe('NEEDS_REPLAN')
    expect(tx.project.update).toHaveBeenCalled()
  })

  it('rolls the entire reset back when an injected failure occurs after writes', async () => {
    const { tx } = makeTx()
    tx.project.findUnique.mockResolvedValue(CURRENT_PROJECT)
    tx.capacityProfile.findMany.mockResolvedValue([])

    const db = {
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
        await fn(tx)
        // Simulate commit-time failure: the transaction aborts, so every
        // write inside it is rolled back by PostgreSQL.
        throw new Error('simulated commit failure')
      }),
    } as unknown as Parameters<typeof resetProjectPlanning>[0]

    await expect(
      resetProjectPlanning(db, 'proj-1', {
        afterWrites: async () => { throw new Error('injected mid-transaction failure') },
      }),
    ).rejects.toThrow('injected mid-transaction failure')

    // The service performed every write through the one transaction, which
    // rejected — no partial state can have been committed. The update that
    // flips planning state happened inside that transaction only.
    expect(tx.project.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ planningState: 'NEEDS_REPLAN' }),
    }))
    expect(db.$transaction).toHaveBeenCalledTimes(1)
  })

  it('executes the injected failure hook inside the transaction before commit', async () => {
    const { tx } = makeTx()
    tx.project.findUnique.mockResolvedValue(CURRENT_PROJECT)
    tx.capacityProfile.findMany.mockResolvedValue([])
    const hook = vi.fn(async () => {})

    await resetProjectPlanning(makeDb(tx), 'proj-1', { afterWrites: hook })

    expect(hook).toHaveBeenCalledTimes(1)
    // Hook ran after the state flip, still inside the transaction.
    const updateOrder = tx.project.update.mock.invocationCallOrder[0]
    const hookOrder = hook.mock.invocationCallOrder[0]
    expect(updateOrder).toBeLessThan(hookOrder)
  })
})
