import { test, expect } from '@playwright/test'
import { login, createProject } from './helpers'
import path from 'path'
import fs from 'fs'
import os from 'os'

/* ────────────────────────────────────────────────────────────────────────────
 * CSV seed data — 14-column format with Type column
 * Provides a Developer task and a Tech Lead task so the Resource Profile
 * summary table has at least two resource type rows after import.
 * ──────────────────────────────────────────────────────────────────────────── */
const CSV_CONTENT = [
  'Type,Epic,Feature,Story,Task,Template,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus',
  'Epic,Platform Build,,,,,,,,,,,,',
  'Feature,Platform Build,Core API,,,,,,,,,,,',
  'Story,Platform Build,Core API,API Design,,,,,,,,,,',
  'Task,Platform Build,Core API,API Design,Design endpoints,,Developer,24,3,,,,,',
  'Task,Platform Build,Core API,API Design,Review spec,,Tech Lead,8,1,,,,,',
].join('\n')

/**
 * Navigate to the Backlog, seed via CSV import, then navigate to the
 * Resource Profile page. Returns the project ID extracted from the URL.
 */
async function seedAndNavigateToResourceProfile(
  page: import('@playwright/test').Page
) {
  // ── Import CSV into the backlog ───────────────────────────────────────
  await page.getByRole('button', { name: /backlog/i }).click()
  await expect(page.getByRole('button', { name: /import csv/i })).toBeVisible({ timeout: 8_000 })

  const tmpFile = path.join(os.tmpdir(), `res-profile-seed-${Date.now()}.csv`)
  fs.writeFileSync(tmpFile, CSV_CONTENT)

  await page.getByRole('button', { name: /import csv/i }).click()
  await page.locator('input[type="file"]').setInputFiles(tmpFile)
  fs.unlinkSync(tmpFile)

  // Two-step staging flow
  await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
  await expect(page.getByText('Platform Build')).toBeVisible({ timeout: 10_000 })

  // ── Navigate to Resource Profile ──────────────────────────────────────
  const url = page.url()
  const projectId = url.match(/\/projects\/([^/]+)/)?.[1]
  await page.goto(`/projects/${projectId}/resource-profile`)
  await expect(
    page.getByRole('heading', { name: /resource profile/i })
  ).toBeVisible({ timeout: 10_000 })

  return projectId!
}

/* ======================================================================== *
 *  Original test — kept intact                                             *
 * ======================================================================== */
test.describe('Resource Profile', () => {
  test('can edit count for non-engineering resource types', async ({ page }) => {
    const suffix = Date.now()
    const projectName = `E2E ResProfile ${suffix}`
    const tmpFile = path.join(os.tmpdir(), `res-profile-import-${suffix}.csv`)

    await login(page)
    await createProject(page, projectName)

    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /backlog/i }).click()
    await expect(page.getByRole('button', { name: /import csv/i })).toBeVisible({ timeout: 8_000 })

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

    await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
    await expect(page.getByText('E2E ResEpic')).toBeVisible({ timeout: 10_000 })

    const hubUrl = page.url().replace('/backlog', '')
    await page.goto(hubUrl)
    await page.getByRole('button', { name: /resource profile/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /resource profile/i }).click()

    await expect(
      page.getByRole('heading', { name: /resource profile/i })
    ).toBeVisible({ timeout: 8_000 })

    const pmRow = page.locator('tr').filter({ hasText: /project manager/i }).first()
    await expect(pmRow).toBeVisible({ timeout: 15_000 })

    const countInput = pmRow.locator('input[type="number"]').first()
    await expect(countInput).toBeVisible({ timeout: 8_000 })
    await expect(countInput).toBeEditable()
    await expect(countInput).toHaveValue('1')
  })
})

/* ======================================================================== *
 *  Enhanced Resource Profile tests                                         *
 * ======================================================================== */
