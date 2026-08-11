/**
 * exactCapacityProfileReader.ts — Neutral reusable exact capacity profile reader.
 *
 * Loads a project's capacity profiles with ordered segments for snapshot
 * building and clone. Issue #405 replaced the legacy JSON column (and the
 * DB_NULL / JSON_NULL discriminator it required) with the explicit nullable
 * `provenance` enum, so the reader is a plain deterministic ORM load with no
 * raw SQL and no null-state discrimination.
 *
 * Ownership: standalone helper importable by snapshot building, clone routes,
 * or any consumer needing typed SnapshotCapacityProfileV5[].
 * Does NOT import from projectSnapshotService.ts (dependency flows the other
 * way).
 */

import type { PrismaClient } from '@prisma/client'
import type {
  SnapshotCapacityProfileV5,
} from './projectSnapshotTypes.js'
import {
  sortSnapshotProfiles,
  sortSnapshotSegments,
} from './projectSnapshotValidation.js'

// ─── Client type ──────────────────────────────────────────────────────────────

/** Client type compatible with both PrismaClient and interactive transaction clients. */
export type SnapshotDbClient =
  | PrismaClient
  | Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

// ─── Error type ───────────────────────────────────────────────────────────────

export class ExactProfileReaderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExactProfileReaderError'
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load capacity profiles for a project with exact null-semantic preservation
 * and deterministic ordering.
 *
 * - Loads profiles + segments via ORM (with ordered segments).
 * - Uses a parameterised raw SQL query to distinguish DB_NULL from JSON_NULL
 *   on the `legacy` JSON field.
 * - Validates exact 1:1 correspondence between ORM rows and raw rows
 *   (fails closed on mismatch).
 * - Returns typed SnapshotCapacityProfile[] with preserved DB_NULL / JSON_NULL
 *   / VALUE semantics, ready for snapshot consumption.
 *
 * @param projectId - Project to load profiles for.
 * @param db - PrismaClient or interactive transaction client.
 * @returns Deterministically ordered SnapshotCapacityProfileV5[] with ordered segments.
 */
export async function loadExactCapacityProfiles(
  projectId: string,
  db: SnapshotDbClient,
): Promise<SnapshotCapacityProfileV5[]> {
  // 1. Load profiles via ORM with ordered segments in deterministic order
  const rawProfiles = await db.capacityProfile.findMany({
    where: { projectId },
    include: {
      segments: { orderBy: { startWeek: 'asc' as const } },
    },
    orderBy: [
      { ownerKind: 'asc' as const },
      { resourceTypeId: 'asc' as const },
      { namedResourceId: 'asc' as const },
    ],
  })

  // 2. Map to SnapshotCapacityProfileV5 with the explicit behavioural
  // provenance (issue #405). No raw SQL, no null-state discrimination — the
  // legacy JSON column no longer exists.
  const capacityProfiles = rawProfiles.map(p => ({
    id: p.id,
    ownerKind: p.ownerKind as SnapshotCapacityProfileV5['ownerKind'],
    resourceTypeId: p.resourceTypeId,
    namedResourceId: p.namedResourceId,
    planningBasis: p.planningBasis as SnapshotCapacityProfileV5['planningBasis'],
    source: p.source as SnapshotCapacityProfileV5['source'],
    defaultPercent: p.defaultPercent,
    startWeek: p.startWeek,
    endWeek: p.endWeek,
    provenance: p.provenance,
    segments: sortSnapshotSegments(p.segments.map(s => ({
      id: s.id,
      startWeek: s.startWeek,
      endWeek: s.endWeek,
      capacityPercent: s.capacityPercent,
      source: s.source as SnapshotCapacityProfileV5['segments'][number]['source'],
    }))),
  }))

  return sortSnapshotProfiles(capacityProfiles) as SnapshotCapacityProfileV5[]
}
