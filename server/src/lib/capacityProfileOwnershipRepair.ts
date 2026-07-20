/**
 * capacityProfileOwnershipRepair.ts — Explicit repair of proven identical duplicate
 * capacity profiles.
 *
 * Given an AuditReport, this module re-reads and reclassifies each repairable
 * group inside one bounded transaction, aborts the entire repair if state changed
 * or any group is no longer provably identical, then deletes only the redundant
 * identical profiles (cascade deletes their owned segments).
 *
 * Never merges fields, copies segments, rewrites the survivor, or touches
 * conflicting/invalid groups.
 *
 * Idempotent: a second repair on a clean database does nothing.
 */

import type { PrismaClient } from '@prisma/client'
import {
  type AuditReport,
  loadAllProfiles,
  buildOwnerKey,
  profilesAreSemanticEqual,
  selectSurvivor,
} from './capacityProfileOwnershipAudit.js'

// ─── Repair result ──────────────────────────────────────────────────────────

export interface RepairResult {
  profilesDeleted: number
}
export async function repairIdenticalDuplicates(
  prisma: PrismaClient,
  report: AuditReport,
): Promise<RepairResult> {
  if (report.repairableGroups.length === 0) {
    return { profilesDeleted: 0 }
  }

  let profilesDeleted = 0

  await prisma.$transaction(async (tx) => {
    // Fresh audit inside the transaction
    const freshProfiles = await loadAllProfiles(tx as unknown as PrismaClient)

    for (const group of report.repairableGroups) {
      if (group.profiles.length < 2) continue

      const reference = group.profiles[0]
      const ownerKey = buildOwnerKey(reference.resourceTypeId, reference.namedResourceId)

      // Re-read and reclassify inside transaction
      const currentGroup = freshProfiles.filter(p =>
        buildOwnerKey(p.resourceTypeId, p.namedResourceId) === ownerKey,
      )

      if (currentGroup.length !== group.profiles.length) {
        throw new Error(
          `Repair aborted: owner key "${ownerKey}" group size changed from ${group.profiles.length} to ${currentGroup.length}`,
        )
      }

      // Verify all are still identical
      for (const p of currentGroup) {
        if (!profilesAreSemanticEqual(p, reference)) {
          throw new Error(
            `Repair aborted: profile ${p.id} (owner key "${ownerKey}") is no longer identical to reference`,
          )
        }
      }

      // Select survivor deterministically
      const survivor = selectSurvivor(currentGroup)
      const redundant = currentGroup.filter(p => p.id !== survivor.id)

      // Delete redundant profiles (cascade deletes segments)
      for (const p of redundant) {
        await tx.capacityProfile.delete({
          where: { id: p.id },
        })
        profilesDeleted++
      }
    }
  })

  return { profilesDeleted }
}
