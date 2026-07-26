import { test, expect } from '@playwright/test'
import { login, createProject, quickSchedule } from './helpers'
import path from 'path'
import fs from 'fs'
import os from 'os'

/* ────────────────────────────────────────────────────────────────────────────
 * CSV seed data — 14-column format with Type column
 * Provides a QA Engineer task and a Tech Lead task so the Resource Profile
 * summary table has at least two resource type rows after import.
 * Both types are seeded from global resource types on every new project.
 * ──────────────────────────────────────────────────────────────────────────── */
const CSV_CONTENT = [
  'Type,Epic,Feature,Story,Task,Template,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus',
  'Epic,Platform Build,,,,,,,,,,,,',
  'Feature,Platform Build,Core API,,,,,,,,,,,',
  'Story,Platform Build,Core API,API Design,,,,,,,,,,',
  'Task,Platform Build,Core API,API Design,Design endpoints,,Tech Lead,24,3,,,,,',
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
    await page.getByRole('button', { name: /resource profile/i }).first().waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /resource profile/i }).first().click()

    await expect(
      page.getByRole('heading', { name: /resource profile/i })
    ).toBeVisible({ timeout: 8_000 })

    const pmRow = page.locator('tr').filter({ hasText: /project manager/i }).first()
    await expect(pmRow).toBeVisible({ timeout: 15_000 })

    // Count is shown with +/- buttons instead of an input
    const addBtn = pmRow.locator('button', { hasText: '+' })
    const removeBtn = pmRow.locator('button', { hasText: '−' })
    await expect(addBtn).toBeVisible({ timeout: 8_000 })
    await expect(removeBtn).toBeVisible()
    // Count should display "1"
    await expect(pmRow.locator('text="1"').first()).toBeVisible()
  })
})

/* ======================================================================== *
 *  Enhanced Resource Profile tests                                         *
 * ======================================================================== */
