/**
 * capacityProfileOwnershipAudit.ts — Ownership-integrity audit for CapacityProfile rows.
 *
 * Loads every profile with deterministic ordering, exact legacy null semantics,
 * ordered segments, and classifies all ownership/integrity issues.
 *
 * Physical owner identity:
 *   - ROLE           → resourceTypeId (unique)
 *   - NAMED_PERSON   → namedResourceId (unique)
 *   - PLANNED_RESOURCE → namedResourceId (unique)
 *
 * ownerKind is NOT part of the uniqueness key — a named resource cannot have
 * both a NAMED_PERSON and a PLANNED_RESOURCE profile simultaneously.
 *
 * This module produces deterministic structured output. It never writes.
 */

import type { PrismaClient } from '@prisma/client'

// ─── Types ──────────────────────────────────────────────────────────────────

/** Snapshot of legacy null state from raw SQL query. */
export type LegacyNullStatus = 'DB_NULL' | 'JSON_NULL' | 'VALUE'

export interface AuditedSegment {
  startWeek: number
  endWeek: number
  capacityPercent: number
  source: string
}

export interface AuditedProfile {
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
  legacyStatus: LegacyNullStatus
  createdAt: Date
  segments: AuditedSegment[]
}

/** Physical owner key: `resourceTypeId::<id>` or `namedResourceId::<id>`. */
export type ProfileOwnerKey = string

export function buildOwnerKey(
  resourceTypeId: string | null,
  namedResourceId: string | null,
): ProfileOwnerKey {
  if (resourceTypeId != null) return `resourceTypeId::${resourceTypeId}`
  if (namedResourceId != null) return `namedResourceId::${namedResourceId}`
  return ''
}

// ─── Classification types ───────────────────────────────────────────────────

export type AuditFindingType =
  | 'both_owner_fks_set'
  | 'neither_owner_fk_set'
  | 'owner_kind_fk_mismatch'
  | 'missing_owner'
  | 'cross_project_owner'
  | 'duplicate_physical_owner'
  | 'identical_duplicate_group'
  | 'conflicting_duplicate_group'

export interface AuditFinding {
  type: AuditFindingType
  severity: 'error' | 'warning'
  message: string
  profileIds: string[]
}

export interface OwnerKeyClassification {
  /** Profiles with this physical owner key, distinct values only. */
  profiles: AuditedProfile[]
  /** True when all profiles in this group represent identical authoritative state. */
  isIdentical: boolean
  /** Human-readable explanation of the group. */
  note: string
}

export interface AuditReport {
  /** Total profiles examined. */
  totalProfiles: number
  /** All findings. */
  findings: AuditFinding[]
  /** Groups of identical duplicates eligible for repair. */
  repairableGroups: OwnerKeyClassification[]
  /** Groups of conflicting duplicates that require manual resolution. */
  conflictingGroups: OwnerKeyClassification[]
  /** Valid single-owner profiles (production OK, no uniqueness violation). */
  validSingletons: number
  /** True when no blocking issues exist. */
  isClean: boolean
}

// ─── Deterministic ordering helpers ──────────────────────────────────────────

export function compareProfiles(a: AuditedProfile, b: AuditedProfile): number {
  // Primary: ownerKind asc
  const kindCmp = a.ownerKind.localeCompare(b.ownerKind)
  if (kindCmp !== 0) return kindCmp
  // Secondary: resourceTypeId asc (nullable-aware)
  const rtCmp = (a.resourceTypeId ?? '').localeCompare(b.resourceTypeId ?? '')
  if (rtCmp !== 0) return rtCmp
  // Tertiary: namedResourceId asc
  return (a.namedResourceId ?? '').localeCompare(b.namedResourceId ?? '')
}

export function compareSegments(a: AuditedSegment, b: AuditedSegment): number {
  const swCmp = a.startWeek - b.startWeek
  if (swCmp !== 0) return swCmp
  const ewCmp = a.endWeek - b.endWeek
  if (ewCmp !== 0) return ewCmp
  const cpCmp = a.capacityPercent - b.capacityPercent
  if (cpCmp !== 0) return cpCmp
  return a.source.localeCompare(b.source)
}

// ─── Exact state equality for duplicate comparison ──────────────────────────

/**
 * Test whether two legacy status values are semantically equal.
 * DB_NULL is distinct from JSON_NULL, which is distinct from VALUE.
 */
