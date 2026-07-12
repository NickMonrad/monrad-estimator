/**
 * projectSnapshotCapacity.ts — Pure legacy-v2 reconstruction and V3 persistence helpers
 * for snapshot rollback.
 *
 * These helpers are called inside a transaction during rollback and operate on
 * Prisma transaction clients (or any compatible client with the same model
 * method shapes). They never read the active CapacityPlan or call
 * syncCapacityProfilesForProject.
 *
 * @module projectSnapshotCapacity
 */

import type { SnapshotV2, SnapshotV3 } from './projectSnapshotTypes.js'

// ─── Planning basis mapping ──────────────────────────────────────────────────

/**
 * Map a v2 allocationMode string to a v3 planningBasis enum value.
 * Mirror of the internal mapping in capacityProfileMapping.ts.
 * null/undefined/EFFORT → DEMAND_FOLLOWING
 */
function allocationModeToPlanningBasis(mode: string | null | undefined): string {
  switch (mode) {
    case 'TIMELINE':
      return 'AVAILABILITY_WINDOW'
    case 'FULL_PROJECT':
      return 'WHOLE_PROJECT_ALLOCATION'
    case 'CAPACITY_PLAN':
      return 'CAPACITY_PROFILE'
    case 'EFFORT':
    default:
      return 'DEMAND_FOLLOWING'
  }
}
function allocationModeToSource(mode: string | null | undefined): string {
  switch (mode) {
    case 'TIMELINE':
      return 'AVAILABILITY_WINDOW'
    case 'EFFORT':
    case 'FULL_PROJECT':
      return 'FIXED'
    default:
      return 'LEGACY'
  }
}

// ─── V2 rollback: rebuild profiles from v2 compatibility fields ──────────────

/**
 * During V2 rollback, after restoring ResourceTypes, NamedResources, epics, and
 * other v2 state, delete all existing project capacity profiles/segments and
 * create deterministic legacy-only profiles derived solely from the v2
 * ResourceType/NamedResource fields.
 *
 * Named resources become NAMED_PERSON because v2 had no persisted
 * planned-resource owner. TIMELINE mode gets AVAILABILITY_WINDOW planning basis
 * with the allocationStartWeek → startWeek / allocationEndWeek → endWeek
 * window. EFFORT, FULL_PROJECT, and CAPACITY_PLAN modes use only captured
 * compatibility fields.
 *
 * Importantly, this never reads the active CapacityPlan or calls
 * syncCapacityProfilesForProject — it creates only what the v2 snapshot
 * captures.
 */
export async function recreateV2CapacityProfiles(
  tx: any,
  projectId: string,
  snapshot: SnapshotV2,
): Promise<void> {
  // Delete all existing project profiles (segments cascade via onDelete: Cascade)
  await tx.capacitySegment.deleteMany({ where: { capacityProfile: { projectId } } })
  await tx.capacityProfile.deleteMany({ where: { projectId } })

  for (const rt of snapshot.resourceTypes) {
    await tx.capacityProfile.create({
      data: {
        id: `snapshot-v2-role-${rt.id}`,
        projectId,
        ownerKind: 'ROLE',
        resourceTypeId: rt.id,
        namedResourceId: null,
        planningBasis: allocationModeToPlanningBasis(rt.allocationMode),
        source: allocationModeToSource(rt.allocationMode),
        defaultPercent: rt.allocationPercent,
        startWeek: rt.allocationStartWeek,
        endWeek: rt.allocationEndWeek,
        legacy: {
          allocationMode: rt.allocationMode,
          allocationPercent: rt.allocationPercent,
          allocationStartWeek: rt.allocationStartWeek,
          allocationEndWeek: rt.allocationEndWeek,
        },
      },
    })
  }
  const rtByRtId = new Map(snapshot.resourceTypes.map(rt => [rt.id, rt]))

  // Create NAMED_PERSON profiles from snapshot namedResources
  for (const nr of snapshot.namedResources) {
    const parentRt = rtByRtId.get(nr.resourceTypeId)
    const mode = nr.allocationMode ?? parentRt?.allocationMode ?? null

    // Resolve effective values (mirrors resolveNamedResourcePercent etc.)
    const effectivePercent = nr.allocationPercent ?? nr.allocationPct
    const effectiveStart = nr.allocationStartWeek ?? nr.startWeek
    const effectiveEnd = nr.allocationEndWeek ?? nr.endWeek

    await tx.capacityProfile.create({
      data: {
        id: `snapshot-v2-named-${nr.id}`,
        projectId,
        ownerKind: 'NAMED_PERSON',
        resourceTypeId: null,
        namedResourceId: nr.id,
        planningBasis: allocationModeToPlanningBasis(mode),
        source: allocationModeToSource(mode),
        defaultPercent: effectivePercent,
        startWeek: effectiveStart,
        endWeek: effectiveEnd,
        legacy: {
          allocationMode: mode,
          allocationPct: nr.allocationPct,
          allocationPercent: nr.allocationPercent,
          allocationStartWeek: nr.allocationStartWeek,
          allocationEndWeek: nr.allocationEndWeek,
          startWeek: nr.startWeek,
          endWeek: nr.endWeek,
        },
      },
    })
  }
}

// ─── V3 rollback: exact profile/segment replacement ──────────────────────────

/**
 * During V3 rollback, after restoring all common v2 state (RTs, NRs, epics,
 * etc.), delete ALL current project capacity profiles/segments and recreate
 * each target profile with exact IDs, projectId forced to the route projectId,
 * owner IDs, enum values, nulls, and legacy. Every segment is recreated with
 * exact id, profile FK, values, and source.
 *
 * This is an exact replacement — no broad legacy sync afterward.
 */
export async function recreateV3CapacityProfiles(
  tx: any,
  projectId: string,
  v3: SnapshotV3,
): Promise<void> {
  // Delete existing segments then profiles (segments cascade but we delete both
  // explicitly for clarity; deleteMany on profile cascades segments but the
  // explicit segment delete ensures ordering)
  await tx.capacitySegment.deleteMany({ where: { capacityProfile: { projectId } } })
  await tx.capacityProfile.deleteMany({ where: { projectId } })

  for (const profile of v3.capacityProfiles) {
    await tx.capacityProfile.create({
      data: {
        id: profile.id,
        projectId,
        ownerKind: profile.ownerKind,
        resourceTypeId: profile.resourceTypeId,
        namedResourceId: profile.namedResourceId,
        planningBasis: profile.planningBasis,
        source: profile.source,
        defaultPercent: profile.defaultPercent,
        startWeek: profile.startWeek,
        endWeek: profile.endWeek,
        legacy: profile.legacy,
      },
    })

    for (const seg of profile.segments) {
      await tx.capacitySegment.create({
        data: {
          id: seg.id,
          capacityProfileId: profile.id,
          startWeek: seg.startWeek,
          endWeek: seg.endWeek,
          capacityPercent: seg.capacityPercent,
          source: seg.source,
        },
      })
    }
  }
}