test.describe('Resource Profile — enhanced', () => {
  let projectName: string

  test.beforeEach(async ({ page }) => {
    // CSV import + navigation takes ~15-20s; give each test 60s total
    test.setTimeout(60_000)
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

    // At least one resource type row should appear — Tech Lead from the CSV seed
    const techLeadRow = page.locator('tr').filter({ hasText: /tech lead/i }).first()
    await expect(techLeadRow).toBeVisible({ timeout: 15_000 })
  })

  test('tab bar shows Resource Profile and Commercial tabs', async ({ page }) => {
    // Wait for summary table to load first
    await expect(
      page.locator('tr').filter({ hasText: /tech lead/i }).first()
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
    // Wait for the Tech Lead row (has tasks from seeded data)
    const techLeadRow = page.locator('tr').filter({ hasText: /tech lead/i }).first()
    await expect(techLeadRow).toBeVisible({ timeout: 15_000 })

    // The row should display hours and days values formatted with 2 decimal places
    // e.g. "32.00" hours or "4.00" days — look for the pattern in the row text
    const rowText = await techLeadRow.textContent()
    expect(rowText).toMatch(/\d+\.\d{2}/)
  })

  test('named resources — add person', async ({ page }) => {
    // Wait for the Tech Lead resource type row in the summary table
    const techLeadRow = page.locator('tr').filter({ hasText: /tech lead/i }).first()
    await expect(techLeadRow).toBeVisible({ timeout: 15_000 })

    // After the UX change, the "People ↗" button toggles the named-resources panel.
    // The role name <button> now expands the epic breakdown instead.
    const peopleBtn = techLeadRow.locator('button', { hasText: /people/i }).first()
    await peopleBtn.click()

    // After expansion the "Named Resources" heading appears in the expanded panel
    await expect(
      page.getByRole('heading', { name: /named resources/i })
    ).toBeVisible({ timeout: 10_000 })

    // Click the "+ Add person" button to create a named resource
    const addPersonBtn = page.getByRole('button', { name: /add person/i })
    await expect(addPersonBtn).toBeVisible({ timeout: 5_000 })
    await addPersonBtn.click()

    // A new row should appear with an auto-generated name input (e.g. "Tech Lead 1")
    await expect(
      page.locator('input[type="text"]').first()
    ).toBeVisible({ timeout: 10_000 })
  })

  test('commercial tab — discount management', async ({ page }) => {
    // Wait for page to fully load
    await expect(
      page.locator('tr').filter({ hasText: /tech lead/i }).first()
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
  test('rate cards page shows read-only state for regular user', async ({ page }) => {
    await login(page)

    // Navigate to rate cards page
    await page.goto('/rate-cards')

    // Verify heading
    await expect(
      page.getByRole('heading', { name: /rate cards/i })
    ).toBeVisible({ timeout: 10_000 })

    // Verify the "Create Rate Card" button is NOT visible (regular user)
    await expect(
      page.getByRole('button', { name: /create rate card/i })
    ).not.toBeVisible()

    // Verify read-only notice is visible
    await expect(
      page.getByText(/rate cards can only be edited by a global admin/i)
    ).toBeVisible()
  })
})

/* ======================================================================== *
 *  Cache invalidation — manual timeline override updates Resource Profile  *
 *  Fixes: per-resource-type cached horizon (globalCachedMaxWeek → per-RT   *
 *         map) and stale weeklyDemandCache after manual timeline mutations *
 * ======================================================================== */
test.describe('Resource Profile — cache invalidation from Timeline', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000)
  })

  test('both resource types show fallback demand after manual feature override', async ({ page }) => {
    const projectName = `E2E RPCacheInv ${Date.now()}`

    // ── Login and create project ──
    await login(page)
    await createProject(page, projectName)

    // ── Navigate to Backlog and seed CSV with two resource types ──
    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /backlog/i }).click()

    const tmpFile = path.join(os.tmpdir(), `rp-cache-${Date.now()}.csv`)
    fs.writeFileSync(tmpFile, [
      'Type,Epic,Feature,Story,Task,Template,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus',
      'Epic,Platform Build,,,,,,,,,,,,',
      'Feature,Platform Build,Core API,,,,,,,,,,,',
      'Story,Platform Build,Core API,API Design,,,,,,,,,,',
      'Task,Platform Build,Core API,API Design,Implement,,Developer,40,5,,,,,',
      'Task,Platform Build,Core API,API Design,Review,,Tech Lead,16,2,,,,,',
    ].join('\n'))

    await page.getByRole('button', { name: /import csv/i }).click()
    await page.locator('input[type="file"]').setInputFiles(tmpFile)
    fs.unlinkSync(tmpFile)
    await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
    await expect(page.getByText('Platform Build')).toBeVisible({ timeout: 10_000 })

    // ── Navigate to Timeline, schedule, override feature ──
    const projectId = page.url().match(/\/projects\/([^/]+)/)?.[1]!
    await page.goto(`/projects/${projectId}`)
    await page.getByRole('button', { name: /timeline/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /timeline/i }).click()
    await expect(
      page.getByRole('heading', { name: /timeline planner/i })
    ).toBeVisible({ timeout: 8_000 })

    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toBeVisible({ timeout: 8_000 })
    await dateInput.fill('2026-06-01')
    await expect(dateInput).toHaveValue('2026-06-01')

    // Click Update timeline
    const schedButton = page.getByRole('button', { name: /^update timeline$/i }).first()
    await expect(schedButton).toBeVisible({ timeout: 10_000 })
    await schedButton.click()
    await expect(
      page.getByRole('button', { name: /sequential|parallel/i }).first()
    ).toBeVisible({ timeout: 15_000 })

    // Manual override: move feature to week 8 (extends one RT's cache horizon)
    await page.locator('[title="Core API"]').first().click()
    const featureEditPanel = page.locator('.sticky').filter({ hasText: 'Core API' }).last()
    await expect(featureEditPanel.getByText('Start week:')).toBeVisible({ timeout: 8_000 })
    await featureEditPanel.locator('input[type="number"]').first().fill('8')
    await featureEditPanel.getByRole('button', { name: /^save$/i }).click()
    await expect(
      featureEditPanel.getByRole('button', { name: /reset to auto/i })
    ).toBeVisible({ timeout: 10_000 })

    // ── Navigate to Resource Profile ──
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(
      page.getByRole('heading', { name: /resource profile/i })
    ).toBeVisible({ timeout: 10_000 })

    // Both resource type rows must render with formatted values
    // If per-RT cache horizon is wrong, one row might show 0 or be missing
    const developerRow = page.locator('tr').filter({ hasText: /developer/i }).first()
    await expect(developerRow).toBeVisible({ timeout: 15_000 })
    const devText = await developerRow.textContent()
    expect(devText).toMatch(/\d+\.\d{2}\s*h/i)

    const techLeadRow = page.locator('tr').filter({ hasText: /tech lead/i }).first()
    await expect(techLeadRow).toBeVisible({ timeout: 10_000 })
    const tlText = await techLeadRow.textContent()
    expect(tlText).toMatch(/\d+\.\d{2}\s*h/i)

    // ── Switch to Commercial tab — verify it also renders ──
    await page.getByRole('button', { name: /commercial/i }).click()
    await expect(
      page.getByRole('heading', { name: /cost summary/i })
    ).toBeVisible({ timeout: 10_000 })
  })
})