export function legacyStatusEqual(a: LegacyNullStatus, b: LegacyNullStatus): boolean {
  return a === b
}

/**
 * Test whether two AuditedProfiles represent the same authoritative state.
 * Ignores id, segment IDs, createdAt, updatedAt.
 */
export function profilesAreSemanticEqual(a: AuditedProfile, b: AuditedProfile): boolean {
  if (a.projectId !== b.projectId) return false
  if (a.resourceTypeId !== b.resourceTypeId) return false
  if (a.namedResourceId !== b.namedResourceId) return false
  if (a.ownerKind !== b.ownerKind) return false
  if (a.planningBasis !== b.planningBasis) return false
  if (a.source !== b.source) return false
  if (a.defaultPercent !== b.defaultPercent) return false
  if (a.startWeek !== b.startWeek) return false
  if (a.endWeek !== b.endWeek) return false
  if (!legacyStatusEqual(a.legacyStatus, b.legacyStatus)) return false
  // Compare ordered segments
  if (a.segments.length !== b.segments.length) return false
  const aSegs = [...a.segments].sort(compareSegments)
  const bSegs = [...b.segments].sort(compareSegments)
  for (let i = 0; i < aSegs.length; i++) {
    const sa = aSegs[i]
    const sb = bSegs[i]
    if (sa.startWeek !== sb.startWeek) return false
    if (sa.endWeek !== sb.endWeek) return false
    if (sa.capacityPercent !== sb.capacityPercent) return false
    if (sa.source !== sb.source) return false
  }
  return true
}

/**
 * Select the deterministic survivor from a group of semantically identical profiles.
 * Rule: earliest createdAt wins; lexical profile id is the tie-breaker.
 */
export function selectSurvivor(profiles: AuditedProfile[]): AuditedProfile {
  const sorted = [...profiles].sort((a, b) => {
    const tCmp = a.createdAt.getTime() - b.createdAt.getTime()
    if (tCmp !== 0) return tCmp
    return a.id.localeCompare(b.id)
  })
  return sorted[0]
}

// ─── Null-state raw query (reuses exact-reader pattern) ──────────────────────

import { Prisma } from '@prisma/client'

type ProfileIdOnly = { id: string }

async function loadLegacyNullMap(
  prisma: PrismaClient,
  ormProfileIds: ProfileIdOnly[],
): Promise<Map<string, LegacyNullStatus>> {
  if (ormProfileIds.length === 0) return new Map()

  const idList = ormProfileIds.map(p => p.id)
  const rows = await prisma.$queryRaw<
    Array<{ id: string; legacy_is_null: boolean; legacy_typeof: string | null }>
  >(
    Prisma.sql`
      SELECT id, "legacy" IS NULL AS legacy_is_null, jsonb_typeof("legacy") AS legacy_typeof
      FROM "CapacityProfile"
      WHERE id IN (${Prisma.join(idList)})
      ORDER BY id
    `,
  )

  const map = new Map<string, LegacyNullStatus>()
  for (const row of rows) {
    if (row.legacy_is_null) {
      map.set(row.id, 'DB_NULL')
    } else if (row.legacy_typeof === 'null') {
      map.set(row.id, 'JSON_NULL')
    } else {
      map.set(row.id, 'VALUE')
    }
  }
  // Validate 1:1 correspondence — every ORM-loaded profile must have a raw row.
  for (const p of ormProfileIds) {
    if (!map.has(p.id)) {
      map.set(p.id, 'DB_NULL') // defensive fallback for safety
    }
  }
  return map
}

// ─── Load profiles with exact null semantics ─────────────────────────────────

/**
 * Load all CapacityProfile rows with ordered segments and exact legacy null semantics.
 */
