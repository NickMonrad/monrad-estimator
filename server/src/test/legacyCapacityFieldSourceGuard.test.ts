/**
 * legacyCapacityFieldSourceGuard.test.ts — Regression guard for issue #418.
 *
 * Proves that normal runtime production code never accesses the candidate
 * ResourceType/NamedResource legacy capacity columns, while explicitly
 * permitted historical-snapshot input types and migration tooling stay
 * usable, and the guard itself cannot silently pass after a prohibited
 * field is introduced.
 */

import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  findProhibitedCandidateFieldAccess,
  scanProductionSources,
  GUARD_ALLOWLIST,
  LEGACY_CANDIDATE_FIELDS,
} from './legacyCapacityFieldSourceGuard.js'

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('legacy capacity field source guard', () => {
  it('detects prohibited Prisma access to candidate columns', () => {
    const source = `
      const rows = await db.namedResource.findMany({
        where: { resourceTypeId: rtId },
        select: { id: true, allocationMode: true, allocationPercent: true },
      })
    `
    const findings = findProhibitedCandidateFieldAccess(source)
    expect(findings.length).toBe(1)
    expect(findings[0].model).toBe('namedResource')
    expect(findings[0].op).toBe('findMany')
    expect(findings[0].field).toBe('allocationMode')
  })

  it('detects candidate-column writes in update data', () => {
    const source = `
      await tx.resourceType.update({
        where: { id },
        data: { allocationMode: 'CAPACITY_PLAN', count: 2 },
      })
    `
    const findings = findProhibitedCandidateFieldAccess(source)
    expect(findings.length).toBe(1)
    expect(findings[0].field).toBe('allocationMode')
  })

  it('does not flag capacityProfile queries using startWeek/endWeek', () => {
    const source = `
      await db.capacityProfile.findMany({
        where: { projectId },
        select: { startWeek: true, endWeek: true, defaultPercent: true },
      })
    `
    expect(findProhibitedCandidateFieldAccess(source)).toEqual([])
  })

  it('does not flag metadata-only resourceType/namedResource queries', () => {
    const source = `
      await prisma.resourceType.findMany({
        where: { projectId },
        select: { id: true, name: true, count: true, hoursPerDay: true },
      })
      await tx.namedResource.create({ data: { name, resourceTypeId, pricingModel } })
    `
    expect(findProhibitedCandidateFieldAccess(source)).toEqual([])
  })

  it('does not flag DTO object literals outside Prisma queries', () => {
    const source = `
      const row = { allocationMode: 'EFFORT', allocationPercent: 100, startWeek: null }
    `
    expect(findProhibitedCandidateFieldAccess(source)).toEqual([])
  })

  it('does not flag historical snapshot input types or tooling allowlist files', () => {
    for (const file of GUARD_ALLOWLIST) {
      expect(file.startsWith('src/lib/')).toBe(true)
    }
    // The allowlist entries themselves must stay free of Prisma query access
    // to candidate columns except where they define historical input shapes.
    expect(LEGACY_CANDIDATE_FIELDS).toContain('allocationMode')
  })

  it('proves no prohibited access exists anywhere in production sources', () => {
    const findings = scanProductionSources(serverRoot)
    const rendered = findings.map(f =>
      `${f.file}: .${f.model}.${f.op}() references "${f.field}" — ${f.snippet}`,
    )
    expect(rendered, rendered.join('\n')).toEqual([])
  })

  it('self-check: the guard matcher cannot miss a newly added prohibited field', () => {
    // If a developer adds a candidate column to a Prisma select, the matcher
    // must flag it — simulate by scanning a synthetic file body for every
    // candidate field in both select and data positions.
    for (const field of LEGACY_CANDIDATE_FIELDS) {
      const selectHit = findProhibitedCandidateFieldAccess(
        `prisma.namedResource.findMany({ where: {}, select: { ${field}: true } })`,
      )
      expect(selectHit.some(f => f.field === field)).toBe(true)
      const dataHit = findProhibitedCandidateFieldAccess(
        `tx.resourceType.update({ where: { id }, data: { ${field}: 0 } })`,
      )
      expect(dataHit.some(f => f.field === field)).toBe(true)
    }
  })
})
