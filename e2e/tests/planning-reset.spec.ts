/**
 * planning-reset.spec.ts — Targeted E2E flow for the Reset Planning /
 * Replan project workflow (issue #449):
 *
 *   1. Open a valid project with backlog and an established capacity plan
 *      (the project carries both a demand-bearing role and preserved
 *      zero-demand roles — no role is deleted anywhere in this flow).
 *   2. Reset planning (with confirmation).
 *   3. Observe "Planning needs attention".
 *   4. Verify the backlog remains.
 *   5. Enter the supported replanning path (Resource Profile).
 *   6. Establish new capacity inputs ("As needed" / demand-following) for
 *      EVERY preserved role, including the zero-demand ones.
 *   7. Complete replanning → project returns to CURRENT.
 *   8. Update Timeline works again.
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
].join('\n')

async function seedBacklogViaCsv(page: Page) {
  await page.getByRole('button', { name: /backlog/i }).click()
  await expect(page.getByRole('button', { name: /import csv/i })).toBeVisible({ timeout: 8_000 })

  const tmpFile = path.join(os.tmpdir(), `planning-reset-seed-${Date.now()}.csv`)
  fs.writeFileSync(tmpFile, CSV_CONTENT)
  await page.getByRole('button', { name: /import csv/i }).click()
  await page.locator('input[type="file"]').setInputFiles(tmpFile)
  fs.unlinkSync(tmpFile)

  await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
  await expect(page.getByText('Platform Build')).toBeVisible({ timeout: 10_000 })
}

/**
 * Open the capacity profile editor for EVERY role row and save "As needed".
 * While NEEDS_REPLAN the Resource Profile exposes every preserved role —
 * including zero-demand roles — so this creates the user's chosen profile
 * for each of them. Rows are iterated by index (the row list keeps its
 * order across the refetch after each save; `.first()` would re-target the
 * same row forever because every editable row shares the same button title).
 */
async function setAllRoleCapacitiesAsNeeded(page: Page) {
  const rows = page.locator('tr[data-testid^="resource-profile-row-"]')
  const rowCount = await rows.count()
  for (let i = 0; i < rowCount; i++) {
    // Missing persisted profiles render the amber "Needs capacity profile"
    // badge (issue #456); persisted ones keep the normal edit badge — both
    // open the same capacity editor.
    const editButton = rows.nth(i).locator(
      'button[title="Click to edit capacity profile"], button[title="Click to create capacity profile"]',
    )
    await editButton.waitFor({ state: 'visible', timeout: 10_000 })
    await editButton.click()
    await expect(page.getByTestId('capacity-profile-editor')).toBeVisible({ timeout: 8_000 })
    await page.locator('#cp-planning-basis').selectOption('demandFollowing')
    await page.getByTestId('cp-save-btn').click()
    await expect(page.getByTestId('capacity-profile-editor')).not.toBeVisible({ timeout: 10_000 })
  }
}

test.describe('Planning reset and replan workflow', () => {
  test('reset planning, replan via Resource Profile, and return to CURRENT', async ({ page }) => {
    const projectName = `E2E Planning Reset ${Date.now()}`
    await login(page)
    await createProject(page, projectName)

    // Open the project and seed the backlog.
    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
    await seedBacklogViaCsv(page)
    const projectId = page.url().match(/\/projects\/([^/]+)/)?.[1]!
    expect(projectId).toBeTruthy()

    // ── Establish canonical pre-reset planning ────────────────────────────
    // (CURRENT Resource Profile shows demand-bearing roles only; the seeded
    // project's roles carry pre-existing auto-created profiles.)
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(page.getByRole('heading', { name: /resource profile/i })).toBeVisible({ timeout: 10_000 })
    await setAllRoleCapacitiesAsNeeded(page)

    // ── Reset planning with explicit confirmation ─────────────────────────
    await page.getByRole('button', { name: /reset planning…/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByText(/capacity profiles, capacity plans, planned resources and schedule output are removed/i)).toBeVisible()
    await expect(page.getByText(/The project, backlog, effort estimates and dependencies are kept/i)).toBeVisible()

    await page.getByRole('button', { name: 'Reset planning', exact: true }).click()
    await expect(page.getByTestId('reset-feedback')).toBeVisible({ timeout: 10_000 })

    // ── Observe the NEEDS_REPLAN state ────────────────────────────────────
    await expect(page.getByTestId('planning-needs-attention')).toBeVisible()
    await expect(page.getByRole('heading', { name: /planning needs attention/i })).toBeVisible()

    // ── The backlog remains fully accessible ──────────────────────────────
    await page.goto(`/projects/${projectId}/backlog`)
    await expect(page.getByText('Platform Build')).toBeVisible({ timeout: 10_000 })

    // ── Replan through the supported Resource Profile surface ─────────────
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(page.getByTestId('planning-needs-attention')).toBeVisible({ timeout: 10_000 })
    // Choose "As needed" / demand-following for EVERY preserved role — the
    // zero-demand roles that Reset Planning preserved stay visible and
    // editable here; no role is deleted (issue #449).
    await setAllRoleCapacitiesAsNeeded(page)

    // ── Complete replanning → project returns to CURRENT ──────────────────
    await page.getByTestId('replan-project-button').click()
    await expect(page.getByTestId('planning-needs-attention')).not.toBeVisible({ timeout: 10_000 })

    // ── Timeline scheduling works again ───────────────────────────────────
    await page.goto(`/projects/${projectId}/timeline`)
    await expect(page.getByRole('heading', { name: /timeline planner/i })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('planning-needs-attention')).not.toBeVisible()
    await quickSchedule(page)
    await expect(page.getByTestId('schedule-error')).not.toBeVisible({ timeout: 10_000 })
    // The schedule rendered feature entries (gantt/list present).
    await expect(page.getByText('Core API').first()).toBeVisible({ timeout: 10_000 })
  })
})
