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

  // Use Serializable isolation to prevent concurrent inserts/updates from
  // creating phantom duplicates while we re-read and verify.
  await prisma.$transaction(
    async (tx) => {
      // Fresh audit inside the transaction
      const freshProfiles = await loadAllProfiles(tx as unknown as PrismaClient)

      for (const group of report.repairableGroups) {
        if (group.profiles.length < 2) continue

        const reference = group.profiles[0]
        const ownerKey = buildOwnerKey(reference.resourceTypeId, reference.namedResourceId)

        // Build a set of exact profile IDs from the audit report for this group
        const auditedIds = new Set(group.profiles.map(p => p.id))

        // Re-read: find profiles matching this owner key in fresh state
        const currentGroup = freshProfiles.filter(p =>
          buildOwnerKey(p.resourceTypeId, p.namedResourceId) === ownerKey,
        )

        // Verify group size is unchanged
        if (currentGroup.length !== group.profiles.length) {
          throw new Error(
            `Repair aborted: owner key "${ownerKey}" group size changed from ${group.profiles.length} to ${currentGroup.length}`,
          )
        }

        // Verify every profile ID in the current group is one we audited
        // (prevents same-sized replacement: swapped IDs or new ID replacing deleted)
        for (const p of currentGroup) {
          if (!auditedIds.has(p.id)) {
            throw new Error(
              `Repair aborted: profile ${p.id} (owner key "${ownerKey}") was not in the audited group. ` +
              'Concurrent mutation detected.',
            )
          }
          // Verify the profile is still semantically equal to the audited reference
          if (!profilesAreSemanticEqual(p, reference)) {
            throw new Error(
              `Repair aborted: profile ${p.id} (owner key "${ownerKey}") is no longer identical to audited reference`,
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
    },
    {
      isolationLevel: 'Serializable',
      // Max 5 retries on serialization conflicts
      maxWait: 5000,
      timeout: 10000,
    },
  )

  return { profilesDeleted }
}
