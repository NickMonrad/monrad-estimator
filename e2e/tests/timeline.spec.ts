import { test, expect, type Page } from '@playwright/test'
import { login, createProject, openStartingTeamFinder, quickSchedule } from './helpers'
import path from 'path'
import fs from 'fs'
import os from 'os'

/**
 * Shared setup for timeline tests 2-4.
 * Creates a project with one epic + one feature, navigates to Timeline, sets the
 * start date to 2026-06-01, clicks Quick schedule, and waits for Gantt entries
 * (the sequential/parallel toggle on the epic header row is the earliest reliable
 * signal that at least one entry has been rendered).
 */
async function setupTimeline(page: Page): Promise<{ projectName: string; epicName: string; featureName: string }> {
  const suffix = Date.now()
  const projectName = `E2E Timeline Sched ${suffix}`
  const epicName = `E2E Sched Epic ${suffix}`
  const featureName = `E2E Sched Feature ${suffix}`

  await login(page)
  await createProject(page, projectName)

  // Open project hub → Backlog
  await page.getByRole('heading', { name: projectName, exact: true }).first().click()
  await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
  await page.getByRole('button', { name: /backlog/i }).click()

  // Add epic
  await expect(page.getByRole('button', { name: /add epic/i })).toBeVisible({ timeout: 8_000 })
  await page.getByRole('button', { name: /add epic/i }).click()
  await page.getByPlaceholder(/epic name/i).fill(epicName)
  await page.getByRole('button', { name: /save epic/i }).click()
  await expect(page.getByText(epicName)).toBeVisible({ timeout: 8_000 })

  // Add feature (epic auto-expands after creation)
  await expect(page.getByText('+ Add feature')).toBeVisible({ timeout: 5_000 })
  await page.getByText('+ Add feature').click()
  await page.getByPlaceholder('Feature name *').fill(featureName)
  await page.getByRole('button', { name: /^save$/i }).click()
  await expect(page.getByText(featureName)).toBeVisible({ timeout: 8_000 })

  // Navigate from BacklogPage back to the project hub, then to Timeline.
  // The backlog URL is /projects/:id/backlog — strip the suffix to get the hub URL.
  const hubUrl = page.url().replace('/backlog', '')
  await page.goto(hubUrl)
  await page.getByRole('button', { name: /timeline/i }).waitFor({ timeout: 8_000 })
  await page.getByRole('button', { name: /timeline/i }).click()
  await expect(page.getByRole('heading', { name: /timeline planner/i })).toBeVisible({ timeout: 8_000 })

  // Set start date — fill triggers React onChange which updates startDateInput state.
  // Wait for the DOM value to stabilise before clicking Quick schedule so that
  // handleSchedule reads the correct startDateInput value.
  const dateInput = page.locator('input[type="date"]')
  await expect(dateInput).toBeVisible({ timeout: 8_000 })
  await dateInput.fill('2026-06-01')
  await expect(dateInput).toHaveValue('2026-06-01')

  // Quick schedule — the server assigns 1-week default duration to features with no tasks,
  // so even a fresh epic/feature will produce Gantt entries.
  await quickSchedule(page)

  // Wait until the Gantt has at least one entry. The sequential/parallel toggle button
  // on the epic header row only renders after epicGroups is populated.
  await expect(
    page.getByRole('button', { name: /sequential|parallel/i }).first()
  ).toBeVisible({ timeout: 15_000 })

  return { projectName, epicName, featureName }
}