/* ======================================================================== *
 *  Capacity Profile Editor — issue #363                                    *
 *  Tests the first-class capacity-profile editor for ROLE with Varies      *
 *  by week segments, cross-view parity (Timeline, Commercial).             *
 *  Creates a project with Developer + Tech Lead tasks, opens the ROLE      *
 *  capacity profile badge, sets CAPACITY_PLAN mode with two non-overlapping*
 *  segments separated by a gap, saves, verifies badge display on Resource  *
 *  Profile, navigates to Timeline to verify capacity renders, returns to   *
 *  Resource Profile to confirm persistence, and opens Commercial to        *
 *  verify billing basis unchanged.                                         *
 * ======================================================================== */
const CAP_PROFILE_CSV = [
  'Type,Epic,Feature,Story,Task,Template,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus',
  'Epic,Platform Build,,,,,,,,,,,,',
  'Feature,Platform Build,Core API,,,,,,,,,,,',
  'Story,Platform Build,Core API,API Design,,,,,,,,,,',
  'Task,Platform Build,Core API,API Design,Implement,,Developer,40,5,,,,,',
  'Task,Platform Build,Core API,API Design,Review,,Tech Lead,16,2,,,,,',
].join('\n')

test.describe('Capacity profile editor — ROLE segments', () => {
  test('create Varies by week segments, verify cross-view persistence and Commercial unchanged', async ({ page }) => {
    test.setTimeout(150_000)

    // ── Setup: login, create project, seed backlog with Developer + Tech Lead ──
    await login(page)
    const projectName = `E2E CapProfile ${Date.now()}`
    await createProject(page, projectName)

    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /backlog/i }).click()

    await expect(page.getByRole('button', { name: /import csv/i })).toBeVisible({ timeout: 8_000 })
    const tmpFile = path.join(os.tmpdir(), `cap-${Date.now()}.csv`)
    fs.writeFileSync(tmpFile, CAP_PROFILE_CSV)
    await page.getByRole('button', { name: /import csv/i }).click()
    await page.locator('input[type="file"]').setInputFiles(tmpFile)
    fs.unlinkSync(tmpFile)
    await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
    await expect(page.getByText('Platform Build')).toBeVisible({ timeout: 10_000 })

    const projectId = page.url().match(/\/projects\/([^\/]+)/)?.[1]!

    // ── Navigate to Resource Profile and set day rate ──
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(
      page.getByRole('heading', { name: /resource profile/i }),
    ).toBeVisible({ timeout: 10_000 })

    const developerRow = page.locator('tr').filter({ hasText: /developer/i }).first()
    await expect(developerRow).toBeVisible({ timeout: 10_000 })

    // Set a day rate for Commercial assertions
    const dayRateInput = page.locator('input.w-20').first()
    await expect(dayRateInput).toBeVisible({ timeout: 10_000 })
    await dayRateInput.fill('1200')
    await dayRateInput.press('Tab')

    // ── Capture initial Commercial billing badge before profile change ──
    await page.getByRole('button', { name: /commercial/i }).click()
    await expect(
      page.getByRole('heading', { name: /cost summary/i }),
    ).toBeVisible({ timeout: 10_000 })

    const initialBadge = page.getByText(/^(As needed|Fixed for selected weeks \u00b7|Fixed for whole project \u00b7|Varies by week)/).first()
    await expect(initialBadge).toBeVisible({ timeout: 10_000 })
    const initialBadgeText = await initialBadge.textContent()

    // ── Return to Resource Profile and open capacity profile editor ──
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(
      page.getByRole('heading', { name: /resource profile/i }),
    ).toBeVisible({ timeout: 10_000 })

    const rpDeveloperRow = page.locator('tr').filter({ hasText: /developer/i }).first()
    await expect(rpDeveloperRow).toBeVisible({ timeout: 10_000 })

    await rpDeveloperRow.getByTitle('Click to edit capacity profile').click()
    await expect(
      page.getByRole('dialog', { name: /edit capacity profile/i }),
    ).toBeVisible({ timeout: 8_000 })

    // ── Select Varies by week (capacityProfile) mode ──
    await page.getByTestId('cp-planning-basis-select').selectOption('capacityProfile')

    // ── Fill first segment: W2-W4 (0-indexed weeks 1-3), 80% ──
    await page.getByTestId('cp-seg-start-0').fill('1')
    await page.getByTestId('cp-seg-end-0').fill('3')
    await page.getByTestId('cp-seg-pct-0').fill('80')

    // ── Add second segment: W8-W10 (0-indexed weeks 7-9), 60% ──
    // Gap: W5-W7 (0-indexed weeks 4-6) has no segment coverage
    await page.getByTestId('cp-add-segment').click()
    await page.getByTestId('cp-seg-start-1').fill('7')
    await page.getByTestId('cp-seg-end-1').fill('9')
    await page.getByTestId('cp-seg-pct-1').fill('60')

    // ── Save and verify modal closes ──
    const saveResp = page.waitForResponse(
      r => r.url().includes('/capacity-profiles/') && r.request().method() === 'PUT',
      { timeout: 15_000 },
    )
    await page.getByTestId('cp-save-btn').click()
    expect((await saveResp).ok()).toBeTruthy()
    await expect(
      page.getByRole('dialog', { name: /edit capacity profile/i }),
    ).not.toBeVisible({ timeout: 8_000 })

    // ── Verify exact visible segment display on Resource Profile row ──
    await expect(
      rpDeveloperRow.getByRole('button', { name: /Varies by week/i }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      rpDeveloperRow.getByText(/W2-W4: 80%/),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      rpDeveloperRow.getByText(/W8-W10: 60%/),
    ).toBeVisible({ timeout: 5_000 })
    // The segments display is: "W2-W4: 80%·W8-W10: 60%"
    // No filler segment for the gap weeks 5-7
    await expect(rpDeveloperRow.locator('text=W5-W7')).toHaveCount(0)

    // ── Navigate to Timeline, schedule, verify capacity renders ──
    await page.goto(`/projects/${projectId}/timeline`)
    await expect(
      page.getByRole('heading', { name: /timeline planner/i }),
    ).toBeVisible({ timeout: 10_000 })

    await page.locator('input[type="date"]').fill('2026-06-01')
    await expect(page.locator('input[type="date"]')).toHaveValue('2026-06-01')
    await quickSchedule(page)
    await expect(
      page.getByRole('button', { name: /sequential|parallel/i }).first(),
    ).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('resource-counts')).toBeVisible({ timeout: 10_000 })

    // ── Return to Resource Profile and verify segments persist after full cycle ──
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(
      page.getByRole('heading', { name: /resource profile/i }),
    ).toBeVisible({ timeout: 10_000 })

    const finalDevRow = page.locator('tr').filter({ hasText: /developer/i }).first()
    await expect(finalDevRow).toBeVisible({ timeout: 10_000 })

    await expect(
      finalDevRow.getByRole('button', { name: /Varies by week/i }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      finalDevRow.getByText(/W2-W4: 80%·W8-W10: 60%/),
    ).toBeVisible({ timeout: 5_000 })
    await expect(finalDevRow.locator('text=W5-W7')).toHaveCount(0)

    // Open editor to verify segments persisted after navigation
    await finalDevRow.getByTitle('Click to edit capacity profile').click()
    await expect(
      page.getByRole('dialog', { name: /edit capacity profile/i }),
    ).toBeVisible({ timeout: 8_000 })

    await expect(page.getByTestId('cp-seg-start-0')).toHaveValue('1')
    await expect(page.getByTestId('cp-seg-end-0')).toHaveValue('3')
    await expect(page.getByTestId('cp-seg-pct-0')).toHaveValue('80')
    await expect(page.getByTestId('cp-seg-start-1')).toHaveValue('7')
    await expect(page.getByTestId('cp-seg-end-1')).toHaveValue('9')
    await expect(page.getByTestId('cp-seg-pct-1')).toHaveValue('60')

    await page.getByTestId('cp-cancel-btn').click()
    await expect(
      page.getByRole('dialog', { name: /edit capacity profile/i }),
    ).not.toBeVisible({ timeout: 5_000 })

    // ── Verify Commercial billing basis unchanged after profile edit ──
    await page.getByRole('button', { name: /commercial/i }).click()
    await expect(
      page.getByRole('heading', { name: /cost summary/i }),
    ).toBeVisible({ timeout: 10_000 })

    const finalBadge = page.getByText(/^(As needed|Fixed for selected weeks \u00b7|Fixed for whole project \u00b7|Varies by week)/).first()
    await expect(finalBadge).toBeVisible({ timeout: 10_000 })
    const finalBadgeText = await finalBadge.textContent()
    expect(finalBadgeText?.trim()).toBe(initialBadgeText?.trim())
  })
})