test.describe('Resource Profile — enhanced', () => {
  let projectName: string

  test.beforeEach(async ({ page }) => {
    projectName = `E2E ResProfile Enhanced ${Date.now()}`
    await login(page)
    await createProject(page, projectName)
    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
    await seedAndNavigateToResourceProfile(page)
  })

  test('resource profile page loads with resource types', async ({ page }) => {
    // Heading should already be visible from seedAndNavigateToResourceProfile
    await expect(
      page.getByRole('heading', { name: /resource profile/i })
    ).toBeVisible()

    // At least one resource type row should appear — Developer from the CSV seed
    const developerRow = page.locator('tr').filter({ hasText: /developer/i }).first()
    await expect(developerRow).toBeVisible({ timeout: 15_000 })
  })

  test('tab bar shows Resource Profile and Commercial tabs', async ({ page }) => {
    // Wait for summary table to load first
    await expect(
      page.locator('tr').filter({ hasText: /developer/i }).first()
    ).toBeVisible({ timeout: 15_000 })

    // Both tabs should be visible
    const rpTab = page.getByRole('button', { name: /resource profile/i }).first()
    const commercialTab = page.getByRole('button', { name: /commercial/i })
    await expect(rpTab).toBeVisible()
    await expect(commercialTab).toBeVisible()

    // Click Commercial tab — verify commercial content appears
    await commercialTab.click()
    await expect(
      page.getByRole('heading', { name: /cost summary/i })
    ).toBeVisible({ timeout: 10_000 })

    // Click back to Resource Profile tab — verify summary table reappears
    await page.getByRole('button', { name: /resource profile/i }).first().click()
    await expect(
      page.getByRole('heading', { name: /summary/i }).first()
    ).toBeVisible({ timeout: 10_000 })
  })

  test('resource count display shows formatted values', async ({ page }) => {
    // Wait for the Developer row (has tasks from seeded data)
    const developerRow = page.locator('tr').filter({ hasText: /developer/i }).first()
    await expect(developerRow).toBeVisible({ timeout: 15_000 })

    // The row should display hours and days values formatted with 2 decimal places
    // e.g. "24.00" hours or "3.00" days — look for the pattern in the row text
    const rowText = await developerRow.textContent()
    expect(rowText).toMatch(/\d+\.\d{2}/)
  })

  test('named resources — add person', async ({ page }) => {
    // Wait for the Developer resource type row in the summary table
    const developerRow = page.locator('tr').filter({ hasText: /developer/i }).first()
    await expect(developerRow).toBeVisible({ timeout: 15_000 })

    // The toggle is the resource name <span> inside the row (e.g. "Developer").
    // Click it to expand the named-resources panel below.
    const nameSpan = developerRow.locator('span', { hasText: /developer/i }).first()
    await nameSpan.click()

    // After expansion the "Named Resources" heading appears in the expanded panel
    await expect(
      page.getByRole('heading', { name: /named resources/i })
    ).toBeVisible({ timeout: 10_000 })

    // Click the "+ Add person" button to create a named resource
    const addPersonBtn = page.getByRole('button', { name: /add person/i })
    await expect(addPersonBtn).toBeVisible({ timeout: 5_000 })
    await addPersonBtn.click()

    // A new row should appear with the default name "New person" in an input
    await expect(
      page.locator('input[value="New person"]').first()
    ).toBeVisible({ timeout: 10_000 })
  })

  test('commercial tab — discount management', async ({ page }) => {
    // Wait for page to fully load
    await expect(
      page.locator('tr').filter({ hasText: /developer/i }).first()
    ).toBeVisible({ timeout: 15_000 })

    // Switch to Commercial tab
    await page.getByRole('button', { name: /commercial/i }).click()
    await expect(
      page.getByRole('heading', { name: /cost summary/i })
    ).toBeVisible({ timeout: 10_000 })

    // Look for the Project Discounts section
    await expect(
      page.getByRole('heading', { name: /project discounts/i })
    ).toBeVisible({ timeout: 10_000 })

    // Click "+ Add Discount" button
    const addDiscountBtn = page.getByRole('button', { name: /add discount/i })
    await expect(addDiscountBtn).toBeVisible()
    await addDiscountBtn.click()

    // Verify the add discount form appears with label input and type dropdown
    await expect(
      page.getByPlaceholder(/early bird/i)
    ).toBeVisible({ timeout: 5_000 })

    // Type dropdown should have "Percentage" option
    const typeSelect = page.locator('select').filter({ hasText: /percentage/i }).first()
    await expect(typeSelect).toBeVisible()
  })
})

/* ======================================================================== *
 *  Rate Cards page                                                         *
 * ======================================================================== */
test.describe('Rate Cards', () => {
  test('rate cards page loads with create button', async ({ page }) => {
    await login(page)

    // Navigate to rate cards page
    await page.goto('/rate-cards')

    // Verify heading
    await expect(
      page.getByRole('heading', { name: /rate cards/i })
    ).toBeVisible({ timeout: 10_000 })

    // Verify "+ Create Rate Card" button is visible
    await expect(
      page.getByRole('button', { name: /create rate card/i })
    ).toBeVisible()
  })
})
