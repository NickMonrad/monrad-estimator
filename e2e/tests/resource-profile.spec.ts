import { test, expect } from '@playwright/test'
import { login, createProject } from './helpers'
import path from 'path'
import fs from 'fs'
import os from 'os'

test.describe('Resource Profile', () => {
  /**
   * Verifies that the Resource Profile summary table renders an editable number
   * input for resource types that belong to the GOVERNANCE or PROJECT_MANAGEMENT
   * category.
   *
   * Background: Each project gets default resource types created on setup, including:
   *   - 'Tech Governance'  (category: GOVERNANCE)
   *   - 'Project Manager'  (category: PROJECT_MANAGEMENT)
   *
   * The editable count `<input type="number">` only renders for those categories.
   * The summary table itself only renders when at least one task exists in the backlog,
   * so this test seeds the project via CSV import before navigating to the page.
   */
  test('can edit count for non-engineering resource types', async ({ page }) => {
    const suffix = Date.now()
    const projectName = `E2E ResProfile ${suffix}`
    const tmpFile = path.join(os.tmpdir(), `res-profile-import-${suffix}.csv`)

    await login(page)
    await createProject(page, projectName)

    // ── Step 1: Navigate to Backlog ──────────────────────────────────────────
    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /backlog/i }).click()
    await expect(page.getByRole('button', { name: /import csv/i })).toBeVisible({ timeout: 8_000 })

    // ── Step 2: Seed via CSV import ──────────────────────────────────────────
    // A task with ResourceType "Project Manager" maps to the PROJECT_MANAGEMENT
    // category resource type that is created automatically for every project.
    // The summary table will then render an editable <input> in the Count column
    // for that row.
    const headers = [
      'Epic', 'Feature', 'Story', 'Task', 'ResourceType',
      'HoursExtraSmall', 'HoursSmall', 'HoursMedium', 'HoursLarge', 'HoursExtraLarge',
      'HoursEffort', 'DurationDays', 'Description', 'Assumptions',
    ].join(',')
    const dataRow = [
      'E2E ResEpic', 'E2E ResFeature', 'E2E ResStory', 'E2E ResTask', 'Project Manager',
      '0', '0', '0', '0', '0', '8', '', 'PM task', '',
    ].join(',')
    fs.writeFileSync(tmpFile, [headers, dataRow].join('\n'))

    await page.getByRole('button', { name: /import csv/i }).click()
    const fileInput = page.locator('input[type="file"]')
    await fileInput.setInputFiles(tmpFile)
    fs.unlinkSync(tmpFile)

    // Two-step import modal: staging → confirm → import
    await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
    await expect(page.getByText('E2E ResEpic')).toBeVisible({ timeout: 10_000 })

    // ── Step 3: Navigate to Resource Profile ────────────────────────────────
    // Strip /backlog from the current URL to get the project hub URL, then
    // click the Resource Profile hub button.
    const hubUrl = page.url().replace('/backlog', '')
    await page.goto(hubUrl)
    await page.getByRole('button', { name: /resource profile/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /resource profile/i }).click()

    // ── Step 4: Assert the page heading loads ────────────────────────────────
    await expect(
      page.getByRole('heading', { name: /resource profile/i })
    ).toBeVisible({ timeout: 8_000 })

    // ── Step 5: Wait for the summary table to load and find the "Project Manager" row ─
    // The profile API maps the task's resource type to the PROJECT_MANAGEMENT
    // category row. Wait generously because the profile query runs after page load.
    // Use a <tr> filter — chart SVG and overhead form don't use table rows, so this
    // is unambiguous. Add .first() in case multiple rows share the text prefix.
    const pmRow = page.locator('tr').filter({ hasText: /project manager/i }).first()
    await expect(pmRow).toBeVisible({ timeout: 15_000 })

    // ── Step 6: Assert the count cell for "Project Manager" is an editable input ──
    // The ResourceProfilePage renders `<input type="number" className="w-16 …">` only
    // for GOVERNANCE and PROJECT_MANAGEMENT rows; Engineering rows show a plain number.

    const countInput = pmRow.locator('input[type="number"]')
    await expect(countInput).toBeVisible({ timeout: 8_000 })
    await expect(countInput).toBeEditable()

    // Sanity-check: the default count value is 1
    await expect(countInput).toHaveValue('1')
  })
})