test.describe('Timeline', () => {
  test('start date persists after navigation (bug #44)', async ({ page }) => {
    const projectName = `E2E Timeline ${Date.now()}`

    // Step 1: Login and land on Projects page
    await login(page)

    // Step 2: Create a new project with a unique name
    await createProject(page, projectName)

    // Step 3: Open the project hub and navigate to the Timeline page
    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    // Wait for the project hub to fully render (hub has a "Timeline" button)
    await page.getByRole('button', { name: /timeline/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /timeline/i }).click()

    // Wait for the Timeline Planner page to load
    await expect(
      page.getByRole('heading', { name: /timeline planner/i })
    ).toBeVisible({ timeout: 8_000 })

    // Store the URL so we can return here after navigating away
    const timelineUrl = page.url()

    // Step 4: Set the start date input to a specific date
    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toBeVisible({ timeout: 8_000 })

    // Step 5: Set the start date and save it.
    //
    // React 18 batches state updates: when `fill` triggers `onChange → setState`,
    // the new startDateInput value is NOT yet committed when blur fires if we
    // trigger it immediately.  `handleStartDateBlur` would then read stale state
    // (startDateInput = '') and skip the PATCH.
    //
    // Strategy:
    //  1. Set up the PATCH response listener first (before any interaction).
    //  2. `fill` the input (triggers React onChange → schedules state update).
    //  3. `waitForFunction` polls until React has committed and the input's
    //     reactive value is reflected – then we know startDateInput = '2026-06-01'.
    //  4. Click the "Resource Counts" toggle button to steal focus → browser fires
    //     blur on the date input → handleStartDateBlur runs with the committed state
    //     → PATCH is sent.
    const savePromise = page.waitForResponse(
      resp => resp.url().includes('start-date') && resp.request().method() === 'PATCH',
      { timeout: 10_000 }
    )
    await dateInput.fill('2026-06-01')
    // Wait until React has committed the onChange state update.
    // We do this by waiting for the input's DOM value to stabilise (Playwright's
    // toHaveValue uses the accessible value which matches the DOM attribute) –
    // by the time this assertion passes React will have flushed its work.
    await expect(dateInput).toHaveValue('2026-06-01')
    // Now blur by clicking the Resource Counts panel toggle (no navigation/API side-effects).
    // The browser fires blur on the date input during mousedown, at which point
    // handleStartDateBlur reads startDateInput = '2026-06-01' and sends the PATCH.
    await page.locator('button', { hasText: 'Resource Counts' }).first().click()
    const saveResp = await savePromise
    expect(saveResp.status()).toBe(200) // Confirm the PATCH actually saved

    // Step 6: Navigate away to the Projects page
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /^projects$/i })).toBeVisible()

    // Step 7: Navigate back to the same project's Timeline page
    await page.goto(timelineUrl)
    await expect(
      page.getByRole('heading', { name: /timeline planner/i })
    ).toBeVisible({ timeout: 8_000 })

    // Step 8: Assert the start date input still shows the value we saved
    // The useEffect in TimelinePage seeds startDateInput from project.startDate on load
    await expect(page.locator('input[type="date"]')).toHaveValue('2026-06-01', {
      timeout: 8_000,
    })
  })

  test('quick schedule shows projected end date', async ({ page }) => {
    await setupTimeline(page)

    // After setupTimeline the Gantt entries are already visible. The projectedEndDate
    // field is rendered next to the Quick schedule action whenever timeline?.projectedEndDate
    // is truthy. It should appear shortly after scheduling completes.
    await expect(page.getByText(/projected end:/i)).toBeVisible({ timeout: 15_000 })
  })

  test('sequential/parallel toggle is visible on epic rows', async ({ page }) => {
    await setupTimeline(page)

    // setupTimeline already waits for this button before returning, so this is a
    // final assertion rather than a wait — it also verifies the button text matches.
    await expect(
      page.getByRole('button', { name: /sequential|parallel/i }).first()
    ).toBeVisible({ timeout: 10_000 })
  })

  test('feature dependency section visible in inline edit panel', async ({ page }) => {
    const { featureName } = await setupTimeline(page)

    // Click the feature name label in the Gantt label column (a cursor-pointer div).
    // Use .first() because the feature name text may also appear in other contexts.
    await page.getByText(featureName).first().click()

    // The inline edit panel (bg-blue-50) should appear below the feature row.
    // It contains the "Depends on" section and the "+ Add dependency…" select.
    await expect(page.getByText(/depends on/i).first()).toBeVisible({ timeout: 8_000 })

    // The add-dependency select renders as a combobox role; its first option is
    // the empty placeholder "+ Add dependency…"
    await expect(page.getByRole('combobox').filter({ hasText: /add dependency/i })).toBeVisible({
      timeout: 8_000,
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Cache invalidation — manual feature override updates Resource Profile
// Fixes: stale weeklyDemandCache after PUT /timeline/:featureId
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CSV seed with Developer + Tech Lead resource types so the Resource Profile
 * shows meaningful person-day values after scheduling. Both types are seeded
 * from global resource types on every new project.
 */
const CACHE_INV_CSV = [
  'Type,Epic,Feature,Story,Task,Template,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus',
  'Epic,Platform Build,,,,,,,,,,,,',
  'Feature,Platform Build,Core API,,,,,,,,,,,',
  'Story,Platform Build,Core API,API Design,,,,,,,,,,',
  'Task,Platform Build,Core API,API Design,Implement,,Developer,40,5,,,,,',
  'Task,Platform Build,Core API,API Design,Review,,Tech Lead,16,2,,,,,',
].join('\n')

test.describe('Timeline — cache invalidation', () => {
  test('manual feature override clears demand cache — Resource Profile and Commercial render correctly', async ({ page }) => {
    test.setTimeout(90_000)

    const projectName = `E2E CacheInv ${Date.now()}`

    // ── Login and create project ──
    await login(page)
    await createProject(page, projectName)

    // ── Navigate to Backlog and seed CSV ──
    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /backlog/i }).click()

    await expect(page.getByRole('button', { name: /import csv/i })).toBeVisible({ timeout: 8_000 })
    const tmpFile = path.join(os.tmpdir(), `cache-inv-${Date.now()}.csv`)
    fs.writeFileSync(tmpFile, CACHE_INV_CSV)
    await page.getByRole('button', { name: /import csv/i }).click()
    await page.locator('input[type="file"]').setInputFiles(tmpFile)
    fs.unlinkSync(tmpFile)
    await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
    await expect(page.getByText('Platform Build')).toBeVisible({ timeout: 10_000 })

    // ── Navigate to Timeline ──
    const projectId = page.url().match(/\/projects\/([^/]+)/)?.[1]!
    await page.goto(`/projects/${projectId}`)
    await page.getByRole('button', { name: /timeline/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /timeline/i }).click()
    await expect(
      page.getByRole('heading', { name: /timeline planner/i })
    ).toBeVisible({ timeout: 8_000 })

    // ── Set start date and Quick schedule ──
    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toBeVisible({ timeout: 8_000 })
    await dateInput.fill('2026-06-01')
    await expect(dateInput).toHaveValue('2026-06-01')
    await quickSchedule(page)
    await expect(
      page.getByRole('button', { name: /sequential|parallel/i }).first()
    ).toBeVisible({ timeout: 15_000 })

    // ── Manual override: move feature to week 5 ──
    const featureLabel = page.locator('[title="Core API"]').first()
    await featureLabel.click()
    await expect(page.getByText('Start week:').first()).toBeVisible({ timeout: 8_000 })
    await page.locator('input[min="0"]').first().fill('5')
    await page.getByRole('button', { name: /^save$/i }).click()
    await expect(
      page.getByRole('button', { name: /reset to auto/i })
    ).toBeVisible({ timeout: 10_000 })

    // ── Navigate to Resource Profile (cache was cleared by the manual override) ──
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(
      page.getByRole('heading', { name: /resource profile/i })
    ).toBeVisible({ timeout: 10_000 })

    // Verify both resource type rows render from recomputed fallback demand
    const developerRow = page.locator('tr').filter({ hasText: /developer/i }).first()
    await expect(developerRow).toBeVisible({ timeout: 15_000 })
    // Row should contain formatted person-day values (e.g. "40.00 h")
    const devText = await developerRow.textContent()
    expect(devText).toMatch(/\d+\.\d{2}\s*h/i)

    const techLeadRow = page.locator('tr').filter({ hasText: /tech lead/i }).first()
    await expect(techLeadRow).toBeVisible({ timeout: 10_000 })
    const tlText = await techLeadRow.textContent()
    expect(tlText).toMatch(/\d+\.\d{2}\s*h/i)

    // ── Switch to Commercial tab — verify cost summary loads ──
    await page.getByRole('button', { name: /commercial/i }).click()
    await expect(
      page.getByRole('heading', { name: /cost summary/i })
    ).toBeVisible({ timeout: 10_000 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Starting Team Finder drawer — Phase 4, issue #233
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal CSV that creates a Developer + Tech Lead resource type so the
 * Optimiser has a non-trivial search space.
 */
const OPTIMISER_CSV = [
  'Type,Epic,Feature,Story,Task,Template,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus',
  'Epic,Opt Epic,,,,,,,,,,active,,',
  'Feature,Opt Epic,Opt Feature,,,,,,,,,,,',
  'Story,Opt Epic,Opt Feature,Opt Story,,,,,,,,,,active',
  'Task,Opt Epic,Opt Feature,Opt Story,Dev Task A,,Developer,16,2,,,,,',
  'Task,Opt Epic,Opt Feature,Opt Story,Dev Task B,,Developer,8,1,,,,,',
  'Task,Opt Epic,Opt Feature,Opt Story,Lead Task,,Tech Lead,8,1,,,,,',
].join('\n')

/**
 * Creates a fresh project, seeds it with resource types via CSV import,
 * navigates to the Timeline page, and runs Quick schedule.
 * Resources (Developer + Tech Lead) are required for the finder action
 * button to be enabled.
 */
async function setupOptimiserTimeline(page: Page): Promise<void> {
  const suffix = Date.now()
  const projectName = `E2E Optimiser ${suffix}`

  await login(page)
  await createProject(page, projectName)

  // Open project hub → Backlog
  await page.getByRole('heading', { name: projectName, exact: true }).first().click()
  await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
  await page.getByRole('button', { name: /backlog/i }).click()

  // Import CSV to seed resource types
  await expect(page.getByRole('button', { name: /import csv/i })).toBeVisible({ timeout: 8_000 })
  await page.getByRole('button', { name: /import csv/i }).click()
  const tmpFile = path.join(os.tmpdir(), `optimiser-seed-${suffix}.csv`)
  fs.writeFileSync(tmpFile, OPTIMISER_CSV)
  await page.locator('input[type="file"]').setInputFiles(tmpFile)
  fs.unlinkSync(tmpFile)

  // Two-step staging confirmation
  await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
  await expect(page.getByText('Opt Epic')).toBeVisible({ timeout: 10_000 })

  // Navigate to Timeline
  const projectId = page.url().match(/\/projects\/([^/]+)/)?.[1]!
  await page.goto(`/projects/${projectId}`)
  await page.getByRole('button', { name: /timeline/i }).waitFor({ timeout: 8_000 })
  await page.getByRole('button', { name: /timeline/i }).click()
  await expect(page.getByRole('heading', { name: /timeline planner/i })).toBeVisible({ timeout: 8_000 })

  // Set a start date and run Quick schedule so the scheduler has produced entries
  const dateInput = page.locator('input[type="date"]')
  await expect(dateInput).toBeVisible({ timeout: 8_000 })
  await dateInput.fill('2026-06-01')
  await expect(dateInput).toHaveValue('2026-06-01')
  await quickSchedule(page)
  await expect(
    page.getByRole('button', { name: /sequential|parallel/i }).first()
  ).toBeVisible({ timeout: 15_000 })
}

// ── Test 1: open & close ──────────────────────────────────────────────────────
// Uses the lighter setupTimeline (no CSV needed for open/close alone).
test.describe('Starting Team Finder drawer — open and close', () => {
  test('open and close the drawer', async ({ page }) => {
    await setupTimeline(page)

    const drawer = await openStartingTeamFinder(page)
    await expect(drawer.getByRole('heading', { name: /starting team finder/i })).toBeVisible()

    // Close via the × button (aria-label="Close")
    await drawer.getByRole('button', { name: 'Close' }).click()

    // Drawer must be gone from the DOM
    await expect(drawer).not.toBeVisible({ timeout: 5_000 })
  })
})

// ── Tests 2 & 3: require resource types ──────────────────────────────────────
test.describe('Starting Team Finder drawer — with resources', () => {
  test.beforeEach(async ({ page }) => {
    // CSV import + navigation takes ~20-30s; allow 90s total
    test.setTimeout(90_000)
    await setupOptimiserTimeline(page)
  })

  test('run optimiser and see results', async ({ page }) => {
    const drawer = await openStartingTeamFinder(page)

    // Click the finder CTA
    await drawer.getByRole('button', { name: /find starting teams/i }).click()

    // Wait for search stats footer (up to 30s for the optimiser to complete)
    // Rendered as: "Evaluated X team options in Y.Zs"
    await expect(drawer.getByText(/Evaluated [\d,]+ team options/)).toBeVisible({ timeout: 30_000 })

    // Baseline card must be visible
    await expect(drawer.getByText('Current starting point')).toBeVisible()

    // At least one candidate card — the exact "Starting team options" section label + at least one Apply directly button
    const startingTeamOptions = drawer.locator('div').filter({ hasText: /^Starting team options$/ }).first()
    await expect(startingTeamOptions).toBeVisible()
    await expect(drawer.getByRole('button', { name: /apply directly/i }).first()).toBeVisible()
  })

  test('apply button is present on candidate cards, dialog is dismissed without mutation', async ({ page }) => {
    const drawer = await openStartingTeamFinder(page)

    await drawer.getByRole('button', { name: /find starting teams/i }).click()
    await expect(drawer.getByText(/Evaluated [\d,]+ team options/)).toBeVisible({ timeout: 30_000 })
    const startingTeamOptions = drawer.locator('div').filter({ hasText: /^Starting team options$/ }).first()
    await expect(startingTeamOptions).toBeVisible()

    // Each candidate card has a visible Apply directly button
    const applyButtons = drawer.getByRole('button', { name: /apply directly/i })
    const count = await applyButtons.count()
    expect(count).toBeGreaterThan(0)

    // Click Apply on the first card but DISMISS the confirm dialog so no data is mutated
    page.once('dialog', dialog => dialog.dismiss())
    await applyButtons.first().click()

    // Drawer must still be open (apply was aborted by the user)
    await expect(drawer).toBeVisible({ timeout: 5_000 })
  })
})