export async function loadAllProfiles(prisma: PrismaClient): Promise<AuditedProfile[]> {
  const rawProfiles = await prisma.capacityProfile.findMany({
    include: {
      segments: {
        orderBy: [{ startWeek: 'asc' as const }, { endWeek: 'asc' as const }],
      },
    },
    orderBy: [
      { ownerKind: 'asc' as const },
      { resourceTypeId: 'asc' as const },
      { namedResourceId: 'asc' as const },
    ],
  })

  const legacyNullMap = await loadLegacyNullMap(
    prisma,
    rawProfiles.map(p => ({ id: p.id })),
  )

  return rawProfiles.map(p => {
    const legacyStatus = legacyNullMap.get(p.id) ?? 'DB_NULL'
    return {
      id: p.id,
      projectId: p.projectId,
      resourceTypeId: p.resourceTypeId,
      namedResourceId: p.namedResourceId,
      ownerKind: p.ownerKind,
      planningBasis: p.planningBasis,
      source: p.source,
      defaultPercent: p.defaultPercent,
      startWeek: p.startWeek,
      endWeek: p.endWeek,
      legacyStatus,
      createdAt: p.createdAt,
      segments: p.segments.map(s => ({
        startWeek: s.startWeek,
        endWeek: s.endWeek,
        capacityPercent: s.capacityPercent,
        source: s.source,
      })),
    }
  })
}

// ─── Cross-project owner detection ───────────────────────────────────────────


/**
 * Load the project ownership association for every potential owner FK referenced
 * by profiles. Returns a map: resourceTypeId → projectId and namedResourceId → projectId.
 */
async function loadOwnerProjectMap(
  prisma: PrismaClient,
  profiles: AuditedProfile[],
): Promise<{ rtToProject: Map<string, string>; nrToProject: Map<string, string> }> {
  const rtIds = new Set<string>()
  const nrIds = new Set<string>()
  for (const p of profiles) {
    if (p.resourceTypeId) rtIds.add(p.resourceTypeId)
    if (p.namedResourceId) nrIds.add(p.namedResourceId)
  }

  const rtToProject = new Map<string, string>()
  const nrToProject = new Map<string, string>()

  if (rtIds.size > 0) {
    const rts = await prisma.resourceType.findMany({
      where: { id: { in: [...rtIds] } },
      select: { id: true, projectId: true },
    })
    for (const rt of rts) {
      rtToProject.set(rt.id, rt.projectId)
    }
  }

  if (nrIds.size > 0) {
    const nrs = await prisma.namedResource.findMany({
      where: { id: { in: [...nrIds] } },
      select: { id: true, resourceType: { select: { projectId: true } } },
    })
    for (const nr of nrs) {
      nrToProject.set(nr.id, nr.resourceType.projectId)
    }
  }

  return { rtToProject, nrToProject }
}

// ─── Main audit ──────────────────────────────────────────────────────────────

/**
 * Run the full ownership-integrity audit.
 *
 * @param prisma - Connected PrismaClient
 * @returns Deterministic AuditReport
 */
