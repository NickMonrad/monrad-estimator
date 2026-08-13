/**
 * replan-profile-repair.spec.ts — Targeted E2E regression for issue #456:
 * making a NEEDS_REPLAN Resource Profile actionable when ROLE profiles are
 * missing.
 *
 *  1. Create a project and seed a backlog referencing THREE preserved
 *     role-only ResourceTypes (CSV import creates role-only roles with
 *     LEGACY_MAPPER ROLE profiles).
 *  2. Reset planning → every profile is discarded; the project NEEDS_REPLAN.
 *  3. Resource Profile visibly marks the missing persisted ROLE profiles
 *     ("Needs capacity profile") instead of presenting the effective
 *     As-needed draft as canonical state.
 *  4. The user chooses the explicit bulk **Use role counts as As needed**
 *     action → exactly one canonical ROLE profile per eligible role.
 *  5. The missing markers disappear; the existing **Replan project**
 *     completion returns the project to CURRENT.
 *  6. Update Timeline succeeds again.
 */

import { test, expect, type Page } from '@playwright/test'
import { login, createProject, quickSchedule } from './helpers'
import path from 'path'
import fs from 'fs'
import os from 'os'

const CSV_CONTENT = [
  'Type,Epic,Feature,Story,Task,Template,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus',
  'Epic,Platform Build,,,,,,,,,,,,',
  'Feature,Platform Build,Core API,,,,,,,,,,,',
  'Story,Platform Build,Core API,API Design,,,,,,,,,,',
  'Task,Platform Build,Core API,API Design,Design endpoints,,Tech Lead,24,3,,,,,',
  'Task,Platform Build,Core API,API Design,Requirements gathering,,Business Analyst,16,2,,,,,',
  'Task,Platform Build,Core API,API Design,Design UX flows,,UX Designer,12,2,,,,,',
].join('\n')

async function seedBacklogViaCsv(page: Page) {
  await page.getByRole('button', { name: /backlog/i }).click()
  await expect(page.getByRole('button', { name: /import csv/i })).toBeVisible({ timeout: 8_000 })

  const tmpFile = path.join(os.tmpdir(), `replan-repair-seed-${Date.now()}.csv`)
  fs.writeFileSync(tmpFile, CSV_CONTENT)
  await page.getByRole('button', { name: /import csv/i }).click()
  await page.locator('input[type="file"]').setInputFiles(tmpFile)
  fs.unlinkSync(tmpFile)

  await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
  await expect(page.getByText('Platform Build')).toBeVisible({ timeout: 10_000 })
}

test.describe('NEEDS_REPLAN Resource Profile repair (issue #456)', () => {
  test('missing profiles are visible and bulk As-needed + completion restore CURRENT', async ({ page }) => {
    const projectName = `E2E Replan Repair ${Date.now()}`
    await login(page)
    await createProject(page, projectName)

    // Open the project and seed a backlog referencing three role-only roles.
    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
    await seedBacklogViaCsv(page)
    const projectId = page.url().match(/\/projects\/([^/]+)/)?.[1]!
    expect(projectId).toBeTruthy()

    // ── Reset planning with explicit confirmation ─────────────────────────
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(page.getByRole('heading', { name: /resource profile/i })).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: /reset planning…/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: 'Reset planning', exact: true }).click()
    await expect(page.getByTestId('reset-feedback')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('planning-needs-attention')).toBeVisible()

    // ── The defect shape: preserved role-only rows are marked missing ──────
    // The project carries the CSV-seeded roles plus any default role-only
    // types created with the project — every preserved role-only row must be
    // visibly marked as missing a persisted ROLE profile.
    const missingBadges = page.locator('[data-testid^="missing-profile-badge-"]')
    await expect(missingBadges.first()).toBeVisible({ timeout: 10_000 })
    expect(await missingBadges.count()).toBeGreaterThanOrEqual(3)
    // The preserved roles themselves are visible (names come from the
    // CSV-seeded resource types) and each carries the missing marker.
    for (const roleName of ['Tech Lead', 'Business Analyst', 'UX Designer']) {
      const roleRow = page.locator('tr[data-testid^="resource-profile-row-"]', { hasText: roleName })
      await expect(roleRow).toBeVisible()
      await expect(roleRow.locator('[data-testid^="missing-profile-badge-"]')).toBeVisible()
    }

    // ── Explicit bulk user choice: Use role counts as As needed ───────────
    await page.getByRole('button', { name: 'Use role counts as As needed' }).click()
    await expect(page.getByTestId('bulk-as-needed-feedback')).toContainText(
      /Created As needed capacity profiles for \d+ roles?\./,
      { timeout: 10_000 },
    )
    // Every missing marker is resolved — the rows now carry persisted
    // As-needed profiles.
    await expect(missingBadges).toHaveCount(0, { timeout: 10_000 })

    // The project must still be quarantined — completion owns the
    // state transition.
    await expect(page.getByTestId('planning-needs-attention')).toBeVisible()

    // ── Existing Replan project completion → CURRENT ───────────────────────
    await page.getByTestId('replan-project-button').click()
    await expect(page.getByTestId('planning-needs-attention')).not.toBeVisible({ timeout: 10_000 })

    // ── Timeline scheduling works again ────────────────────────────────────
    await page.goto(`/projects/${projectId}/timeline`)
    await expect(page.getByRole('heading', { name: /timeline planner/i })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('planning-needs-attention')).not.toBeVisible()
    await quickSchedule(page)
    await expect(page.getByTestId('schedule-error')).not.toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Core API').first()).toBeVisible({ timeout: 10_000 })
  })
})
