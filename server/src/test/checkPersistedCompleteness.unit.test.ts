/**
 * checkPersistedCompleteness.unit.test.ts — Focused unit tests for the
 * human-readable completeness findings (issue #456).
 *
 * The completeness assessment keeps the exact same validation semantics
 * (same findings, same fail-closed boundary) while identifying affected
 * resources by their human-readable names, with the internal ID retained
 * only as secondary diagnostic context.
 */

import { describe, it, expect } from 'vitest'
import { checkPersistedCompleteness } from '../lib/persistedCapacityProfileValidation.js'

interface Rt {
  id: string
  name: string
  namedResources: Array<{ id: string; name: string }>
}

interface Cp {
  resourceTypeId: string | null
  namedResourceId: string | null
  ownerKind: string
  source: string
  planningBasis: string
}

function input(overrides: { resourceTypes?: Rt[]; capacityProfiles?: Cp[] } = {}) {
  return {
    resourceTypes: overrides.resourceTypes ?? [],
    capacityProfiles: overrides.capacityProfiles ?? [],
  }
}

const roleOnlyRt = (): Rt => ({
  id: 'rt-1',
  name: 'Business Analyst',
  namedResources: [],
})

describe('checkPersistedCompleteness — human-readable findings', () => {
  it('names the role in a missing ROLE profile finding, keeping the ID secondary', () => {
    const findings = checkPersistedCompleteness(input({ resourceTypes: [roleOnlyRt()] }))

    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('Business Analyst')
    expect(findings[0]).toContain('lacks exactly one persisted ROLE profile')
    expect(findings[0]).toContain('rt-1')
  })

  it('names the named resource and its role in a missing named-resource finding', () => {
    const findings = checkPersistedCompleteness(
      input({
        resourceTypes: [
          {
            id: 'rt-1',
            name: 'Business Analyst',
            namedResources: [{ id: 'nr-1', name: 'Alice Example' }],
          },
        ],
      }),
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('Alice Example')
    expect(findings[0]).toContain('lacks persisted profile')
    expect(findings[0]).toContain('nr-1')
  })

  it('names the role in a planner-owned missing-ROLE-profile finding', () => {
    const findings = checkPersistedCompleteness(
      input({
        resourceTypes: [
          {
            id: 'rt-1',
            name: 'Platform Engineer',
            namedResources: [{ id: 'nr-1', name: 'Bob Planned' }],
          },
        ],
        capacityProfiles: [
          {
            resourceTypeId: null,
            namedResourceId: 'nr-1',
            ownerKind: 'PLANNED_RESOURCE',
            source: 'SQUAD_PLANNER',
            planningBasis: 'CAPACITY_PROFILE',
          },
        ],
      }),
    )

    // Named resource has a profile; the planner-owned role still requires a
    // ROLE profile.
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('Platform Engineer')
    expect(findings[0]).toContain('planner-owned profiles but requires exactly one ROLE profile')
  })

  // ── Semantics unchanged ────────────────────────────────────────────────
  it('still reports no finding when a role-only type has exactly one ROLE profile', () => {
    const findings = checkPersistedCompleteness(
      input({
        resourceTypes: [roleOnlyRt()],
        capacityProfiles: [
          {
            resourceTypeId: 'rt-1',
            namedResourceId: null,
            ownerKind: 'ROLE',
            source: 'MANUAL',
            planningBasis: 'DEMAND_FOLLOWING',
          },
        ],
      }),
    )
    expect(findings).toEqual([])
  })

  it('still allows explicit-only named people without a ROLE profile', () => {
    const findings = checkPersistedCompleteness(
      input({
        resourceTypes: [
          {
            id: 'rt-1',
            name: 'Business Analyst',
            namedResources: [{ id: 'nr-1', name: 'Alice Example' }],
          },
        ],
        capacityProfiles: [
          {
            resourceTypeId: null,
            namedResourceId: 'nr-1',
            ownerKind: 'NAMED_PERSON',
            source: 'MANUAL',
            planningBasis: 'DEMAND_FOLLOWING',
          },
        ],
      }),
    )
    expect(findings).toEqual([])
  })

  it('still accepts planner-owned profiles when exactly one ROLE profile exists', () => {
    const findings = checkPersistedCompleteness(
      input({
        resourceTypes: [
          {
            id: 'rt-1',
            name: 'Platform Engineer',
            namedResources: [{ id: 'nr-1', name: 'Bob Planned' }],
          },
        ],
        capacityProfiles: [
          {
            resourceTypeId: null,
            namedResourceId: 'nr-1',
            ownerKind: 'PLANNED_RESOURCE',
            source: 'SQUAD_PLANNER',
            planningBasis: 'CAPACITY_PROFILE',
          },
          {
            resourceTypeId: 'rt-1',
            namedResourceId: null,
            ownerKind: 'ROLE',
            source: 'SQUAD_PLANNER',
            planningBasis: 'CAPACITY_PROFILE',
          },
        ],
      }),
    )
    expect(findings).toEqual([])
  })
})
