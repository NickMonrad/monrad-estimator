/**
 * runtimeSyncBoundary.test.ts — Verifies that normal HTTP routes do not
 * import or call the operational sync helper (syncCapacityProfilesForProject).
 *
 * Issue #364 requires that legacy-to-profile reconciliation be available only
 * through explicit backfill/repair tooling. Normal routes must maintain profile
 * state directly.
 *
 * @see docs/domain/capacity-profile-source-of-truth-migration-plan.md
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTES_DIR = resolve(__dirname, '../routes')

const ROUTE_FILES = [
  'projects.ts',
  'resourceTypes.ts',
  'namedResources.ts',
]

const SYNC_IMPORT_RE = /from\s+['"](?:\.\.\/lib\/|\.\/)syncCapacityProfiles(?:\.js)?['"]/m
const SYNC_CALL_RE = /syncCapacityProfilesForProject\s*\(/m

describe('runtime sync boundary', () => {
  for (const file of ROUTE_FILES) {
    const filePath = resolve(ROUTES_DIR, file)
    const content = readFileSync(filePath, 'utf-8')

    it(`${file} does not import syncCapacityProfilesForProject`, () => {
      expect(content).not.toMatch(SYNC_IMPORT_RE)
    })

    it(`${file} does not call syncCapacityProfilesForProject`, () => {
      expect(content).not.toMatch(SYNC_CALL_RE)
    })
  }

  it('backfill file still imports and calls sync', () => {
    const backfillPath = resolve(__dirname, '../lib/backfillCapacityProfiles.ts')
    const content = readFileSync(backfillPath, 'utf-8')
    expect(content).toMatch(SYNC_IMPORT_RE)
    expect(content).toMatch(SYNC_CALL_RE)
  })
})