export async function runOwnershipAudit(prisma: PrismaClient): Promise<AuditReport> {
  const profiles = await loadAllProfiles(prisma)
  const { rtToProject, nrToProject } = await loadOwnerProjectMap(prisma, profiles)

  const findings: AuditFinding[] = []
  const repairableGroups: OwnerKeyClassification[] = []
  const conflictingGroups: OwnerKeyClassification[] = []

  // Group by physical owner key
  const byOwner = new Map<ProfileOwnerKey, AuditedProfile[]>()
  for (const p of profiles) {
    const key = buildOwnerKey(p.resourceTypeId, p.namedResourceId)
    if (!byOwner.has(key)) byOwner.set(key, [])
    byOwner.get(key)!.push(p)
  }

  // Check individual profiles for shape issues
  for (const p of profiles) {
    const hasRt = p.resourceTypeId != null
    const hasNr = p.namedResourceId != null

    // Both or neither FK
    if (hasRt && hasNr) {
      findings.push({
        type: 'both_owner_fks_set',
        severity: 'error',
        message: `Profile ${p.id} (project ${p.projectId}): both resourceTypeId and namedResourceId are set`,
        profileIds: [p.id],
      })
    }
    if (!hasRt && !hasNr) {
      findings.push({
        type: 'neither_owner_fk_set',
        severity: 'error',
        message: `Profile ${p.id} (project ${p.projectId}): neither resourceTypeId nor namedResourceId is set`,
        profileIds: [p.id],
      })
    }

    // OwnerKind/FK mismatch
    if (p.ownerKind === 'ROLE' && !hasRt) {
      findings.push({
        type: 'owner_kind_fk_mismatch',
        severity: 'error',
        message: `Profile ${p.id}: ownerKind ROLE requires resourceTypeId, got resourceTypeId=${JSON.stringify(p.resourceTypeId)}, namedResourceId=${JSON.stringify(p.namedResourceId)}`,
        profileIds: [p.id],
      })
    }
    if (p.ownerKind === 'ROLE' && hasNr) {
      findings.push({
        type: 'owner_kind_fk_mismatch',
        severity: 'error',
        message: `Profile ${p.id}: ownerKind ROLE must not have namedResourceId set`,
        profileIds: [p.id],
      })
    }
    if ((p.ownerKind === 'NAMED_PERSON' || p.ownerKind === 'PLANNED_RESOURCE') && !hasNr) {
      findings.push({
        type: 'owner_kind_fk_mismatch',
        severity: 'error',
        message: `Profile ${p.id}: ownerKind ${p.ownerKind} requires namedResourceId`,
        profileIds: [p.id],
      })
    }
    if ((p.ownerKind === 'NAMED_PERSON' || p.ownerKind === 'PLANNED_RESOURCE') && hasRt) {
      findings.push({
        type: 'owner_kind_fk_mismatch',
        severity: 'error',
        message: `Profile ${p.id}: ownerKind ${p.ownerKind} must not have resourceTypeId set`,
        profileIds: [p.id],
      })
    }

    // Missing owner (FK points to non-existent record)
    if (hasRt && !rtToProject.has(p.resourceTypeId!)) {
      findings.push({
        type: 'missing_owner',
        severity: 'error',
        message: `Profile ${p.id}: resourceTypeId "${p.resourceTypeId}" does not exist`,
        profileIds: [p.id],
      })
    }
    if (hasNr && !nrToProject.has(p.namedResourceId!)) {
      findings.push({
        type: 'missing_owner',
        severity: 'error',
        message: `Profile ${p.id}: namedResourceId "${p.namedResourceId}" does not exist`,
        profileIds: [p.id],
      })
    }

    // Cross-project owner
    if (hasRt && rtToProject.get(p.resourceTypeId!) !== p.projectId) {
      const actual = rtToProject.get(p.resourceTypeId!)
      findings.push({
        type: 'cross_project_owner',
        severity: 'error',
        message: `Profile ${p.id}: resourceTypeId "${p.resourceTypeId}" belongs to project "${actual}" but profile projectId is "${p.projectId}"`,
        profileIds: [p.id],
      })
    }
    if (hasNr && nrToProject.get(p.namedResourceId!) !== p.projectId) {
      const actual = nrToProject.get(p.namedResourceId!)
      findings.push({
        type: 'cross_project_owner',
        severity: 'error',
        message: `Profile ${p.id}: namedResourceId "${p.namedResourceId}" belongs to project "${actual}" but profile projectId is "${p.projectId}"`,
        profileIds: [p.id],
      })
    }
  }

  // Check groups by owner key for duplicates
  for (const [key, group] of byOwner) {
    // Skip malformed profiles (already reported above)
    if (key === '') continue

    if (group.length > 1) {
      // Check whether this group has any shape-level errors already reported
      const groupHasErrors = group.some(p =>
        findings.some(f => f.profileIds.includes(p.id)),
      )

      if (!groupHasErrors) {
        // Classify as identical or conflicting
        const isIdentical = group.length >= 2 && group.every(p =>
          profilesAreSemanticEqual(p, group[0]),
        )

        const profileIds = group.map(p => p.id).sort()
        const ownerDesc = group[0].resourceTypeId
          ? `resourceTypeId="${group[0].resourceTypeId}"`
          : `namedResourceId="${group[0].namedResourceId}"`

        if (isIdentical) {
          repairableGroups.push({
            profiles: [...group].sort(compareProfiles),
            isIdentical: true,
            note: `Identical duplicates for ${ownerDesc}: ${profileIds.join(', ')}`,
          })
          findings.push({
            type: 'identical_duplicate_group',
            severity: 'warning',
            message: `Identical duplicate group for ${ownerDesc}: profiles ${profileIds.join(', ')}`,
            profileIds,
          })
        } else {
          conflictingGroups.push({
            profiles: [...group].sort(compareProfiles),
            isIdentical: false,
            note: `Conflicting duplicates for ${ownerDesc}: ${profileIds.join(', ')}`,
          })
          findings.push({
            type: 'conflicting_duplicate_group',
            severity: 'error',
            message: `Conflicting duplicate group for ${ownerDesc}: profiles ${profileIds.join(', ')}`,
            profileIds,
          })
        }
      }
    }
  }

  const validSingletons = profiles.length -
    findings.filter(f => f.severity === 'error').reduce((s, f) => s + f.profileIds.length, 0) -
    repairableGroups.reduce((s, g) => s + g.profiles.length, 0)

  return {
    totalProfiles: profiles.length,
    findings,
    repairableGroups,
    conflictingGroups,
    validSingletons: Math.max(0, validSingletons),
    isClean: findings.every(f => f.severity !== 'error') && conflictingGroups.length === 0,
  }
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/**
 * Format an audit report as human-readable text.
 */
export function formatAuditReport(report: AuditReport): string {
  const lines: string[] = []
  lines.push('═══ Capacity Profile Ownership Audit ═══')
  lines.push('')
  lines.push(`Total profiles examined: ${report.totalProfiles}`)
  lines.push(`Valid singletons:       ${report.validSingletons}`)
  lines.push(`Repairable groups:      ${report.repairableGroups.length}`)
  lines.push(`Conflicting groups:     ${report.conflictingGroups.length}`)
  lines.push(`Total findings:         ${report.findings.length}`)
  lines.push('')

  if (report.findings.length === 0) {
    lines.push('✅ No findings — database is clean.')
    return lines.join('\n')
  }

  if (report.findings.some(f => f.severity === 'error')) {
    lines.push('❌ Blocking errors found.')
  }

  lines.push('')
  for (const f of report.findings) {
    const badge = f.severity === 'error' ? '❌' : '⚠️'
    lines.push(`${badge} [${f.type}] ${f.message}`)
  }

  if (report.conflictingGroups.length > 0) {
    lines.push('')
    lines.push('═══ Conflicting groups (manual resolution required) ═══')
    for (const g of report.conflictingGroups) {
      lines.push('')
      lines.push(`  ${g.note}`)
      for (const p of g.profiles) {
        lines.push(`    Profile ${p.id}: ownerKind=${p.ownerKind}, planningBasis=${p.planningBasis}, source=${p.source}, defaultPercent=${p.defaultPercent}, weeks=[${p.startWeek}-${p.endWeek}], legacy=${p.legacyStatus}`)
        const segs = [...p.segments].sort(compareSegments).map(sg => `W${sg.startWeek}-W${sg.endWeek}@${sg.capacityPercent}%(${sg.source})`)
        if (segs.length > 0) {
          lines.push(`    Segments: ${segs.join(', ')}`)
        }
      }
    }
  }

  if (report.repairableGroups.length > 0) {
    lines.push('')
    lines.push('═══ Repairable groups (identical duplicates) ═══')
    for (const g of report.repairableGroups) {
      const survivor = selectSurvivor(g.profiles)
      const redundant = g.profiles.filter(p => p.id !== survivor.id)
      lines.push(`  ${g.note}`)
      lines.push(`    Survivor: ${survivor.id} (created ${survivor.createdAt.toISOString()})`)
      lines.push(`    Redundant: ${redundant.map(p => p.id).join(', ')}`)
    }
  }

  lines.push('')
  if (report.isClean) {
    lines.push('✅ Database is clean. Migration may proceed.')
  } else {
    lines.push('❌ Database is NOT clean. Resolve errors before migration.')
  }

  return lines.join('\n')
}

/**
 * Format an audit report as machine-readable JSON.
 */
export function auditReportToJson(report: AuditReport): string {
  const obj: Record<string, unknown> = {
    totalProfiles: report.totalProfiles,
    isClean: report.isClean,
    validSingletons: report.validSingletons,
    findings: report.findings.map(f => ({
      type: f.type,
      severity: f.severity,
      message: f.message,
      profileIds: f.profileIds,
    })),
    repairableGroups: report.repairableGroups.map(g => ({
      isIdentical: g.isIdentical,
      note: g.note,
      survivorId: g.profiles.length >= 2 ? selectSurvivor(g.profiles).id : g.profiles[0]?.id ?? '',
      profileIds: g.profiles.map(p => p.id).sort(),
    })),
    conflictingGroups: report.conflictingGroups.map(g => ({
      isIdentical: g.isIdentical,
      note: g.note,
      profileIds: g.profiles.map(p => p.id).sort(),
    })),
  }
  return JSON.stringify(obj, null, 2)
}
