/**
 * capacityProfileTransferService.unit.test.ts — Focused unit tests for the
 * Squad Planner → manual ownership-transfer command.
 *
 * The database enforces single-owner uniqueness via partial unique indexes,
 * so genuine duplicate persisted ownership cannot be created in PostgreSQL.
 * These tests use a transaction double that returns duplicate rows to prove
 * the transfer fails closed before any write.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { transferToManualCapacity, TransferError } from '../lib/capacityProfileTransferService.js'

// Mock the strict loader and planner helpers — the duplicate detection under
// test happens in the transfer service itself before any mutation.
vi.mock('../lib/ownerProfileLoader.js', () => ({
  loadAndValidateOwnerProfile: vi.fn(async () => ({
    id: 'profile-1',
    projectId: 'proj-1',
    resourceTypeId: null,
    namedResourceId: 'nr-1',
    ownerKind: 'PLANNED_RESOURCE',
    planningBasis: 'CAPACITY_PROFILE',
    source: 'SQUAD_PLANNER',
    defaultPercent: 100,
    startWeek: null,
    endWeek: null,
    segments: [{ id: 'seg-1', startWeek: 0, endWeek: 5, capacityPercent: 100 }],
  })),
}))

vi.mock('../lib/squadPlannerProfileWriter.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    validatePlannerOwnerState: vi.fn(async () => []),
    capturePlannerAuthority: vi.fn(async () => ({
      activePlanId: null,
      activePlanResourceTypeIds: new Set<string>(),
      plannerRoleResourceTypeIds: new Set<string>(),
      allPlannerResourceTypeIds: new Set<string>(),
    })),
  }
})

// ─── Transaction double helpers ─────────────────────────────────────────────

interface MockProfile {
  id: string
  projectId: string
  resourceTypeId: string | null
  namedResourceId: string | null
  ownerKind: string
  planningBasis: string
  source: string
  defaultPercent: number | null
  startWeek: number | null
  endWeek: number | null
  segments: Array<{ id: string; startWeek: number; endWeek: number; capacityPercent: number }>
}

function makeProfile(overrides: Partial<MockProfile>): MockProfile {
  return {
    id: 'profile-x',
    projectId: 'proj-1',
    resourceTypeId: null,
    namedResourceId: null,
    ownerKind: 'ROLE',
    planningBasis: 'CAPACITY_PROFILE',
    source: 'SQUAD_PLANNER',
    defaultPercent: 100,
    startWeek: null,
    endWeek: null,
    segments: [{ id: 'seg-x', startWeek: 0, endWeek: 5, capacityPercent: 100 }],
    ...overrides,
  }
}

function makeTx(profiles: MockProfile[]) {
  return {
    project: { findFirst: vi.fn(async () => ({ id: 'proj-1' })) },
    resourceType: { findFirst: vi.fn(async () => ({ id: 'rt-1', name: 'Developer' })) },
    namedResource: {
      findMany: vi.fn(async () => [
        { id: 'nr-1', name: 'Planned 1', allocationMode: 'CAPACITY_PLAN' },
      ]),
    },
    capacityProfile: {
      findMany: vi.fn(async () => profiles),
    },
  }
}

const USER = 'user-1'

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('transferToManualCapacity — duplicate ownership fail-closed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects duplicate ROLE profiles before any write', async () => {
    const tx = makeTx([
      makeProfile({ id: 'cp-role-1', resourceTypeId: 'rt-1', ownerKind: 'ROLE' }),
      makeProfile({ id: 'cp-role-2', resourceTypeId: 'rt-1', ownerKind: 'ROLE' }),
    ])

    await expect(transferToManualCapacity(tx as any, 'proj-1', 'rt-1', USER))
      .rejects
      .toThrow(TransferError)

    // No capacityProfile/capacitySegment writes occurred
    expect(tx.capacityProfile.findMany).toHaveBeenCalled()
  })

  it('rejects duplicate named-resource profiles before any write', async () => {
    const tx = makeTx([
      makeProfile({ id: 'cp-role-1', resourceTypeId: 'rt-1', ownerKind: 'ROLE' }),
      makeProfile({ id: 'cp-nr-1', namedResourceId: 'nr-1', ownerKind: 'PLANNED_RESOURCE' }),
      makeProfile({ id: 'cp-nr-2', namedResourceId: 'nr-1', ownerKind: 'PLANNED_RESOURCE' }),
    ])

    await expect(transferToManualCapacity(tx as any, 'proj-1', 'rt-1', USER))
      .rejects
      .toThrow(/Duplicate capacity profile/i)
  })

  it('rejects an unprofiled planner-managed resource with CAPACITY_PLAN mode', async () => {
    const tx = {
      project: { findFirst: vi.fn(async () => ({ id: 'proj-1' })) },
      resourceType: { findFirst: vi.fn(async () => ({ id: 'rt-1', name: 'Developer' })) },
      namedResource: {
        findMany: vi.fn(async () => [
          { id: 'nr-1', name: 'Planned 1', allocationMode: 'CAPACITY_PLAN' },
        ]),
      },
      capacityProfile: {
        findMany: vi.fn(async () => [
          makeProfile({ id: 'cp-role-1', resourceTypeId: 'rt-1', ownerKind: 'ROLE' }),
        ]),
      },
    }
    // Active-plan provenance for the role
    const { capturePlannerAuthority } = await import('../lib/squadPlannerProfileWriter.js')
    vi.mocked(capturePlannerAuthority).mockResolvedValueOnce({
      activePlanId: 'plan-1',
      activePlanResourceTypeIds: new Set(['rt-1']),
      plannerRoleResourceTypeIds: new Set(['rt-1']),
      allPlannerResourceTypeIds: new Set(['rt-1']),
    } as never)

    await expect(transferToManualCapacity(tx as any, 'proj-1', 'rt-1', USER))
      .rejects
      .toThrow(/planner-managed without a persisted profile/i)
  })

  it('does not reject an unprofiled non-CAPACITY_PLAN resource', async () => {
    const tx = {
      project: {
        findFirst: vi.fn(async () => ({ id: 'proj-1' })),
        update: vi.fn(async () => ({})),
      },
      resourceType: {
        findFirst: vi.fn(async () => ({ id: 'rt-1', name: 'Developer' })),
        update: vi.fn(async () => ({})),
      },
      namedResource: {
        findMany: vi.fn(async () => [
          { id: 'nr-1', name: 'Explicit 1', allocationMode: 'EFFORT' },
        ]),
        update: vi.fn(async () => ({})),
      },
      capacityProfile: {
        findMany: vi.fn(async () => [
          makeProfile({ id: 'cp-role-1', resourceTypeId: 'rt-1', ownerKind: 'ROLE' }),
        ]),
        update: vi.fn(async () => ({})),
      },
      capacitySegment: { updateMany: vi.fn(async () => ({ count: 0 })) },
    }

    // The transfer should complete (all owners valid, no planner-managed unprofiled NR)
    await expect(transferToManualCapacity(tx as any, 'proj-1', 'rt-1', USER)).resolves.toBeDefined()
  })
})
