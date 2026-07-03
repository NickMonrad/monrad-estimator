/**
 * backfillCapacityProfiles.ts — Idempotent backfill helper.
 *
 * Delegates to syncCapacityProfilesForProject for each project, accumulating
 * per-project SyncResult counts into a BackfillResult.
 *
 * Safe to run multiple times. Does not modify legacy fields.
 */
import type { PrismaClient } from '@prisma/client'
import { syncCapacityProfilesForProject } from './syncCapacityProfiles.js'
import { CapacityProfileValidationError } from './syncCapacityProfiles.js'

// ─── Backfill result ───────────────────────────────────────────────────────

export interface BackfillResult {
  profilesCreated: number
  profilesUpdated: number
  profilesDeleted: number
  segmentsCreated: number
  segmentsDeleted: number
}

/**
 * Idempotently backfill CapacityProfile and CapacitySegment records from
 * existing ResourceType, NamedResource, and active CapacityPlan data.
 *
 * Safe to run multiple times. Does not modify legacy fields.
 * Enforces exactly-one-owner at the application level.
 */
export async function backfillCapacityProfiles(
  prisma: PrismaClient,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    profilesCreated: 0,
    profilesUpdated: 0,
    profilesDeleted: 0,
    segmentsCreated: 0,
    segmentsDeleted: 0,
  }

  // Fetch all projects with their resource types, named resources, and active capacity plans
  const projects = await prisma.project.findMany({
    include: {
      resourceTypes: {
        include: {
          namedResources: { orderBy: { createdAt: 'asc' as const } },
        },
      },
      capacityPlans: {
        where: { isActive: true },
        take: 1,
        include: {
          periods: {
            include: { entries: true },
            orderBy: { periodIndex: 'asc' as const },
          },
        },
      },
    },
  })

  for (const project of projects) {
    const syncResult = await syncCapacityProfilesForProject(prisma, project.id)
    result.profilesCreated += syncResult.profilesCreated
    result.profilesUpdated += syncResult.profilesUpdated
    result.profilesDeleted += syncResult.profilesDeleted
    result.segmentsCreated += syncResult.segmentsCreated
    result.segmentsDeleted += syncResult.segmentsDeleted
  }

  return result
}

export { CapacityProfileValidationError }

