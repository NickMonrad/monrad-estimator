import { test, expect } from '@playwright/test'
import { login, createProject, quickSchedule, API_BASE } from './helpers'
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
  'Feature,Platform Build,Alpha Feature,,,,,,,,,,,',
  'Feature,Platform Build,Bravo Feature,,,,,,,,,,,',
  'Feature,Platform Build,Charlie Feature,,,,,,,,,,,',
  'Story,Platform Build,Alpha Feature,Alpha Story,,,,,,,,,,',
  'Story,Platform Build,Bravo Feature,Bravo Story,,,,,,,,,,',
  'Story,Platform Build,Charlie Feature,Charlie Story,,,,,,,,,,',
  'Task,Platform Build,Alpha Feature,Alpha Story,Alpha Task,,Developer,8,1,,,,,',
  'Task,Platform Build,Bravo Feature,Bravo Story,Bravo Task,,Developer,8,1,,,,,',
  'Task,Platform Build,Charlie Feature,Charlie Story,Charlie Task,,Developer,8,1,,,,,',
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

    // ── Capture initial Commercial values before profile change ──
    await page.getByRole('button', { name: /commercial/i }).click()
    await expect(
      page.getByRole('heading', { name: /cost summary/i }),
    ).toBeVisible({ timeout: 10_000 })

    // Locate the Developer Commercial row by its name cell
    const devCommercialRow = page.locator('tr').filter({ hasText: 'Developer' }).first()
    await expect(devCommercialRow).toBeVisible({ timeout: 10_000 })

    // Capture day rate: Commercial table renders it in the first td with day rate amount
    // The row has columns: name, count, effortDays, dayRate, billableDays, subtotal
    const devDayRateCell = devCommercialRow.locator('td').nth(6)
    await expect(devDayRateCell).toBeVisible({ timeout: 5_000 })
    const initialDayRate = await devDayRateCell.textContent()

    // Capture billable days (effort-based billing quantity)
    const devBillableCell = devCommercialRow.locator('td').nth(5)
    await expect(devBillableCell).toBeVisible({ timeout: 5_000 })
    const initialBillableDays = await devBillableCell.textContent()

    // Capture subtotal
    const devSubtotalCell = devCommercialRow.locator('td').nth(7)
    await expect(devSubtotalCell).toBeVisible({ timeout: 5_000 })
    const initialSubtotal = await devSubtotalCell.textContent()

    // ── Return to Resource Profile and open capacity profile editor ──
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(
      page.getByRole('heading', { name: /resource profile/i }),
    ).toBeVisible({ timeout: 10_000 })

    const rpDevRow = page.locator('tr').filter({ hasText: /developer/i }).first()
    await expect(rpDevRow).toBeVisible({ timeout: 10_000 })

    await rpDevRow.getByTitle('Click to edit capacity profile').click()
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
      rpDevRow.getByRole('button', { name: /Varies by week/i }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      rpDevRow.getByText(/W2-W4: 80%/),
    ).toBeVisible({ timeout: 5_000 })
    await expect(
      rpDevRow.getByText(/W8-W10: 60%/),
    ).toBeVisible({ timeout: 5_000 })
    await expect(rpDevRow.locator('text=W5-W7')).toHaveCount(0)

    // ── Navigate to Timeline, schedule, intercept capacity data ──
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

    // Read timeline to discover feature IDs, then position them deterministically
    const token = await page.evaluate(() => localStorage.getItem('token'))
    const authHeaders = { Authorization: `Bearer ${token}` }

    const initialTimelineResp = await page.request.get(
      `/api/projects/${projectId}/timeline`,
      { headers: authHeaders },
    )
    expect(initialTimelineResp.ok()).toBeTruthy()
    const initialTimelineData = await initialTimelineResp.json() as {
      entries: Array<{ featureId: string; featureName: string }>
    }
    expect(initialTimelineData.entries.length).toBeGreaterThanOrEqual(3)

    // Position three features to create Developer demand in each profile region:
    // Alpha Feature at week 1 (W2, inside first segment at 80%)
    // Bravo Feature at week 4 (W5, inside gap at 0%)
    // Charlie Feature at week 7 (W8, inside second segment at 60%)
    const alphaFeature = initialTimelineData.entries.find((e: { featureName: string }) => /alpha/i.test(e.featureName))
    const bravoFeature = initialTimelineData.entries.find((e: { featureName: string }) => /bravo/i.test(e.featureName))
    const charlieFeature = initialTimelineData.entries.find((e: { featureName: string }) => /charlie/i.test(e.featureName))
    expect(alphaFeature).toBeDefined()
    expect(bravoFeature).toBeDefined()
    expect(charlieFeature).toBeDefined()

    for (const [feature, startWeek] of [
      [alphaFeature!, 1],
      [bravoFeature!, 4],
      [charlieFeature!, 7],
    ] as const) {
      const posResp = await page.request.put(
        `/api/projects/${projectId}/timeline/${feature.featureId}`,
        { headers: authHeaders, data: { startWeek, durationWeeks: 1 } },
      )
      expect(posResp.ok(), `Failed to position ${feature.featureName} at week ${startWeek}`).toBeTruthy()
    }

    // Re-read timeline after positioning all three features
    const timelineResp = await page.request.get(
      `/api/projects/${projectId}/timeline`,
      { headers: authHeaders },
    )
    expect(timelineResp.ok()).toBeTruthy()
    const timelineData = await timelineResp.json() as {
      weeklyDemand: Array<{ week: number; resourceTypeName: string; capacityDays: number }>
    }
    expect(timelineData.weeklyDemand).toBeDefined()

    // One Developer provides five capacity days per week.
    // The resolved capacity profile applies:
    //   W2-W4 (indices 1-3): 80% -> 4 capacity days
    //   W5-W7 (indices 4-6): gap (0%) -> 0 capacity days
    //   W8-W10 (indices 7-9): 60% -> 3 capacity days
    const devEntries = timelineData.weeklyDemand.filter(
      (w: { resourceTypeName: string }) => /dev/i.test(w.resourceTypeName),
    )

    // Choose week 2 (W3, inside first segment), week 5 (W6, gap), week 8 (W9, inside second segment)
    const firstSegmentWeek = devEntries.find((w: { week: number }) => w.week === 1)
    const gapWeek = devEntries.find((w: { week: number }) => w.week === 4)
    const secondSegmentWeek = devEntries.find((w: { week: number }) => w.week === 7)

    expect(firstSegmentWeek, 'No Developer demand at week 2 (first segment)').toBeDefined()
    expect(gapWeek, 'No Developer demand at week 5 (gap)').toBeDefined()
    expect(secondSegmentWeek, 'No Developer demand at week 8 (second segment)').toBeDefined()

    // Assert exact resolved capacity values from the profile
    expect(firstSegmentWeek!.week).toBe(1)
    expect(firstSegmentWeek!.capacityDays).toBeCloseTo(4, 5)

    expect(gapWeek!.week).toBe(4)
    expect(gapWeek!.capacityDays).toBe(0)

    expect(secondSegmentWeek!.week).toBe(7)
    expect(secondSegmentWeek!.capacityDays).toBeCloseTo(3, 5)
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

    // ── Verify Commercial billing values unchanged after profile edit ──
    await page.getByRole('button', { name: /commercial/i }).click()
    await expect(
      page.getByRole('heading', { name: /cost summary/i }),
    ).toBeVisible({ timeout: 10_000 })

    // Locate Developer row again
    const finalDevCommercialRow = page.locator('tr').filter({ hasText: 'Developer' }).first()
    await expect(finalDevCommercialRow).toBeVisible({ timeout: 10_000 })

    // Assert day rate unchanged
    const finalDayRateCell = finalDevCommercialRow.locator('td').nth(6)
    await expect(finalDayRateCell).toBeVisible({ timeout: 5_000 })
    const finalDayRate = await finalDayRateCell.textContent()
    expect(finalDayRate?.trim()).toBe(initialDayRate?.trim())

    // Assert billable days unchanged
    const finalBillableCell = finalDevCommercialRow.locator('td').nth(5)
    await expect(finalBillableCell).toBeVisible({ timeout: 5_000 })
    const finalBillableDays = await finalBillableCell.textContent()
    expect(finalBillableDays?.trim()).toBe(initialBillableDays?.trim())

    // Assert subtotal unchanged
    const finalSubtotalCell = finalDevCommercialRow.locator('td').nth(7)
    await expect(finalSubtotalCell).toBeVisible({ timeout: 5_000 })
    const finalSubtotal = await finalSubtotalCell.textContent()
    expect(finalSubtotal?.trim()).toBe(initialSubtotal?.trim())
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Squad Planner → manual transfer — issue #411
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Switch to manual capacity', () => {
  test('transfer Squad Planner role to manual, edit capacity, verify persistence', async ({ page, request }) => {
    test.setTimeout(180_000)

    const projectName = `E2E Transfer ${Date.now()}`

    // ── Login and create project ──
    await login(page)
    await createProject(page, projectName)

    // ── Import backlog CSV to create Developer + Tech Lead tasks ──
    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /backlog/i }).click()

    await expect(page.getByRole('button', { name: /import csv/i })).toBeVisible({ timeout: 8_000 })
    const csvContent = [
      'Type,Epic,Feature,Story,Task,Template,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus',
      'Epic,Platform Build,,,,,,,,,,,,',
      'Feature,Platform Build,Core API,,,,,,,,,,,',
      'Story,Platform Build,Core API,API Design,,,,,,,,,,',
      'Task,Platform Build,Core API,API Design,Implement,,Developer,40,5,,,,,',
      'Task,Platform Build,Core API,API Design,Review,,Tech Lead,16,2,,,,,',
    ].join('\n')
    const tmpFile = path.join(os.tmpdir(), `transfer-${Date.now()}.csv`)
    fs.writeFileSync(tmpFile, csvContent)
    await page.getByRole('button', { name: /import csv/i }).click()
    await page.locator('input[type="file"]').setInputFiles(tmpFile)
    fs.unlinkSync(tmpFile)
    await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
    await expect(page.getByText('Platform Build')).toBeVisible({ timeout: 10_000 })

    const projectId = page.url().match(/\/projects\/([^/]+)/)?.[1]!

    // ── Navigate to Timeline and set start date ──
    await page.goto(`/projects/${projectId}`)
    await page.getByRole('button', { name: /timeline/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /timeline/i }).click()
    await expect(page.getByRole('heading', { name: /timeline planner/i })).toBeVisible({ timeout: 8_000 })

    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toBeVisible({ timeout: 8_000 })
    await dateInput.fill('2026-06-01')
    await expect(dateInput).toHaveValue('2026-06-01')

    // ── Quick schedule ──
    await quickSchedule(page)
    await expect(
      page.getByRole('button', { name: /sequential|parallel/i }).first(),
    ).toBeVisible({ timeout: 15_000 })

    // ── Get auth token for API calls ──
    // Reuse the helpers from the existing test pattern
    const authToken = await page.evaluate(() => localStorage.getItem('token'))
    const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : {}

    // ── Determine resource type IDs via API ──
    const projectResp = await request.get(`${API_BASE}/api/projects/${projectId}`, { headers: authHeaders })
    expect(projectResp.ok()).toBeTruthy()
    const projectData = await projectResp.json() as { resourceTypes: Array<{ id: string; name: string }> }
    const devRt = projectData.resourceTypes.find(rt => rt.name === 'Developer')
    expect(devRt).toBeDefined()

    // ── Open Squad Planner drawer ──
    await page.getByRole('button', { name: /open squad planner/i }).click()
    const drawer = page.getByRole('dialog', { name: /squad planner/i })
    await expect(drawer).toBeVisible({ timeout: 5_000 })

    // ── Generate capacity profile ──
    const generateBtn = drawer.getByRole('button', { name: /generate capacity profile/i })
    await expect(generateBtn).toBeVisible()
    const planResponse = page.waitForResponse(
      resp => resp.url().includes('/squad-plan') && !resp.url().includes('/apply') && resp.request().method() === 'POST',
      { timeout: 30_000 },
    )
    await generateBtn.click()
    await planResponse

    // Wait for result KPIs
    await expect(drawer.getByText(/Peak/i)).toBeVisible({ timeout: 10_000 })
    await expect(drawer.getByText(/Delivery/i)).toBeVisible()
    await expect(drawer.getByText(/Planned squad cost/i)).toBeVisible()

    // ── Apply capacity profile ──
    const applyBtn = drawer.getByRole('button', { name: /apply capacity profile/i })
    await expect(applyBtn).toBeVisible()

    // Accept confirm dialogs
    page.on('dialog', dialog => dialog.accept())

    const applyResponse = page.waitForResponse(
      resp => resp.url().includes('/squad-plan/apply') && resp.request().method() === 'POST',
      { timeout: 20_000 },
    )
    await applyBtn.click()
    const response = await applyResponse
    expect(response.status()).toBe(201)

    // Drawer closes after successful apply
    await expect(drawer).not.toBeVisible({ timeout: 10_000 })

    // ── Verify via API that Squad Planner profiles exist ──
    const cpResp = await request.get(
      `${API_BASE}/api/projects/${projectId}/capacity-profiles`,
      { headers: authHeaders },
    )
    expect(cpResp.ok()).toBeTruthy()
    const cpData = await cpResp.json() as { capacityProfiles: Array<{ owner: { kind: string; id: string } | undefined; source: string }> }
    const devPlannerProfiles = cpData.capacityProfiles.filter(
      (p: { owner: { kind: string; id: string } | undefined; source: string }) =>
        p.owner?.kind === 'role' && p.owner?.id === devRt!.id,
    )
    expect(devPlannerProfiles.length).toBeGreaterThan(0)
    expect(devPlannerProfiles[0].source).toBe('squadPlanner')

    // ── Capture exact role-level weekly capacity BEFORE transfer via the real scheduler path ──
    // GET /timeline returns weeklyCapacity computed by the scheduler-facing resolver.
    async function fetchDevWeeklyCapacity(): Promise<Record<number, number>> {
      const resp = await request.get(
        `${API_BASE}/api/projects/${projectId}/timeline`,
        { headers: authHeaders },
      )
      expect(resp.ok()).toBeTruthy()
      const data = await resp.json() as { weeklyCapacity: Array<{ week: number; resourceTypeName: string; capacityDays: number }> }
      const weekly: Record<number, number> = {}
      for (const row of data.weeklyCapacity) {
        if (row.resourceTypeName?.toLowerCase().includes('developer')) {
          weekly[row.week] = row.capacityDays
        }
      }
      return weekly
    }
    const beforeWeekly = await fetchDevWeeklyCapacity()
    expect(Object.keys(beforeWeekly).length).toBeGreaterThan(0)

    // ── Capture Commercial billing-basis state before transfer ──
    const rpPreResp = await request.get(
      `${API_BASE}/api/projects/${projectId}/resource-profile`,
      { headers: authHeaders },
    )
    expect(rpPreResp.ok()).toBeTruthy()
    const rpPreData = await rpPreResp.json() as { resourceRows: Array<{ name: string; dayRate: number | null; estimatedCost: number | null }>; summary: { totalCost: number | null } }
    const devPreRow = rpPreData.resourceRows.find(r => r.name?.toLowerCase().includes('developer'))
    expect(devPreRow).toBeDefined()
    const commercialBefore = {
      dayRate: devPreRow!.dayRate,
      estimatedCost: devPreRow!.estimatedCost,
      totalCost: rpPreData.summary?.totalCost ?? null,
    }

    // ── Verify via API that Resource Profile shows planner-managed state ──
    const rpResp = await request.get(
      `${API_BASE}/api/projects/${projectId}/resource-profile`,
      { headers: authHeaders },
    )
    expect(rpResp.ok()).toBeTruthy()
    const rpData = await rpResp.json() as { resourceRows: Array<{ name: string; capacityProfile?: { source: string } }> }
    const devRowAPI = rpData.resourceRows.find(r => r.name?.toLowerCase().includes('developer'))
    expect(devRowAPI).toBeDefined()
    expect(devRowAPI!.capacityProfile?.source).toBe('squadPlanner')

    // ── Navigate to Resource Profile and verify UI state ──
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(
      page.getByRole('heading', { name: /resource profile/i }),
    ).toBeVisible({ timeout: 10_000 })

    // Find the Developer row
    const devRow = page.locator('tr').filter({ hasText: /Developer/i }).first()
    await expect(devRow).toBeVisible({ timeout: 15_000 })

    // Verify Squad Planner source badge (exact match — the badge span, not the Open Squad Planner button)
    await expect(devRow.getByText('Squad Planner', { exact: true })).toBeVisible({ timeout: 5_000 })

    // Verify the "Switch to manual capacity" button is visible
    await expect(devRow.getByTitle(/Transfer this role/)).toBeVisible({ timeout: 5_000 })

    // ── Transfer to manual capacity ──
    await devRow.getByTitle(/Transfer this role/).click()

    // Confirmation dialog should appear
    const confirmDialog = page.getByRole('dialog', { name: /Switch to manual capacity/i })
    await expect(confirmDialog).toBeVisible({ timeout: 5_000 })

    // Cancel should close the dialog
    await confirmDialog.getByText('Cancel').click()
    await expect(confirmDialog).not.toBeVisible({ timeout: 5_000 })

    // Re-open and confirm
    await devRow.getByTitle(/Transfer this role/).click()
    const confirmDialog2 = page.getByRole('dialog', { name: /Switch to manual capacity/i })
    await expect(confirmDialog2).toBeVisible({ timeout: 5_000 })

    // Wait for the transfer API call
    const transferResponse = page.waitForResponse(
      resp => resp.url().includes('/capacity-profiles/transfer-to-manual') && resp.request().method() === 'POST',
      { timeout: 15_000 },
    )
    await confirmDialog2.getByRole('button', { name: /Switch to manual capacity/i }).click()
    const transferResp = await transferResponse
    expect(transferResp.status()).toBe(200)

    // Dialog should close on success
    await expect(confirmDialog2).not.toBeVisible({ timeout: 10_000 })

    // ── Verify post-transfer state ──
    // The "Squad Planner" source badge should be gone (exact match)
    await expect(devRow.getByText('Squad Planner', { exact: true })).not.toBeVisible()
    // The "Switch to manual capacity" button should be gone
    await expect(devRow.getByTitle(/Transfer this role/)).not.toBeVisible()

    // The role should now be editable
    const editBadge = devRow.getByTitle('Click to edit capacity profile')
    await expect(editBadge).toBeVisible({ timeout: 10_000 })

    // ── Verify exact weekly capacity parity immediately after transfer via the real scheduler path ──
    const cpAfterTransferResp = await request.get(
      `${API_BASE}/api/projects/${projectId}/capacity-profiles`,
      { headers: authHeaders },
    )
    expect(cpAfterTransferResp.ok()).toBeTruthy()
    const cpAfterTransferData = await cpAfterTransferResp.json() as { capacityProfiles: Array<{ owner: { kind: string; id: string } | undefined; source: string }> }
    const devManualProfiles = cpAfterTransferData.capacityProfiles.filter(
      (p: { owner: { kind: string; id: string } | undefined; source: string }) =>
        p.owner?.kind === 'role' && p.owner?.id === devRt!.id,
    )
    expect(devManualProfiles.length).toBeGreaterThan(0)
    expect(devManualProfiles[0].source).toBe('manual')
    const afterTransferWeekly = await fetchDevWeeklyCapacity()
    expect(afterTransferWeekly).toEqual(beforeWeekly)

    // ── Open capacity profile editor and verify segments are preserved ──
    await editBadge.click()
    const editorDialog = page.getByRole('dialog', { name: /edit capacity profile/i })
    await expect(editorDialog).toBeVisible({ timeout: 8_000 })

    // Verify segments exist
    await expect(editorDialog.getByTestId('cp-seg-start-0')).toBeVisible({ timeout: 5_000 })

    // Record the first segment's week range (0-based, matching timeline indices)
    const firstSegStart = parseInt(await editorDialog.getByTestId('cp-seg-start-0').inputValue(), 10)
    const firstSegEnd = parseInt(await editorDialog.getByTestId('cp-seg-end-0').inputValue(), 10)

    // ── Edit the capacity: set first segment to exactly 50 ──
    await editorDialog.getByTestId('cp-seg-pct-0').fill('50')

    // Save
    const saveResp = page.waitForResponse(
      r => r.url().includes('/capacity-profiles/') && r.request().method() === 'PUT',
      { timeout: 15_000 },
    )
    await editorDialog.getByTestId('cp-save-btn').click()
    await saveResp
    await expect(editorDialog).not.toBeVisible({ timeout: 5_000 })

    // ── Verify via API that the manual state persisted ──
    const cpAfterResp = await request.get(
      `${API_BASE}/api/projects/${projectId}/capacity-profiles`,
      { headers: authHeaders },
    )
    expect(cpAfterResp.ok()).toBeTruthy()
    const cpAfterData = await cpAfterResp.json() as { capacityProfiles: Array<{ owner: { kind: string; id: string } | undefined; source: string }> }
    const devEditedProfiles = cpAfterData.capacityProfiles.filter(
      (p: { owner: { kind: string; id: string } | undefined; source: string }) =>
        p.owner?.kind === 'role' && p.owner?.id === devRt!.id,
    )
    expect(devEditedProfiles.length).toBeGreaterThan(0)
    expect(devEditedProfiles[0].source).toBe('manual')

    // ── Navigate to Timeline, click Update timeline, and wait for the scheduler request ──
    await page.goto(`/projects/${projectId}/timeline`)
    await expect(
      page.getByRole('heading', { name: /timeline planner/i }),
    ).toBeVisible({ timeout: 10_000 })

    const scheduleResponse = page.waitForResponse(
      resp => resp.url().includes('/timeline/schedule') && resp.request().method() === 'POST',
      { timeout: 20_000 },
    )
    await quickSchedule(page)
    const schedResp = await scheduleResponse
    expect(schedResp.status()).toBe(200)

    // ── Assert exact edited capacity through the real scheduler path ──
    const afterEditWeekly = await fetchDevWeeklyCapacity()
    // The timeline emits weeklyCapacity only across the schedule horizon
    // (0..maxWeek-1 plus the max demand week), which for this single-week
    // fixture is week 0 only. Assert every EMITTED week inside the edited
    // segment equals exactly 50% of a 5-day week = 2.5 days.
    const emittedEditedWeeks = Object.keys(afterEditWeekly)
      .map(Number)
      .filter(w => w >= firstSegStart && w <= firstSegEnd)
    expect(emittedEditedWeeks.length).toBeGreaterThan(0)
    for (const w of emittedEditedWeeks) {
      expect(afterEditWeekly[w]).toBe(2.5)
    }
    // Every week outside the edited segment retains its original capacity
    for (const [week, cap] of Object.entries(beforeWeekly)) {
      const w = Number(week)
      if (w >= firstSegStart && w <= firstSegEnd) continue
      expect(afterEditWeekly[w]).toBe(cap)
    }

    // ── Reload and verify the edited scheduler capacity is retained ──
    await page.reload()
    await expect(
      page.getByRole('heading', { name: /timeline planner/i }),
    ).toBeVisible({ timeout: 10_000 })
    const retainedWeekly = await fetchDevWeeklyCapacity()
    expect(retainedWeekly).toEqual(afterEditWeekly)

    // ── Verify Commercial billing-basis state unchanged ──
    const rpPostResp = await request.get(
      `${API_BASE}/api/projects/${projectId}/resource-profile`,
      { headers: authHeaders },
    )
    expect(rpPostResp.ok()).toBeTruthy()
    const rpPostData = await rpPostResp.json() as { resourceRows: Array<{ name: string; dayRate: number | null; estimatedCost: number | null }>; summary: { totalCost: number | null } }
    const devPostRow = rpPostData.resourceRows.find(r => r.name?.toLowerCase().includes('developer'))
    expect(devPostRow).toBeDefined()
    expect(devPostRow!.dayRate).toBe(commercialBefore.dayRate)
    expect(devPostRow!.estimatedCost).toBe(commercialBefore.estimatedCost)
    expect(rpPostData.summary?.totalCost ?? null).toBe(commercialBefore.totalCost)

    // ── Return to Resource Profile and confirm still editable ──
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(
      page.getByRole('heading', { name: /resource profile/i }),
    ).toBeVisible({ timeout: 10_000 })

    const devRowAfterNav = page.locator('tr').filter({ hasText: /Developer/i }).first()
    await expect(devRowAfterNav).toBeVisible({ timeout: 15_000 })

    // Confirm the role has not reverted to Squad Planner ownership
    await expect(devRowAfterNav.getByTitle('Click to edit capacity profile')).toBeVisible({ timeout: 10_000 })
    await expect(devRowAfterNav.getByText('Squad Planner', { exact: true })).not.toBeVisible()

    // Open editor to confirm the edit survived navigation
    await devRowAfterNav.getByTitle('Click to edit capacity profile').click()
    const editorAfterNav = page.getByRole('dialog', { name: /edit capacity profile/i })
    await expect(editorAfterNav).toBeVisible({ timeout: 8_000 })
    await expect(editorAfterNav.getByTestId('cp-seg-pct-0')).toHaveValue('50')
    await editorAfterNav.getByTestId('cp-cancel-btn').click()
    await expect(editorAfterNav).not.toBeVisible({ timeout: 5_000 })
  })
})
