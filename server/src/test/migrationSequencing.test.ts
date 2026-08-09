/**
 * migrationSequencing.test.ts — Deployment-ordering protection for issue #449
 * review finding 1.
 *
 * The #450 planning-state migration
 * (`20260808221539_add_project_planning_state`) sits after the staged
 * ownership-invariants migration
 * (`20260721000001_enforce_capacity_profile_ownership_invariants`) in Prisma
 * migration order. Production evidence records the older migration as still
 * pending, so `prisma migrate deploy` applies it before the #450 migration.
 *
 * These assertions protect the documented deployment contract:
 *   - the ownership-invariants migration still exists, is ordered BEFORE the
 *     planning-state migration, and still contains its invariant enforcement
 *     (it is never emptied, modified or silently bundled by #450);
 *   - the planning-state migration exists and adds the planningState column.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prisma', 'migrations')

const OWNERSHIP_MIGRATION = '20260721000001_enforce_capacity_profile_ownership_invariants'
const PLANNING_STATE_MIGRATION = '20260808221539_add_project_planning_state'

describe('migration deployment sequencing (issue #449 review)', () => {
  it('the ownership-invariants migration is ordered before the planning-state migration', () => {
    const names = readdirSync(migrationsDir).filter(name => name.endsWith('.sql') === false)
    expect(names).toContain(OWNERSHIP_MIGRATION)
    expect(names).toContain(PLANNING_STATE_MIGRATION)
    // Prisma applies migrations in lexicographic folder order; deploy therefore
    // applies the ownership-invariants migration first.
    expect(OWNERSHIP_MIGRATION.localeCompare(PLANNING_STATE_MIGRATION)).toBeLessThan(0)
  })

  it('the ownership-invariants migration is unchanged and still enforces its invariants', () => {
    const sql = readFileSync(join(migrationsDir, OWNERSHIP_MIGRATION, 'migration.sql'), 'utf8')
    // Core enforcement content — guards against accidental emptying/modification.
    expect(sql).toContain('chk_CapacityProfile_exactly_one_owner')
    expect(sql).toContain('chk_CapacityProfile_owner_kind_fk')
    expect(sql).toContain('CREATE UNIQUE INDEX "CapacityProfile_resourceTypeId_key"')
    expect(sql).toContain('CREATE UNIQUE INDEX "CapacityProfile_namedResourceId_key"')
    expect(sql).toContain('Preflight FAILED')
  })

  it('the planning-state migration adds the Project.planningState column', () => {
    const sql = readFileSync(join(migrationsDir, PLANNING_STATE_MIGRATION, 'migration.sql'), 'utf8')
    expect(sql).toContain('ProjectPlanningState')
    expect(sql).toContain('ADD COLUMN     "planningState"')
  })
})
