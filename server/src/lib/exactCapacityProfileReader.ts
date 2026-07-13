/**
 * exactCapacityProfileReader.ts — Neutral reusable exact capacity profile reader.
 *
 * Loads a project's capacity profiles with ordered segments, using parameterised
 * raw SQL to distinguish DB_NULL from JSON_NULL on the `legacy` JSON field
 * (a distinction Prisma's ORM loses).  Validates exact 1:1 correspondence
 * between ORM-loaded profiles and raw null-state rows (fails closed on
 * mismatch).
 *
 * Ownership: standalone helper importable by snapshot building, clone routes,
 * or any consumer needing typed SnapshotCapacityProfile[] with preserved
 * null semantics.  Does NOT import from projectSnapshotService.ts (dependency
 * flows the other way).
 */

import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type {
  SnapshotCapacityProfile,
  SnapshotJsonValue,
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

// ─── Null-state raw query ─────────────────────────────────────────────────────

/**
 * Detect which project capacity profiles have database-NULL legacy.
 * Prisma reads both DB_NULL (Prisma.DbNull) and JSON null (Prisma.JsonNull)
 * as JavaScript null; this raw query distinguishes them so the snapshot can
 * preserve the exact null semantics.
 *
 * Uses parameterised Prisma.sql via $queryRaw for compatibility with
 * PrismaClient, transaction clients, and explicit unit doubles.
 * Validates exact 1:1 correspondence with ORM-loaded profiles.
 */
async function loadLegacyNullMap(
  projectId: string,
  db: SnapshotDbClient,
  ormProfileIds: Array<{ id: string }>,
): Promise<Map<string, boolean>> {
  const rows = await db.$queryRaw<Array<{ id: string; legacy_is_null: boolean; legacy_typeof: string | null }>>(
    Prisma.sql`SELECT id, "legacy" IS NULL AS legacy_is_null, jsonb_typeof("legacy") AS legacy_typeof FROM "CapacityProfile" WHERE "projectId" = ${projectId} ORDER BY id`,
  )

  // Validate exact 1:1 correspondence with ORM-loaded profiles
  const profileIds = new Set(ormProfileIds.map(p => p.id))
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new ExactProfileReaderError(`Duplicate null-state row for capacity profile ${row.id}`)
    }
    if (!profileIds.has(row.id)) {
      throw new ExactProfileReaderError(`Null-state row references unknown capacity profile ${row.id}`)
    }
    seen.add(row.id)
  }
  for (const p of ormProfileIds) {
    if (!seen.has(p.id)) {
      throw new ExactProfileReaderError(`Missing null-state row for capacity profile ${p.id}`)
    }
  }

  return new Map(rows.map(r => [r.id, r.legacy_is_null]))
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
 * @returns Deterministically ordered SnapshotCapacityProfile[] with ordered segments.
 */
export async function loadExactCapacityProfiles(
  projectId: string,
  db: SnapshotDbClient,
): Promise<SnapshotCapacityProfile[]> {
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

  // 2. Load null-state discrimination via parameterised raw SQL
  const legacyNullMap = await loadLegacyNullMap(projectId, db, rawProfiles)

  // 3. Map to SnapshotCapacityProfile with proper null discrimination
  const capacityProfiles = rawProfiles.map(p => {
    // Determine the precise null state for legacy
    const isDBNull = legacyNullMap.get(p.id) ?? false
    let legacy: SnapshotJsonValue
    if (isDBNull) {
      legacy = { kind: 'DB_NULL' }
    } else if (p.legacy === null) {
      legacy = { kind: 'JSON_NULL' }
    } else {
      legacy = { kind: 'VALUE', value: p.legacy as Record<string, unknown> | unknown[] | string | number | boolean }
    }

    return {
      id: p.id,
      ownerKind: p.ownerKind as SnapshotCapacityProfile['ownerKind'],
      resourceTypeId: p.resourceTypeId,
      namedResourceId: p.namedResourceId,
      planningBasis: p.planningBasis as SnapshotCapacityProfile['planningBasis'],
      source: p.source as SnapshotCapacityProfile['source'],
      defaultPercent: p.defaultPercent,
      startWeek: p.startWeek,
      endWeek: p.endWeek,
      legacy,
      segments: sortSnapshotSegments(p.segments.map(s => ({
        id: s.id,
        startWeek: s.startWeek,
        endWeek: s.endWeek,
        capacityPercent: s.capacityPercent,
        source: s.source as SnapshotCapacityProfile['segments'][number]['source'],
      }))),
    }
  })

  return sortSnapshotProfiles(capacityProfiles)
}
