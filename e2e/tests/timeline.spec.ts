import { test, expect, type Page, type Request, type Locator } from '@playwright/test'
import { login, createProject, openStartingTeamFinder, quickSchedule, DATABASE_URL } from './helpers'
import { Client } from 'pg'
import path from 'path'
import fs from 'fs'
import os from 'os'

/**
 * Shared setup for timeline tests 2-4.
 * Creates a project with one epic + one feature, navigates to Timeline, sets the
 * start date to 2026-06-01, clicks Update timeline, and waits for Gantt entries
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
  // Wait for the DOM value to stabilise before clicking Update timeline so that
  // handleSchedule reads the correct startDateInput value.
  const dateInput = page.locator('input[type="date"]')
  await expect(dateInput).toBeVisible({ timeout: 8_000 })
  await dateInput.fill('2026-06-01')
  await expect(dateInput).toHaveValue('2026-06-01')

  // Update timeline — the server assigns 1-week default duration to features with no tasks,
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

  test('update timeline shows projected end date', async ({ page }) => {
    await setupTimeline(page)

    // After setupTimeline the Gantt entries are already visible. The projectedEndDate
    // field is rendered next to the Update timeline action whenever timeline?.projectedEndDate
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

    // ── Set start date and Update timeline ──
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
    await page.locator('input[min="0"]:not([id])').first().fill('5')
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
  'Task,Opt Epic,Opt Feature,Opt Story,Ramp Task 1,,Developer,80,10,,,,,',
  'Task,Opt Epic,Opt Feature,Opt Story,Ramp Task 2,,Developer,80,10,,,,,',
  'Task,Opt Epic,Opt Feature,Opt Story,Ramp Task 3,,Developer,80,10,,,,,',
].join('\n')

/**
 * Creates a fresh project, seeds it with resource types via CSV import,
 * navigates to the Timeline page, and runs Update timeline.
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

  // Set a start date and run Update timeline so the scheduler has produced entries
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

  test('apply candidate passes the validated optimiser scope from the response', async ({ page }) => {
    const drawer = await openStartingTeamFinder(page)

    // Register the optimiser response waiter BEFORE clicking Find starting teams
    const optimiserResponse = page.waitForResponse(
      response => response.url().includes('/optimise') && !response.url().includes('/apply') && response.request().method() === 'POST',
      { timeout: 30_000 },
    )

    await drawer.getByRole('button', { name: /find starting teams/i }).click()
    await expect(drawer.getByText(/Evaluated [\d,]+ team options/)).toBeVisible({ timeout: 30_000 })
    await expect(drawer.getByRole('button', { name: /apply directly/i }).first()).toBeVisible()

    const optimiserBody = await (await optimiserResponse).json() as {
      optimiserScopeResourceTypeIds: string[]
    }

    const applyResponse = page.waitForResponse(
      response => response.url().includes('/optimise/apply') && response.request().method() === 'POST',
      { timeout: 15_000 },
    )
    page.once('dialog', dialog => dialog.accept())
    await drawer.getByRole('button', { name: /apply directly/i }).first().click()

    const response = await applyResponse
    expect(response.status()).toBe(200)
    const payload = response.request().postDataJSON() as {
      resourceTypes: Array<{ resourceTypeId: string; suggestedStartWeek: number }>
      optimiserScopeResourceTypeIds: string[]
    }
    expect(payload.optimiserScopeResourceTypeIds).toEqual(optimiserBody.optimiserScopeResourceTypeIds)
  })

  test('deterministic ramp-up apply creates optimiser-derived profile, cross-view parity and snapshot undo', async ({ page }) => {
    const projectId = page.url().match(/\/projects\/([^/]+)/)?.[1]!
    if (!projectId) throw new Error('Could not determine project ID')

    const db = new Client({ connectionString: DATABASE_URL })
    await db.connect()

    try {
      // ── 1. Discover Developer RT ────────────────────────────────────────
      const preData = await page.evaluate(async ({ id }) => {
        const token = localStorage.getItem('token')
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
        const resourceTypes = await (await fetch(`/api/projects/${id}/resource-types`, { headers })).json() as Array<{ id: string; name: string; count: number }>
        const devRt = resourceTypes.find(rt => rt.name === 'Developer')
        if (!devRt) throw new Error('Developer RT not found')
        return { devRtId: devRt.id, devRtCount: devRt.count }
      }, { id: projectId })

      // ── 2. Create named resource with NO_PROFILE ─────────────────────────
      const nrResult = await page.evaluate(async ({ id, devRtId }) => {
        const token = localStorage.getItem('token')
        const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
        const res = await fetch(`/api/projects/${id}/resource-types/${devRtId}/named-resources`, {
          method: 'POST', headers,
          body: JSON.stringify({ name: 'Ramp-Up Alice', allocationMode: 'EFFORT' }),
        })
        if (!res.ok) throw new Error(`POST named-resource failed: ${await res.text()}`)
        return { nrId: (await res.json() as { id: string }).id }
      }, { id: projectId, devRtId: preData.devRtId })
      expect(nrResult.nrId).toBeTruthy()

      // Delete the CapacityProfile so the NR has NO_PROFILE
      await db.query(`DELETE FROM "CapacitySegment" WHERE "capacityProfileId" IN (SELECT id FROM "CapacityProfile" WHERE "namedResourceId" = $1 AND "projectId" = $2)`, [nrResult.nrId, projectId])
      const delResult = await db.query(`DELETE FROM "CapacityProfile" WHERE "namedResourceId" = $1 AND "projectId" = $2`, [nrResult.nrId, projectId])
      if ((delResult.rowCount ?? 0) === 0) throw new Error('No CapacityProfile found to delete')


      // ── 4. Push Developer demand past week 0 ─────────────────────────────
      const featureLabel = page.locator('[title="Opt Feature"]').first()
      await featureLabel.click()
      await expect(page.getByText('Start week:').first()).toBeVisible({ timeout: 8_000 })
      await page.locator('input[min="0"]:not([id])').first().fill('5')
      await page.getByRole('button', { name: /^save$/i }).click()
      await quickSchedule(page)
      await expect(page.getByRole('button', { name: /sequential|parallel/i }).first()).toBeVisible({ timeout: 15_000 })

      // ── 3. Capture pre-apply state (after feature delay, before optimiser) ─
      // 3a. SQL: NamedResource compatibility fields
      const preNrSql = await db.query(`SELECT * FROM "NamedResource" WHERE "id" = $1`, [nrResult.nrId])
      expect(preNrSql.rows).toHaveLength(1)
      const preNr = preNrSql.rows[0]
      expect(preNr.allocationMode).toBe('EFFORT')
      expect(preNr.allocationPercent).toBe(100)
      expect(preNr.allocationPct).toBe(100)
      expect(preNr.allocationStartWeek).toBeNull()
      expect(preNr.allocationEndWeek).toBeNull()
      expect(preNr.startWeek).toBeNull()
      expect(preNr.endWeek).toBeNull()

      // 3b. SQL: zero profiles + zero segments
      const preCpRows = await db.query(`SELECT * FROM "CapacityProfile" WHERE "namedResourceId" = $1 AND "projectId" = $2`, [nrResult.nrId, projectId])
      expect(preCpRows.rows).toHaveLength(0)
      const preSegRows = await db.query(`SELECT cs.* FROM "CapacitySegment" cs JOIN "CapacityProfile" cp ON cs."capacityProfileId" = cp.id WHERE cp."namedResourceId" = $1 AND cp."projectId" = $2`, [nrResult.nrId, projectId])
      expect(preSegRows.rows).toHaveLength(0)

      // 3c. Resource Profile reader with named-resource detail
      const preState = await page.evaluate(async ({ id, nrId }) => {
        const token = localStorage.getItem('token')
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
        const rp = await (await fetch(`/api/projects/${id}/resource-profile`, { headers })).json() as {
          resourceRows: Array<{
            resourceTypeId: string; name: string; count: number
            namedResources: Array<{
              id: string; allocationMode: string; allocationPercent: number; allocationPct: number
              allocationStartWeek: number | null; allocationEndWeek: number | null
              startWeek: number | null; endWeek: number | null
              actualAllocationStartWeek: number | null; actualAllocationEndWeek: number | null
              capacityProfile?: { resolutionSource: string; planningBasis: string; source: string }
            }>
          }>
        }
        const devRow = rp.resourceRows.find(r => r.namedResources.some(nr => nr.id === nrId))
        const devNr = devRow?.namedResources.find(nr => nr.id === nrId)
        return { devRow: devRow ? { resourceTypeId: devRow.resourceTypeId, count: devRow.count, namedResources: devRow.namedResources } : null, devNr: devNr ?? null }
      }, { id: projectId, nrId: nrResult.nrId })
      expect(preState.devNr).toBeDefined()
      const preRpNr = preState.devNr!
      expect(preRpNr.capacityProfile).toBeDefined()
      expect(preRpNr.capacityProfile!.resolutionSource).toBe('LEGACY')
      expect(preRpNr.capacityProfile!.source).toBe('fixed')

      // 3d. Timeline reader
      const preTl = await page.evaluate(async ({ id, nrId }) => {
        const token = localStorage.getItem('token')
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
        const tl = await (await fetch(`/api/projects/${id}/timeline`, { headers })).json() as {
          namedResources: Array<{
            id: string; startWeek: number | null; endWeek: number | null
            allocationMode: string; allocationPercent: number
          }>
        }
        return tl.namedResources.find(nr => nr.id === nrId) ?? null
      }, { id: projectId, nrId: nrResult.nrId })
      expect(preTl).toBeDefined()
      const preTlNr = preTl!
      expect(preTlNr.id).toBe(nrResult.nrId)

      const preCount = preData.devRtCount

      // ── 5. Open drawer and run optimiser with ramp-up enabled ──────────
      const drawer = await openStartingTeamFinder(page)

      const rampUpLabel = drawer.locator('label').filter({ hasText: /include later ramp-up/i })
      await rampUpLabel.locator('input[type="checkbox"]').check()
      await expect(rampUpLabel.locator('input[type="checkbox"]')).toBeChecked()

      const optimiserResponse = page.waitForResponse(
        r => r.url().includes('/optimise') && !r.url().includes('/apply') && r.request().method() === 'POST',
        { timeout: 30_000 },
      )

      await drawer.getByRole('button', { name: /find starting teams/i }).click()
      await expect(drawer.getByText(/Evaluated [\d,]+ team options/)).toBeVisible({ timeout: 30_000 })
      await expect(drawer.getByRole('button', { name: /apply directly/i }).first()).toBeVisible()

      const optimiserBody = await (await optimiserResponse).json() as {
        optimiserScopeResourceTypeIds: string[]
        candidates: Array<{ resourceTypes: Array<{ resourceTypeId: string; count: number; suggestedStartWeek: number }> }>
      }

      expect(optimiserBody.optimiserScopeResourceTypeIds).toContain(preData.devRtId)
      const fullScope = optimiserBody.optimiserScopeResourceTypeIds

      const qualifyingIndex = optimiserBody.candidates.findIndex(
        c => c.resourceTypes.some(rt => rt.resourceTypeId === preData.devRtId && rt.suggestedStartWeek > 0)
      )
      expect(qualifyingIndex).toBeGreaterThanOrEqual(0)
      const candidate = optimiserBody.candidates[qualifyingIndex]
      const devCand = candidate.resourceTypes.find(rt => rt.resourceTypeId === preData.devRtId)!
      const rampUpWeek = devCand.suggestedStartWeek
      const rampUpCount = devCand.count
      expect(rampUpWeek).toBeGreaterThan(0)
      expect(rampUpCount).toBeGreaterThan(preData.devRtCount)

      // ── 6. Apply the qualifying candidate via UI ─────────────────────────
      const applyResponseWaiter = page.waitForResponse(
        r => r.url().includes('/optimise/apply') && r.request().method() === 'POST',
        { timeout: 15_000 },
      )
      page.once('dialog', dialog => dialog.accept())
      await drawer.getByRole('button', { name: /apply directly/i }).nth(qualifyingIndex).click()

      const applyResponse = await applyResponseWaiter
      expect(applyResponse.status()).toBe(200)

      const applyPayload = applyResponse.request().postDataJSON() as {
        resourceTypes: Array<{ resourceTypeId: string; count: number; suggestedStartWeek: number }>
        optimiserScopeResourceTypeIds: string[]
      }
      const appliedDev = applyPayload.resourceTypes.find(rt => rt.resourceTypeId === preData.devRtId)
      expect(appliedDev).toBeDefined()
      expect(appliedDev!.suggestedStartWeek).toBe(rampUpWeek)
      expect(appliedDev!.count).toBe(rampUpCount)
      expect(applyPayload.optimiserScopeResourceTypeIds).toEqual(fullScope)

      const snapshotId = (await applyResponse.json() as { snapshotId: string }).snapshotId
      expect(snapshotId).toBeTruthy()

      // ── 7. Verify authoritative profile-first persistence ──────────────
      const postCpRows = await db.query(`SELECT * FROM "CapacityProfile" WHERE "namedResourceId" = $1 AND "projectId" = $2`, [nrResult.nrId, projectId])
      expect(postCpRows.rows).toHaveLength(1)
      const postCp = postCpRows.rows[0]
      expect(postCp.ownerKind).toBe('NAMED_PERSON')
      expect(postCp.namedResourceId).toBe(nrResult.nrId)
      expect(postCp.resourceTypeId).toBeNull()
      expect(postCp.planningBasis).toBe('AVAILABILITY_WINDOW')
      expect(postCp.source).toBe('DERIVED')
      expect(postCp.startWeek).toBe(rampUpWeek)
      expect(postCp.endWeek).toBeNull()
      expect(postCp.defaultPercent).toBe(100)
      // Resource Optimiser provenance marker in legacy
      expect(postCp.legacy).toEqual({ version: 1, writer: 'RESOURCE_OPTIMISER' })
      const createdProfileId = postCp.id
      const postSegRows = await db.query(`SELECT * FROM "CapacitySegment" WHERE "capacityProfileId" = $1`, [postCp.id])
      expect(postSegRows.rows).toHaveLength(0)

      // 7c. NamedResource compatibility fields equal profile projection
      const postNrSql = await db.query(`SELECT * FROM "NamedResource" WHERE "id" = $1`, [nrResult.nrId])
      expect(postNrSql.rows).toHaveLength(1)
      const postNr = postNrSql.rows[0]
      // NamedResource compatibility fields: all 7 asserted against authoritative profile
      expect(postNr.allocationMode).toBe('TIMELINE') // AVAILABILITY_WINDOW projects to TIMELINE
      expect(postNr.allocationPercent).toBe(postCp.defaultPercent)
      expect(postNr.allocationPct).toBe(postCp.defaultPercent)
      expect(postNr.allocationStartWeek).toBe(postCp.startWeek)
      expect(postNr.allocationEndWeek).toBe(postCp.endWeek)
      expect(postNr.startWeek).toBe(postCp.startWeek)
      expect(postNr.endWeek).toBe(postCp.endWeek)
      const postRp = await page.evaluate(async ({ id, nrId }) => {
        const token = localStorage.getItem('token')
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
        const rp = await (await fetch(`/api/projects/${id}/resource-profile`, { headers })).json() as {
          resourceRows: Array<{
            resourceTypeId: string; count: number
            namedResources: Array<{
              id: string; allocationMode: string; allocationPercent: number; allocationPct: number
              allocationStartWeek: number | null; allocationEndWeek: number | null
              startWeek: number | null; endWeek: number | null
              actualAllocationStartWeek: number | null; actualAllocationEndWeek: number | null
              capacityProfile?: { resolutionSource: string; planningBasis: string; source: string }
            }>
          }>
        }
        const devRow = rp.resourceRows.find(r => r.namedResources.some(nr => nr.id === nrId))
        const devNr = devRow?.namedResources.find(nr => nr.id === nrId) ?? null
        return { devRow: devRow ? { resourceTypeId: devRow.resourceTypeId, count: devRow.count } : null, devNr }
      }, { id: projectId, nrId: nrResult.nrId })
      expect(postRp.devNr).toBeDefined()
      const postRpNr = postRp.devNr!
      // Resolved from authoritative profile
      expect(postRpNr.capacityProfile).toBeDefined()
      expect(postRpNr.capacityProfile!.resolutionSource).toBe('PROFILE')
      expect(postRpNr.capacityProfile!.planningBasis).toBe('availabilityWindow')
      expect(postRpNr.capacityProfile!.source).toBe('derived')
      // Effective availability — all fields match authoritative profile
      expect(postRpNr.allocationMode).toBe('TIMELINE')
      expect(postRpNr.allocationPercent).toBe(postCp.defaultPercent)
      expect(postRpNr.allocationPct).toBe(postCp.defaultPercent)
      expect(postRpNr.allocationStartWeek).toBe(postCp.startWeek)
      expect(postRpNr.allocationEndWeek).toBe(postCp.endWeek)
      expect(postRpNr.startWeek).toBe(postCp.startWeek)
      expect(postRpNr.endWeek).toBe(postCp.endWeek)
      // actualAllocationStartWeek matches profile start (actualAllocationEndWeek is
      // scheduler-computed and may differ from the profile's open-ended null endWeek)
      expect(postRpNr.actualAllocationStartWeek).toBe(postCp.startWeek)
      // ── 9. Timeline parity ─────────────────────────────────────────────
      const postTl = await page.evaluate(async ({ id, nrId }) => {
        const token = localStorage.getItem('token')
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
        const tl = await (await fetch(`/api/projects/${id}/timeline`, { headers })).json() as {
          namedResources: Array<{
            id: string; startWeek: number | null; endWeek: number | null
            allocationMode: string; allocationPercent: number
          }>
        }
        return tl.namedResources.find(nr => nr.id === nrId) ?? null
      }, { id: projectId, nrId: nrResult.nrId })
      expect(postTl).toBeDefined()
      const postTlNr = postTl!
      expect(postTlNr.startWeek).toBe(rampUpWeek)
      expect(postTlNr.endWeek).toBe(postCp.endWeek)
      expect(postTlNr.allocationPercent).toBe(postCp.defaultPercent)
      expect(postTlNr.allocationMode).toBe('TIMELINE')

      // ── 10. Undo via snapshot rollback ──────────────────────────────────
      const undoResult = await page.evaluate(async ({ id, snapshotId }) => {
        const token = localStorage.getItem('token')
        const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
        const res = await fetch(`/api/projects/${id}/snapshots/${snapshotId}/rollback`, { method: 'POST', headers })
        return { status: res.status }
      }, { id: projectId, snapshotId })
      expect(undoResult.status).toBe(200)

      // ── 11. Verify exact state restoration (no conditional bypass) ─────
      // 11a. SQL: profile removed
      const restCpRows = await db.query(`SELECT * FROM "CapacityProfile" WHERE "namedResourceId" = $1 AND "projectId" = $2`, [nrResult.nrId, projectId])
      expect(restCpRows.rows).toHaveLength(0)
      const restSegRows = await db.query(
        `SELECT * FROM "CapacitySegment" WHERE "capacityProfileId" = $1`,
        [createdProfileId],
      )
      expect(restSegRows.rows).toHaveLength(0)

      // 11b. SQL: NamedResource compatibility fields restored exactly
      const restNrSql = await db.query(`SELECT * FROM "NamedResource" WHERE "id" = $1`, [nrResult.nrId])
      expect(restNrSql.rows).toHaveLength(1)
      const restNr = restNrSql.rows[0]
      expect(restNr.allocationMode).toBe(preNr.allocationMode)
      expect(restNr.allocationPercent).toBe(preNr.allocationPercent)
      expect(restNr.allocationPct).toBe(preNr.allocationPct)
      expect(restNr.allocationStartWeek).toBe(preNr.allocationStartWeek)
      expect(restNr.allocationEndWeek).toBe(preNr.allocationEndWeek)
      expect(restNr.startWeek).toBe(preNr.startWeek)
      expect(restNr.endWeek).toBe(preNr.endWeek)

      // 11c. Resource Profile restoration — all relevant fields including metadata
      const restRp = await page.evaluate(async ({ id, nrId }) => {
        const token = localStorage.getItem('token')
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
        const rp = await (await fetch(`/api/projects/${id}/resource-profile`, { headers })).json() as {
          resourceRows: Array<{
            resourceTypeId: string; count: number
            namedResources: Array<{
              id: string; allocationMode: string; allocationPercent: number; allocationPct: number
              allocationStartWeek: number | null; allocationEndWeek: number | null
              startWeek: number | null; endWeek: number | null
              actualAllocationStartWeek: number | null; actualAllocationEndWeek: number | null
              capacityProfile?: { resolutionSource: string; planningBasis: string; source: string }
            }>
          }>
        }
        const devRow = rp.resourceRows.find(r => r.namedResources.some(nr => nr.id === nrId))
        const devNr = devRow?.namedResources.find(nr => nr.id === nrId) ?? null
        return { devRow: devRow ? { resourceTypeId: devRow.resourceTypeId, count: devRow.count } : null, devNr }
      }, { id: projectId, nrId: nrResult.nrId })
      expect(restRp.devNr).toBeDefined()
      expect(restRp.devRow).toBeDefined()
      expect(restRp.devRow!.count).toBe(preCount)
      // All scalar compatibility fields restored
      expect(restRp.devNr!.allocationMode).toBe(preRpNr.allocationMode)
      expect(restRp.devNr!.allocationPercent).toBe(preRpNr.allocationPercent)
      expect(restRp.devNr!.allocationPct).toBe(preRpNr.allocationPct)
      expect(restRp.devNr!.allocationStartWeek).toBe(preRpNr.allocationStartWeek)
      expect(restRp.devNr!.allocationEndWeek).toBe(preRpNr.allocationEndWeek)
      expect(restRp.devNr!.startWeek).toBe(preRpNr.startWeek)
      expect(restRp.devNr!.endWeek).toBe(preRpNr.endWeek)
      expect(restRp.devNr!.actualAllocationStartWeek).toBe(preRpNr.actualAllocationStartWeek)
      expect(restRp.devNr!.actualAllocationEndWeek).toBe(preRpNr.actualAllocationEndWeek)
      // Full profile metadata restored to legacy fallback (matching pre-apply state)
      expect(restRp.devNr!.capacityProfile).toBeDefined()
      expect(restRp.devNr!.capacityProfile!.resolutionSource).toBe(preRpNr.capacityProfile!.resolutionSource)
      expect(restRp.devNr!.capacityProfile!.planningBasis).toBe(preRpNr.capacityProfile!.planningBasis)
      expect(restRp.devNr!.capacityProfile!.source).toBe(preRpNr.capacityProfile!.source)

      // 11d. Timeline restoration (MUST succeed, not conditional)
      const restTl = await page.evaluate(async ({ id, nrId }) => {
        const token = localStorage.getItem('token')
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
        const tl = await (await fetch(`/api/projects/${id}/timeline`, { headers })).json() as {
          namedResources: Array<{ id: string; startWeek: number | null; endWeek: number | null; allocationMode: string; allocationPercent: number }>
        }
        return tl.namedResources.find(nr => nr.id === nrId) ?? null
      }, { id: projectId, nrId: nrResult.nrId })
      expect(restTl).toBeDefined()
      expect(restTl!.startWeek).toBe(preTlNr.startWeek)
      expect(restTl!.endWeek).toBe(preTlNr.endWeek)
      expect(restTl!.allocationPercent).toBe(preTlNr.allocationPercent)
      expect(restTl!.allocationMode).toBe(preTlNr.allocationMode)

    } finally {
      await db.end()
    }
  })

  test('apply candidate persists through the direct-apply workflow', async ({ page }) => {
    const projectId = page.url().match(/\/projects\/([^/]+)/)?.[1]!
    if (!projectId) throw new Error('Could not determine project ID')

    // ── 1. Capture pre-apply state via Resource Profile reader ─────────────
    const preState = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('token')
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
      const res = await fetch(`/api/projects/${id}/resource-profile`, { headers })
      if (!res.ok) throw new Error(`Resource profile returned ${res.status}`)
      const body = await res.json() as {
        resourceRows: Array<{
          resourceTypeId: string
          name: string
          count: number
        }>
      }
      return body
    }, { id: projectId })
    expect(preState.resourceRows.length).toBeGreaterThan(0)
    const preCounts = preState.resourceRows.map(r => ({ id: r.resourceTypeId, count: r.count }))

    // ── 2. Run optimiser and apply candidate ───────────────────────────────
    const drawer = await openStartingTeamFinder(page)

    await drawer.getByRole('button', { name: /find starting teams/i }).click()
    await expect(drawer.getByText(/Evaluated [\d,]+ team options/)).toBeVisible({ timeout: 30_000 })
    const applyButton = drawer.getByRole('button', { name: /apply directly/i }).first()
    await expect(applyButton).toBeVisible()

    const applyResponse = page.waitForResponse(
      response => response.url().includes('/optimise/apply') && response.request().method() === 'POST',
      { timeout: 15_000 },
    )
    page.once('dialog', dialog => dialog.accept())
    await applyButton.click()

    const response = await applyResponse
    expect(response.status()).toBe(200)
    const body = await response.json() as { snapshotId: string }
    expect(body.snapshotId).toBeTruthy()
    await expect(drawer).not.toBeVisible({ timeout: 10_000 })

    // ── 3. Verify Resource Profile reflects the applied state ──────────────
    const postState = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('token')
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
      const res = await fetch(`/api/projects/${id}/resource-profile`, { headers })
      if (!res.ok) throw new Error(`Resource profile returned ${res.status}`)
      return await res.json() as {
        resourceRows: Array<{
          resourceTypeId: string
          name: string
          count: number
        }>
      }
    }, { id: projectId })

    // At least one count changed (the optimiser applied something)
    const countsChanged = postState.resourceRows.some(post => {
      const pre = preCounts.find(p => p.id === post.resourceTypeId)
      return pre && pre.count !== post.count
    })
    expect(countsChanged).toBe(true)

    // ── 4. Verify Timeline returns data ────────────────────────────────────
    const timelineState = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('token')
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
      const res = await fetch(`/api/projects/${id}/timeline`, { headers })
      if (!res.ok) throw new Error(`Timeline returned ${res.status}`)
      return await res.json() as {
        namedResources: Array<{
          id: string
          startWeek: number | null
          endWeek: number | null
        }>
      }
    }, { id: projectId })
    expect(timelineState.namedResources.length).toBeGreaterThan(0)

    // ── 5. Undo via snapshot rollback ──────────────────────────────────────
    const undoResult = await page.evaluate(async ({ id, snapshotId }) => {
      const token = localStorage.getItem('token')
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }
      const res = await fetch(`/api/projects/${id}/snapshots/${snapshotId}/rollback`, {
        method: 'POST',
        headers,
      })
      return { status: res.status, body: await res.json() }
    }, { id: projectId, snapshotId: body.snapshotId })
    expect(undoResult.status).toBe(200)

    // ── 6. Verify pre-apply state restored ─────────────────────────────────
    const restoredState = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('token')
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
      const res = await fetch(`/api/projects/${id}/resource-profile`, { headers })
      if (!res.ok) throw new Error(`Resource profile returned ${res.status}`)
      return await res.json() as {
        resourceRows: Array<{
          resourceTypeId: string
          count: number
        }>
      }
    }, { id: projectId })

    for (const pre of preCounts) {
      const restored = restoredState.resourceRows.find(r => r.resourceTypeId === pre.id)
      if (restored) expect(restored.count).toBe(pre.count)
    }
  })

  test('direct apply fails closed for an explicit named-person profile', async ({ page }) => {
    const projectId = page.url().match(/\/projects\/([^/]+)/)?.[1]!

    await page.goto(`/projects/${projectId}/resource-profile`)
    const developerRow = page.locator('tr').filter({ hasText: /developer/i }).first()
    await expect(developerRow).toBeVisible({ timeout: 15_000 })
    await developerRow.getByRole('button', { name: /people/i }).click()

    const addResponse = page.waitForResponse(
      response => response.request().method() === 'POST'
        && response.ok()
        && /\/named-resources$/.test(new URL(response.url()).pathname),
      { timeout: 15_000 },
    )
    await page.getByRole('button', { name: /add person/i }).click()
    const namedResource = await addResponse.then(response => response.json() as Promise<{
      id: string
      resourceTypeId: string
    }>)

    const resourceProfile = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('token')
      const response = await fetch(`/api/projects/${id}/resource-profile`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      return { status: response.status, body: await response.json() }
    }, { id: projectId })
    expect(resourceProfile.status).toBe(200)
    const resourceType = resourceProfile.body.resourceRows.find(
      (row: { resourceTypeId: string }) => row.resourceTypeId === namedResource.resourceTypeId,
    ) as { count: number }
    expect(resourceType).toBeDefined()

    const applyResult = await page.evaluate(async ({ id, resourceTypeId, count }) => {
      const token = localStorage.getItem('token')
      const response = await fetch(`/api/projects/${id}/optimise/apply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          resourceTypes: [{ resourceTypeId, count, suggestedStartWeek: 2 }],
          optimiserScopeResourceTypeIds: [resourceTypeId],
          staggerEpics: false,
        }),
      })
      return { status: response.status, body: await response.json() }
    }, {
      id: projectId,
      resourceTypeId: namedResource.resourceTypeId,
      count: resourceType.count,
    })
    expect(applyResult).toMatchObject({
      status: 409,
      body: {
        code: 'OPTIMISER_APPLY_CONFLICT',
        conflicts: [expect.objectContaining({
          code: 'EXPLICIT_SCALAR_PROTECTED',
          namedResourceName: expect.any(String),
        })],
      },
    })
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// Resource Profile allocation — mode, FTE %, and availability window inputs
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Resource Profile allocation', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000)

    const projectName = `E2E ResAlloc ${Date.now()}`
    await login(page)
    await createProject(page, projectName)

    // Navigate to Backlog and seed CSV with resource types
    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /backlog/i }).click()

    const tmpFile = path.join(os.tmpdir(), `res-alloc-${Date.now()}.csv`)
    fs.writeFileSync(tmpFile, CACHE_INV_CSV)
    await page.getByRole('button', { name: /import csv/i }).click()
    await page.locator('input[type="file"]').setInputFiles(tmpFile)
    fs.unlinkSync(tmpFile)
    await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
    await expect(page.getByText('Platform Build')).toBeVisible({ timeout: 10_000 })

    // Navigate to Resource Profile
    const projectId = page.url().match(/\/projects\/([^/]+)/)?.[1]!
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(
      page.getByRole('heading', { name: /resource profile/i })
    ).toBeVisible({ timeout: 10_000 })
  })

  test('planning basis dropdown changes to wholeProjectAllocation', async ({ page }) => {
    // Find the Developer row and click its capacity profile badge
    const devRow = page.locator('tr').filter({ hasText: /developer/i }).first()
    await expect(devRow).toBeVisible({ timeout: 15_000 })

    // The initial badge shows "Fixed for selected weeks · 100%" (database default for new resource types)
    const badge = devRow.locator('button[title="Click to edit capacity profile"]')
    await expect(badge).toBeVisible()

    // Click the badge to open the capacity profile modal
    await badge.click()
    await expect(page.getByRole('dialog', { name: /edit capacity profile/i })).toBeVisible({ timeout: 5_000 })

    // The planning basis selector should be visible
    const modeSelect = page.getByTestId('cp-planning-basis-select')
    await expect(modeSelect).toBeVisible({ timeout: 5_000 })
    // Change to Fixed for whole project
    await modeSelect.selectOption('wholeProjectAllocation')

    // Set FTE default percent to 50%
    const fteInput = page.getByTestId('cp-default-pct-input')
    await fteInput.fill('50')

    // Click Save
    await page.locator('[data-testid="cp-save-btn"]').click()

    // After save, the badge should show the updated text
    await expect(badge).toHaveText(/Fixed for whole project/, { timeout: 10_000 })
  })

  test('availabilityWindow mode shows start/end week inputs and persists', async ({ page }) => {
    const devRow = page.locator('tr').filter({ hasText: /developer/i }).first()
    await expect(devRow).toBeVisible({ timeout: 15_000 })
    const badge = devRow.locator('button[title="Click to edit capacity profile"]')
    await expect(badge).toBeVisible()
    await badge.click()
    await expect(page.getByRole('dialog', { name: /edit capacity profile/i })).toBeVisible({ timeout: 5_000 })

    // The planning basis selector should be visible with default availabilityWindow
    const modeSelect = page.getByTestId('cp-planning-basis-select')
    await expect(modeSelect).toBeVisible({ timeout: 5_000 })
    // Start/end week inputs should appear (default is availabilityWindow for new resource types)
    const startInput = page.getByTestId('cp-start-week-input')
    const endInput = page.getByTestId('cp-end-week-input')
    await expect(startInput).toBeVisible({ timeout: 5_000 })
    await expect(endInput).toBeVisible({ timeout: 5_000 })

    // Set values
    await startInput.fill('2')
    await endInput.fill('10')

    // Click Save
    await page.locator('[data-testid="cp-save-btn"]').click()

    // Badge should show the updated text
    await expect(badge).toHaveText(/Fixed for selected weeks/, { timeout: 10_000 })
  })

  test('default percent input persists independently', async ({ page }) => {
    const devRow = page.locator('tr').filter({ hasText: /developer/i }).first()
    await expect(devRow).toBeVisible({ timeout: 15_000 })
    const badge = devRow.locator('button[title="Click to edit capacity profile"]')
    await expect(badge).toBeVisible()
    await badge.click()
    await expect(page.getByRole('dialog', { name: /edit capacity profile/i })).toBeVisible({ timeout: 5_000 })
    const modeSelect = page.getByTestId('cp-planning-basis-select')
    await expect(modeSelect).toBeVisible({ timeout: 5_000 })

    // Change mode to Fixed for whole project (has % field)
    await modeSelect.selectOption('wholeProjectAllocation')

    // Set FTE to 75%
    const fteInput = page.getByTestId('cp-default-pct-input')
    await fteInput.fill('75')

    // Save
    await page.locator('[data-testid="cp-save-btn"]').click()
    await expect(badge).toHaveText(/75%/, { timeout: 10_000 })

    // Re-open the modal — the % should persist
    await badge.click()
    await expect(page.getByRole('dialog', { name: /edit capacity profile/i })).toBeVisible({ timeout: 5_000 })
    await expect(fteInput).toHaveValue('75')
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// Timeline Resource-counts layout — issue #369
// Add named resource (server-default availability pattern is TIMELINE), exercise
// explicit basis transitions EFFORT→TIMELINE, set allocation 80%, start 2,
// end 10, verify persistence after reload, remove. Tests run at desktop,
// narrow, and mobile viewport sizes with geometry-fit assertions.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Timeline — Resource-counts layout', () => {
  let projectId = ''

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000)

    const projectName = `E2E RCLayout ${Date.now()}`
    await login(page)
    await createProject(page, projectName)

    await page.getByRole('heading', { name: projectName, exact: true }).click()
    await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /backlog/i }).click()

    const tmpFile = path.join(os.tmpdir(), `rc-layout-${Date.now()}.csv`)
    fs.writeFileSync(tmpFile, CACHE_INV_CSV)
    await page.getByRole('button', { name: /import csv/i }).click()
    await page.locator('input[type="file"]').setInputFiles(tmpFile)
    fs.unlinkSync(tmpFile)
    await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
    await expect(page.getByText('Platform Build')).toBeVisible({ timeout: 10_000 })

    projectId = page.url().match(/\/projects\/([^/]+)/)?.[1]!
    await page.goto(`/projects/${projectId}/timeline`)
    await expect(page.getByText(/Timeline Planner/i)).toBeVisible({ timeout: 10_000 })

    await quickSchedule(page)
    // Change 1: scheduling completion assertion before devCard readiness
    await expect(page.getByText(/\d+ features scheduled/i)).toBeVisible({ timeout: 15_000 })
    await expect(devCard(page)).toHaveCount(1)
    await expect(devCard(page).getByRole('button', { name: /add named resource to developer/i })).toBeVisible({ timeout: 15_000 })
  })

  function devCard(page: Page) {
    return page.getByTestId('resource-counts').locator('[data-testid^="resource-type-card-"]')
      .filter({ has: page.getByRole('button', { name: /add named resource to developer/i }) })
  }

  // Change 2: request-event eligibility set replacing boolean-only gate
  function createEligibleMatcher(page: Page, method: string, pathSuffix: string, timeout = 15_000) {
    const eligible = new Set<string>()
    let started = false
    const handler = (req: Request) => {
      if (!started || req.method() !== method) return
      try {
        if (new URL(req.url()).pathname.endsWith(pathSuffix)) {
          eligible.add(req.url())
        }
      } catch { /* ignore invalid URLs */ }
    }
    page.on('request', handler)
    const promise = page.waitForResponse(
      resp => resp.ok() && eligible.has(resp.request().url()),
      { timeout },
    )
    return {
      promise,
      gate: () => { started = true },
      cleanup: () => page.off('request', handler),
    }
  }

  // Change 5: locator-based expectElementToFit replaces evaluate+querySelector approach
  async function expectElementToFit(locator: Locator) {
    const ok = await locator.evaluate((el: Element) => (el as HTMLElement).scrollWidth <= (el as HTMLElement).clientWidth + 1)
    expect(ok).toBe(true)
  }

  // Change 3: focused helper — adds named resource with POST+Timeline GET waiters before click
  async function addNamedResourceAndWait(page: Page, locator: Locator): Promise<{ id: string; resourceTypeId: string; name: string }> {
    // Derive resource type ID from the card's data-testid (resource-type-card-<UUID>)
    const cardTestId = await locator.getAttribute('data-testid')
    const resourceTypeId = cardTestId!.replace('resource-type-card-', '')
    // Timeline matcher first, eager promise
    const tlMatcher = createEligibleMatcher(page, 'GET', `/api/projects/${projectId}/timeline`, 15_000)
    // POST waiter: exact predicate gates tlMatcher when POST response matches
    const addResp = page.waitForResponse(
      resp => {
        if (resp.request().method() !== 'POST' || !resp.ok()) return false
        try {
          const u = new URL(resp.request().url())
          if (u.pathname.endsWith(`/projects/${projectId}/resource-types/${resourceTypeId}/named-resources`)) {
            tlMatcher.gate()
            return true
          }
        } catch { return false }
        return false
      },
      { timeout: 15_000 },
    )
    // Both waiters exist before click
    await locator.getByRole('button', { name: /add named resource to developer/i }).click()
    // Await POST and Timeline promises together
    const [addResponse] = await Promise.all([addResp, tlMatcher.promise])
    tlMatcher.cleanup()
    return await addResponse.json() as { id: string; resourceTypeId: string; name: string }
  }

  // Change 4: unified deletion helper — DELETE waiter + Timeline GET + dialog validation, accepts before/while click
  async function removeNamedResource(page: Page, devCardLocator: Locator, nrId: string, nrName: string) {
    // Timeline matcher first, eager promise
    const tlMatcher = createEligibleMatcher(page, 'GET', `/api/projects/${projectId}/timeline`, 10_000)
    // DELETE waiter: exact predicate gates tlMatcher on matching DELETE response
    const delResp = page.waitForResponse(
      resp => {
        if (resp.request().method() !== 'DELETE' || !resp.ok()) return false
        try {
          const u = new URL(resp.request().url())
          if (u.pathname.endsWith(`/named-resources/${nrId}`)) {
            tlMatcher.gate()
            return true
          }
        } catch { return false }
        return false
      },
      { timeout: 10_000 },
    )
    // Dialog promise accepting asynchronously before/while click
    const dialogPromise = page.waitForEvent('dialog', { timeout: 10_000 }).then(async d => {
      expect(d.message()).toMatch(/remove this person/i)
      await d.accept()
    })
    // Await click/dialog/DELETE/Timeline in one Promise.all
    await Promise.all([
      devCardLocator.getByRole('button', { name: new RegExp(`remove ${nrName}`, 'i') }).click(),
      dialogPromise,
      delResp,
      tlMatcher.promise,
    ])
    tlMatcher.cleanup()
    // Assert exact row test ID count zero rather than broad prefix
    await expect(devCardLocator.getByTestId(`named-resource-row-${nrId}`)).toHaveCount(0)
  }

  /**
   * Transition a named resource's availability pattern with exact PATCH + Timeline GET
   * synchronization. Server returns TIMELINE as the default for new named
   * resources; use this helper to switch to EFFORT and back.
   * @param basisLocator - the specific combobox Locator for this named resource's pattern
   */
  async function setNamedResourceBasisAndWait(page: Page, nrId: string, basisLocator: Locator, basis: 'EFFORT' | 'TIMELINE') {
    const tlMatcher = createEligibleMatcher(page, 'GET', `/api/projects/${projectId}/timeline`, 10_000)
    const patchResp = page.waitForResponse(
      resp => {
        if (resp.request().method() !== 'PATCH' || !resp.ok()) return false
        try {
          const u = new URL(resp.request().url())
          if (u.pathname.endsWith(`/named-resources/${nrId}`)) {
            tlMatcher.gate()
            return true
          }
        } catch { return false }
        return false
      },
      { timeout: 10_000 },
    )
    await basisLocator.selectOption(basis)
    const [patchRespResolved] = await Promise.all([patchResp, tlMatcher.promise])
    expect(patchRespResolved.status()).toBe(200)
    tlMatcher.cleanup()
  }

  test('desktop: add named resource, change basis, edit values, verify persistence after reload, remove', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1440, height: 900 })

    const counts = page.getByTestId('resource-counts')
    await expect(counts).toBeVisible()

    const addBody = await addNamedResourceAndWait(page, devCard(page))
    const nrId = addBody.id
    const nrName = addBody.name
    expect(nrName).toBeTruthy()

    // Assert initial basis is TIMELINE (server default for new named resources)
    const basisSelect = devCard(page).getByRole('combobox', { name: new RegExp(`availability pattern for ${nrName}`, 'i') })
    await expect(basisSelect).toBeVisible({ timeout: 10_000 })
    await expect(basisSelect).toHaveValue('TIMELINE')

    // Transition to EFFORT
    await setNamedResourceBasisAndWait(page, nrId, basisSelect, 'EFFORT')
    const effortBasis = devCard(page).getByRole('combobox', { name: new RegExp(`availability pattern for ${nrName}`, 'i') })
    await expect(effortBasis).toHaveValue('EFFORT')

    // Transition back to TIMELINE for allocation/start/end editing
    await setNamedResourceBasisAndWait(page, nrId, effortBasis, 'TIMELINE')
    await expect(devCard(page).getByRole('combobox', { name: new RegExp(`availability pattern for ${nrName}`, 'i') })).toHaveValue('TIMELINE')
    // PATCH allocation to 80%
    const pctInput = devCard(page).getByRole('spinbutton', { name: new RegExp(`available percentage for ${nrName}`, 'i') })
    await expect(pctInput).toBeVisible()
    const tlPct = createEligibleMatcher(page, 'GET', `/api/projects/${projectId}/timeline`, 10_000)
    const patchPct = page.waitForResponse(
      resp => {
        if (resp.request().method() !== 'PATCH' || !resp.ok()) return false
        try {
          const u = new URL(resp.request().url())
          if (u.pathname.endsWith(`/named-resources/${nrId}`)) {
            tlPct.gate()
            return true
          }
        } catch { return false }
        return false
      },
      { timeout: 10_000 },
    )
    await pctInput.fill('80')
    await pctInput.blur()
    const [patchPctResp] = await Promise.all([patchPct, tlPct.promise])
    expect(patchPctResp.status()).toBe(200)
    tlPct.cleanup()
    const pctAfter = devCard(page).getByRole('spinbutton', { name: new RegExp(`available percentage for ${nrName}`, 'i') })
    await expect(pctAfter).toHaveValue('80')

    // PATCH start week to 2
    const startInput = devCard(page).getByRole('spinbutton', { name: new RegExp(`available from week for ${nrName}`, 'i') })
    await expect(startInput).toBeEnabled()
    const tlStart = createEligibleMatcher(page, 'GET', `/api/projects/${projectId}/timeline`, 10_000)
    const patchStart = page.waitForResponse(
      resp => {
        if (resp.request().method() !== 'PATCH' || !resp.ok()) return false
        try {
          const u = new URL(resp.request().url())
          if (u.pathname.endsWith(`/named-resources/${nrId}`)) {
            tlStart.gate()
            return true
          }
        } catch { return false }
        return false
      },
      { timeout: 10_000 },
    )
    await startInput.fill('2')
    await startInput.blur()
    const [patchStartResp] = await Promise.all([patchStart, tlStart.promise])
    expect(patchStartResp.status()).toBe(200)
    tlStart.cleanup()
    const startAfter = devCard(page).getByRole('spinbutton', { name: new RegExp(`available from week for ${nrName}`, 'i') })
    await expect(startAfter).toHaveValue('2')

    // PATCH end week to 10
    const endInput = devCard(page).getByRole('spinbutton', { name: new RegExp(`available to week for ${nrName}`, 'i') })
    await expect(endInput).toBeEnabled()
    const tlEnd = createEligibleMatcher(page, 'GET', `/api/projects/${projectId}/timeline`, 10_000)
    const patchEnd = page.waitForResponse(
      resp => {
        if (resp.request().method() !== 'PATCH' || !resp.ok()) return false
        try {
          const u = new URL(resp.request().url())
          if (u.pathname.endsWith(`/named-resources/${nrId}`)) {
            tlEnd.gate()
            return true
          }
        } catch { return false }
        return false
      },
      { timeout: 10_000 },
    )
    await endInput.fill('10')
    await endInput.blur()
    const [patchEndResp] = await Promise.all([patchEnd, tlEnd.promise])
    expect(patchEndResp.status()).toBe(200)
    tlEnd.cleanup()
    const endAfter = devCard(page).getByRole('spinbutton', { name: new RegExp(`available to week for ${nrName}`, 'i') })
    await expect(endAfter).toHaveValue('10')

    await page.reload()
    await expect(counts).toBeVisible({ timeout: 15_000 })
    expect(page.url()).toContain(`/projects/${projectId}/timeline`)

    // Re-acquire locators after reload
    const reloadBasis = devCard(page).getByRole('combobox', { name: new RegExp(`availability pattern for ${nrName}`, 'i') })
    await expect(reloadBasis).toBeVisible({ timeout: 10_000 })
    await expect(reloadBasis).toHaveValue('TIMELINE')
    await expect(devCard(page).getByRole('spinbutton', { name: new RegExp(`available percentage for ${nrName}`, 'i') })).toHaveValue('80')
    await expect(devCard(page).getByRole('spinbutton', { name: new RegExp(`available from week for ${nrName}`, 'i') })).toHaveValue('2')
    await expect(devCard(page).getByRole('spinbutton', { name: new RegExp(`available to week for ${nrName}`, 'i') })).toHaveValue('10')
    await expect(devCard(page).getByRole('button', { name: new RegExp(`remove ${nrName}`, 'i') })).toBeVisible()
    await expect(devCard(page).getByRole('button', { name: /add named resource to developer/i })).toBeVisible()

    // Check row fit while populated
    const docSW = await page.evaluate(() => document.documentElement.scrollWidth)
    const docCW = await page.evaluate(() => window.innerWidth)
    expect(docSW <= docCW + 1).toBe(true)
    await expectElementToFit(page.getByTestId('resource-counts'))
    await expectElementToFit(page.getByTestId(`named-resource-row-${nrId}`))

    await removeNamedResource(page, devCard(page), nrId, nrName)

    // Post-delete fit: document and panel only
    const postDelSW = await page.evaluate(() => document.documentElement.scrollWidth)
    const postDelCW = await page.evaluate(() => window.innerWidth)
    expect(postDelSW <= postDelCW + 1).toBe(true)
    await expectElementToFit(page.getByTestId('resource-counts'))
  })

  test('narrow viewport: column headers and named-resource controls visible, no overflow', async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 820, height: 900 })

    const counts = page.getByTestId('resource-counts')
    await expect(counts).toBeVisible()

    const devCardEl = devCard(page)
    const addBody = await addNamedResourceAndWait(page, devCardEl)
    const nrId = addBody.id
    const nrName = addBody.name
    expect(nrName).toBeTruthy()

    // Assert initial basis is TIMELINE (server default for new named resources)
    const basisSelect = devCard(page).getByRole('combobox', { name: new RegExp(`availability pattern for ${nrName}`, 'i') })
    await expect(basisSelect).toBeVisible({ timeout: 10_000 })
    await expect(basisSelect).toHaveValue('TIMELINE')

    const headers = devCard(page).getByTestId('named-resource-headers')
    await expect(headers.getByText('Named resource', { exact: true })).toBeVisible()
    await expect(headers.getByText('Availability pattern', { exact: true })).toBeVisible()
    await expect(headers.getByText('Available %', { exact: true })).toBeVisible()
    await expect(headers.getByText('Available from', { exact: true })).toBeVisible()
    await expect(headers.getByText('Available to', { exact: true })).toBeVisible()

    // Transition to EFFORT
    await setNamedResourceBasisAndWait(page, nrId, basisSelect, 'EFFORT')
    const effortBasis = devCard(page).getByRole('combobox', { name: new RegExp(`availability pattern for ${nrName}`, 'i') })
    await expect(effortBasis).toHaveValue('EFFORT')

    // Transition back to TIMELINE for full controls
    await setNamedResourceBasisAndWait(page, nrId, effortBasis, 'TIMELINE')
    await expect(devCard(page).getByRole('combobox', { name: new RegExp(`availability pattern for ${nrName}`, 'i') })).toHaveValue('TIMELINE')

    await expect(devCard(page).getByRole('spinbutton', { name: new RegExp(`available percentage for ${nrName}`, 'i') })).toBeEnabled()
    await expect(devCard(page).getByRole('spinbutton', { name: new RegExp(`available from week for ${nrName}`, 'i') })).toBeEnabled()
    await expect(devCard(page).getByRole('spinbutton', { name: new RegExp(`available to week for ${nrName}`, 'i') })).toBeEnabled()
    await expectElementToFit(page.getByTestId('resource-counts'))
    await expectElementToFit(page.getByTestId(`named-resource-row-${nrId}`))

    await removeNamedResource(page, devCard(page), nrId, nrName)

    // Post-delete fit: document and panel only
    const postDelSW = await page.evaluate(() => document.documentElement.scrollWidth)
    const postDelCW = await page.evaluate(() => window.innerWidth)
    expect(postDelSW <= postDelCW + 1).toBe(true)
    await expectElementToFit(page.getByTestId('resource-counts'))
  })

  test('mobile viewport: desktop column headers hidden, inline labels visible, controls reachable, resource-counts panel and rows fit', async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 390, height: 844 })

    const counts = page.getByTestId('resource-counts')
    await expect(counts).toBeVisible()

    const addBody = await addNamedResourceAndWait(page, devCard(page))
    const nrId = addBody.id
    const nrName = addBody.name
    expect(nrName).toBeTruthy()

    const row = counts.getByTestId(`named-resource-row-${nrId}`)
    await expect(row.getByText('Pattern:')).toBeVisible()
    await expect(row.getByText('Avail:')).toBeVisible()
    await expect(row.getByText('Avail from:')).toBeVisible()
    await expect(row.getByText('Avail to:')).toBeVisible()
    const headers = devCard(page).getByTestId('named-resource-headers')
    await expect(headers.getByText('Named resource', { exact: true })).not.toBeVisible()
    await expect(headers.getByText('Availability pattern', { exact: true })).not.toBeVisible()
    await expect(headers.getByText('Available %', { exact: true })).not.toBeVisible()

    // Assert initial basis is TIMELINE (server default for new named resources)
    const basisSelect = devCard(page).getByRole('combobox', { name: new RegExp(`availability pattern for ${nrName}`, 'i') })
    await expect(basisSelect).toBeVisible({ timeout: 10_000 })
    await expect(basisSelect).toHaveValue('TIMELINE')

    // Transition to EFFORT
    await setNamedResourceBasisAndWait(page, nrId, basisSelect, 'EFFORT')
    const effortBasis = devCard(page).getByRole('combobox', { name: new RegExp(`availability pattern for ${nrName}`, 'i') })
    await expect(effortBasis).toHaveValue('EFFORT')

    // Transition back to TIMELINE for full controls
    await setNamedResourceBasisAndWait(page, nrId, effortBasis, 'TIMELINE')
    await expect(devCard(page).getByRole('combobox', { name: new RegExp(`availability pattern for ${nrName}`, 'i') })).toHaveValue('TIMELINE')

    await expect(devCard(page).getByRole('spinbutton', { name: new RegExp(`available percentage for ${nrName}`, 'i') })).toBeEnabled()
    await expect(devCard(page).getByRole('spinbutton', { name: new RegExp(`available from week for ${nrName}`, 'i') })).toBeEnabled()
    await expect(devCard(page).getByRole('spinbutton', { name: new RegExp(`available to week for ${nrName}`, 'i') })).toBeEnabled()

    // Check resource-counts panel/row fit while populated
    await expectElementToFit(page.getByTestId('resource-counts'))
    await expectElementToFit(page.getByTestId(`named-resource-row-${nrId}`))

    // Change 6: strengthened mobile stacking with explicit null checks and proper vertical comparisons
    const basisGroup = row.getByText('Pattern:').locator('..')
    const allocGroup = row.getByText('Avail:').locator('..')
    const startGroup = row.getByText('Avail from:').locator('..')
    const endGroup = row.getByText('Avail to:').locator('..')
    const basisBox = await basisGroup.boundingBox()
    const allocBox = await allocGroup.boundingBox()
    const startBox = await startGroup.boundingBox()
    const endBox = await endGroup.boundingBox()
    expect(basisBox).not.toBeNull()
    expect(allocBox).not.toBeNull()
    expect(startBox).not.toBeNull()
    expect(endBox).not.toBeNull()
    // Alloc y starts at or after basis bottom; start at or after alloc bottom; end at or after start bottom
    expect(allocBox!.y).toBeGreaterThanOrEqual(basisBox!.y + basisBox!.height - 2)
    expect(startBox!.y).toBeGreaterThanOrEqual(allocBox!.y + allocBox!.height - 2)
    expect(endBox!.y).toBeGreaterThanOrEqual(startBox!.y + startBox!.height - 2)

    await removeNamedResource(page, devCard(page), nrId, nrName)

    // Post-delete: panel fit
    await expectElementToFit(page.getByTestId('resource-counts'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Squad Planner — profile-first apply with capacity plan
// Covers: generate, apply and verify planned resource identities on Resource
// Profile, reapply with changed settings, Snapshot History presence/rollback.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Squad Planner — profile-first apply and resource identity', () => {
  test('generate, apply, verify planned resources, reapply, and snapshot history', async ({ page }) => {
    test.setTimeout(150_000)

    const projectName = `E2E SquadPlan ${Date.now()}`

    // ── Login and create project ──
    await login(page)
    await createProject(page, projectName)

    // ── Navigate to Backlog and seed CSV with Developer + Tech Lead tasks ──
    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /backlog/i }).click()

    await expect(page.getByRole('button', { name: /import csv/i })).toBeVisible({ timeout: 8_000 })
    const tmpFile = path.join(os.tmpdir(), `squad-plan-${Date.now()}.csv`)
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
      page.getByRole('heading', { name: /timeline planner/i }),
    ).toBeVisible({ timeout: 8_000 })

    // ── Set start date and Update timeline ──
    const dateInput = page.locator('input[type="date"]')
    await expect(dateInput).toBeVisible({ timeout: 8_000 })
    await dateInput.fill('2026-06-01')
    await expect(dateInput).toHaveValue('2026-06-01')
    await quickSchedule(page)
    await expect(
      page.getByRole('button', { name: /sequential|parallel/i }).first(),
    ).toBeVisible({ timeout: 15_000 })

    // ── Open Squad Planner drawer ──
    await page.getByRole('button', { name: /open squad planner/i }).click()

    const drawer = page.getByRole('dialog', { name: /squad planner/i })
    await expect(drawer).toBeVisible({ timeout: 5_000 })
    await expect(drawer.getByRole('heading', { name: /squad planner/i })).toBeVisible()

    // ── Generate capacity profile ──
    const generateBtn = drawer.getByRole('button', { name: /generate capacity profile/i })
    await expect(generateBtn).toBeVisible()

    const planResponse = page.waitForResponse(
      resp => resp.url().includes('/squad-plan') && !resp.url().includes('/apply') && resp.request().method() === 'POST',
      { timeout: 30_000 },
    )
    await generateBtn.click()
    await planResponse

    // Wait for result KPIs — Peak, Delivery, Planned squad cost, Avg Utilisation
    await expect(drawer.getByText(/Peak/i)).toBeVisible({ timeout: 10_000 })
    await expect(drawer.getByText(/Delivery/i)).toBeVisible()
    await expect(drawer.getByText(/Planned squad cost/i)).toBeVisible()

    // ── Apply capacity profile ──
    const applyBtn = drawer.getByRole('button', { name: /apply capacity profile/i })
    await expect(applyBtn).toBeVisible()

    // Accept both confirm and the post-apply alert
    page.on('dialog', dialog => dialog.accept())

    const applyResponse = page.waitForResponse(
      resp => resp.url().includes('/squad-plan/apply') && resp.request().method() === 'POST',
      { timeout: 20_000 },
    )
    await applyBtn.click()
    const response = await applyResponse
    expect(response.status()).toBe(201)
    const applyBody = await response.json()
    // Response body is the Prisma CapacityPlan object
    type SquadPlanApplyResponse = {
      id: string
      isActive: boolean
      name: string
    }
    const applyData = applyBody as SquadPlanApplyResponse
    expect(applyData.id).toBeTruthy()
    expect(typeof applyData.id).toBe('string')
    expect(applyData.isActive).toBe(true)
    expect(applyData.name).toBeTruthy()

    // Drawer closes after successful apply
    await expect(drawer).not.toBeVisible({ timeout: 10_000 })

    // ── Navigate to Resource Profile and assert planned-resource identities ──
    // Capture the GET resource-profile response for persisted-data verification
    interface SegmentData {
      startWeek: number
      endWeek: number
      capacityPercent: number
    }
    interface CapacityProfileData {
      planningBasis: string
      source: string
      segments: SegmentData[]
    }
    interface NamedResourceData {
      id: string
      name: string
      resourceIdentity: string
      capacityProfile?: CapacityProfileData
    }
    interface ResourceRowData {
      name: string
      namedResources?: NamedResourceData[]
    }
    interface ResourceProfileResponse {
      resourceRows: ResourceRowData[]
    }

    // Start waiting for API before navigation
    const rpAfterApplyP = page.waitForResponse(
      resp => resp.url().includes(`/api/projects/${projectId}/resource-profile`) && resp.request().method() === 'GET' && resp.ok(),
      { timeout: 20_000 },
    )
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(
      page.getByRole('heading', { name: /resource profile/i }),
    ).toBeVisible({ timeout: 10_000 })

    const rpAfterApplyResp = await rpAfterApplyP
    const rpAfterApplyData = await rpAfterApplyResp.json() as unknown as ResourceProfileResponse

    // Find the Developer row and extract the first planned resource
    const devRowAPI1 = rpAfterApplyData.resourceRows.find(
      (r: ResourceRowData) => r.name?.toLowerCase().includes('developer'),
    )
    expect(devRowAPI1).toBeDefined()
    const plannedResource1 = devRowAPI1!.namedResources?.find(
      (nr: NamedResourceData) => nr.resourceIdentity === 'PLANNED_RESOURCE',
    )
    expect(plannedResource1).toBeDefined()
    const beforeReapply = {
      id: plannedResource1!.id,
      name: plannedResource1!.name,
      resourceIdentity: plannedResource1!.resourceIdentity,
      segments: plannedResource1!.capacityProfile?.segments ?? [],
    }
    expect(beforeReapply.segments.length).toBeGreaterThan(0)

    // ── UI assertions on Resource Profile page ──
    // Find the Developer row in the DOM and expand named resources
    const devRow = page.locator('tr').filter({ hasText: /developer/i }).first()
    await expect(devRow).toBeVisible({ timeout: 15_000 })

    // Click "People ↗" to reveal the NamedResourcesPanel
    await devRow.getByTitle('Show named resources').click()

    // The panel heading confirms it opened
    await expect(page.getByText('Named Resources')).toBeVisible({ timeout: 8_000 })

    // Check for "Planned resource" badge — each planned resource gets this
    await expect(page.getByText('Planned resource').first()).toBeVisible({ timeout: 5_000 })

    // Check for "Squad Planner" source badge — the capacity profile source tag
    await expect(page.getByText('Squad Planner').first()).toBeVisible({ timeout: 5_000 })

    // Name input must be disabled for planned resources (cannot be renamed)
    const namedResourcesRow = page.locator('tr').filter({
      has: page.getByText('Named Resources', { exact: true }),
    })
    const nameInput = namedResourcesRow.locator('input[type="text"]').first()
    await expect(nameInput).toBeDisabled()

    // ── Reapply — open Squad Planner with changed settings ──
    await page.goto(`/projects/${projectId}/timeline`)
    await expect(
      page.getByRole('heading', { name: /timeline planner/i }),
    ).toBeVisible({ timeout: 8_000 })

    // Open Squad Planner again
    await page.getByRole('button', { name: /open squad planner/i }).click()
    await expect(drawer).toBeVisible({ timeout: 5_000 })
    // Change Target Duration to exercise a second profile-first apply
    const twelveMonthBtn = drawer.getByRole('button', { name: '12mo' })
    await expect(twelveMonthBtn).toBeVisible()
    await twelveMonthBtn.click()

    // Generate the second capacity profile
    const planResponse2 = page.waitForResponse(
      resp => resp.url().includes('/squad-plan') && !resp.url().includes('/apply') && resp.request().method() === 'POST',
      { timeout: 30_000 },
    )
    await drawer.getByRole('button', { name: /generate capacity profile/i }).click()
    await planResponse2
    await expect(drawer.getByText(/Delivery/i)).toBeVisible({ timeout: 10_000 })

    // Apply the second profile
    const applyResponse2 = page.waitForResponse(
      resp => resp.url().includes('/squad-plan/apply') && resp.request().method() === 'POST',
      { timeout: 20_000 },
    )
    await drawer.getByRole('button', { name: /apply capacity profile/i }).click()
    const response2 = await applyResponse2
    expect(response2.status()).toBe(201)
    const applyBody2 = await response2.json() as SquadPlanApplyResponse
    expect(applyBody2.id).toBeTruthy()
    expect(applyBody2.id).not.toBe(applyData.id)
    await expect(drawer).not.toBeVisible({ timeout: 10_000 })

    // ── Verify stable identity + updated capacity on Resource Profile ──
    // Capture the API response to verify identity continuity and trajectory change
    const rpAfterReapplyP = page.waitForResponse(
      resp => resp.url().includes(`/api/projects/${projectId}/resource-profile`) && resp.request().method() === 'GET' && resp.ok(),
      { timeout: 20_000 },
    )
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(
      page.getByRole('heading', { name: /resource profile/i }),
    ).toBeVisible({ timeout: 10_000 })

    const rpAfterReapplyResp = await rpAfterReapplyP
    const rpAfterReapplyData = await rpAfterReapplyResp.json() as unknown as ResourceProfileResponse

    // Find Developer row and the same planned resource by ID
    const devRowAPI2 = rpAfterReapplyData.resourceRows.find(
      (r: ResourceRowData) => r.name?.toLowerCase().includes('developer'),
    )
    expect(devRowAPI2).toBeDefined()

    // The same persisted ID must appear exactly once (no duplicates)
    const matchingResources2 = devRowAPI2!.namedResources?.filter(
      (nr: NamedResourceData) => nr.id === beforeReapply.id,
    ) ?? []
    expect(matchingResources2).toHaveLength(1)

    // Same display identity
    expect(matchingResources2[0].name).toBe(beforeReapply.name)
    expect(matchingResources2[0].resourceIdentity).toBe(beforeReapply.resourceIdentity)

    // Reapply preserves a non-empty persisted trajectory alongside the stable identity
    const afterReapplySegments = matchingResources2[0].capacityProfile?.segments ?? []
    expect(afterReapplySegments.length).toBeGreaterThan(0)

    // ── UI assertions ──
    const devRow2 = page.locator('tr').filter({ hasText: /developer/i }).first()
    await expect(devRow2).toBeVisible({ timeout: 15_000 })
    await devRow2.getByTitle('Show named resources').click()

    // Identity remains stable — still "Planned resource"
    await expect(page.getByText('Planned resource').first()).toBeVisible({ timeout: 8_000 })
    // Source badge still "Squad Planner"
    await expect(page.getByText('Squad Planner').first()).toBeVisible({ timeout: 5_000 })
    // Name input remains disabled for planned resources
    const namedResourcesRow2 = page.locator('tr').filter({
      has: page.getByText('Named Resources', { exact: true }),
    })
    await expect(namedResourcesRow2.locator('input[type="text"]').first()).toBeDisabled()

    // ── Exercise Snapshot History and rollback ──
    await page.goto(`/projects/${projectId}/timeline`)
    await expect(
      page.getByRole('heading', { name: /timeline planner/i }),
    ).toBeVisible({ timeout: 8_000 })

    // Open History panel
    await page.getByRole('button', { name: /history/i }).click()

    // SnapshotHistoryPanel heading
    await expect(page.getByText('Snapshot History')).toBeVisible({ timeout: 8_000 })

    // Squad Plan apply creates a snapshot with trigger 'optimiser_apply'
    await expect(page.getByText('optimiser_apply').first()).toBeVisible({ timeout: 8_000 })

    // ── Rollback: wait for POST response, then verify state via Resource Profile ──
    // Start waiting for the rollback POST before clicking
    const rollbackResponseP = page.waitForResponse(
      resp => resp.url().includes('/snapshots/') && resp.url().includes('/rollback') && resp.request().method() === 'POST',
      { timeout: 20_000 },
    )
    await page.getByRole('button', { name: /rollback/i }).first().click()
    await rollbackResponseP

    // After rollback the panel refreshes — wait for re-render
    await expect(page.getByText('Snapshot History')).toBeVisible({ timeout: 8_000 })

    // ── Navigate to Resource Profile to verify state restoration ──
    // Start waiting for API before navigation
    const rpAfterRollbackP = page.waitForResponse(
      resp => resp.url().includes(`/api/projects/${projectId}/resource-profile`) && resp.request().method() === 'GET' && resp.ok(),
      { timeout: 20_000 },
    )
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(
      page.getByRole('heading', { name: /resource profile/i }),
    ).toBeVisible({ timeout: 10_000 })

    const rpAfterRollbackResp = await rpAfterRollbackP
    const rpAfterRollbackData = await rpAfterRollbackResp.json() as unknown as ResourceProfileResponse


    // Rollback (.first() targets pre-second-apply snapshot) restores the
    // state after the first plan, so the original planned resource persists.
    const devRowAfterRollback = rpAfterRollbackData.resourceRows.find(
      (r: ResourceRowData) => r.name?.toLowerCase().includes('developer'),
    )
    expect(devRowAfterRollback).toBeDefined()

    // The first-plan resource must exist exactly once (no duplicates)
    const plannedAfterRollback = devRowAfterRollback!.namedResources?.filter(
      (nr: NamedResourceData) => nr.id === beforeReapply.id,
    ) ?? []
    expect(plannedAfterRollback).toHaveLength(1)
    // Same display identity
    expect(plannedAfterRollback[0].name).toBe(beforeReapply.name)
    expect(plannedAfterRollback[0].resourceIdentity).toBe(beforeReapply.resourceIdentity)

    // Segments restored to pre-second-apply state (same as first plan)
    const restoredSegments = plannedAfterRollback[0].capacityProfile?.segments ?? []
    expect(restoredSegments.length).toBeGreaterThan(0)
    const segmentsRestored = JSON.stringify(restoredSegments) === JSON.stringify(beforeReapply.segments)
    expect(segmentsRestored).toBe(true)
  })
})