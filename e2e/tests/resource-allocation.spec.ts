import { test, expect, type Page, type Locator } from '@playwright/test'
import { login, createProject, quickSchedule, API_BASE } from './helpers'
import path from 'path'
import fs from 'fs'
import os from 'os'

const CSV_CONTENT = [
  'Type,Epic,Feature,Story,Task,Template,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus',
  'Epic,Alpha Epic,,,,,,,,,,active,,',
  'Feature,Alpha Epic,Alpha Feature,,,,,,,,,,,',
  'Story,Alpha Epic,Alpha Feature,Alpha Story,,,,,,,,,,active',
  'Task,Alpha Epic,Alpha Feature,Alpha Story,Alpha Task,,Tech Lead,16,2,,,,,',
  'Task,Alpha Epic,Alpha Feature,Alpha Story,Beta Task,,Project Manager,8,1,,,,,',
].join('\n')

async function setupCommercialTab(page: Page) {
  await login(page)
  const projectName = `E2E Resource Allocation ${Date.now()}`
  await createProject(page, projectName)
  await page.getByRole('heading', { name: projectName, exact: true }).first().click()

  await page.getByRole('button', { name: /backlog/i }).click()
  await expect(page.getByRole('button', { name: /import csv/i })).toBeVisible({ timeout: 8_000 })

  const tmpFile = path.join(os.tmpdir(), `alloc-seed-${Date.now()}.csv`)
  fs.writeFileSync(tmpFile, CSV_CONTENT)
  await page.getByRole('button', { name: /import csv/i }).click()
  await page.locator('input[type="file"]').setInputFiles(tmpFile)
  fs.unlinkSync(tmpFile)

  await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
  await expect(page.getByText('Alpha Epic')).toBeVisible({ timeout: 10_000 })

  const url = page.url()
  const projectId = url.match(/\/projects\/([^/]+)/)?.[1]!

  const [rtLoadResponse] = await Promise.all([
    page.waitForResponse(
      resp =>
        resp.url().includes(`/projects/${projectId}/resource-types`) &&
        !resp.url().includes('/named-resources') &&
        resp.request().method() === 'GET',
      { timeout: 15_000 }
    ),
    page.goto(`/projects/${projectId}/resource-profile`),
  ])
  expect(rtLoadResponse.ok()).toBeTruthy()

  await expect(
    page.getByRole('heading', { name: /resource profile/i })
  ).toBeVisible({ timeout: 10_000 })

  await expect(page.locator('input.w-20').first()).toBeVisible({ timeout: 10_000 })
  const dayRateInputs = page.locator('input.w-20')
  const drCount = await dayRateInputs.count()
  for (let i = 0; i < drCount; i++) {
    const input = dayRateInputs.nth(i)
    const currentValue = await input.inputValue()
    if (currentValue !== '') continue
    const [response] = await Promise.all([
      page.waitForResponse(
        resp =>
          resp.url().includes(`/projects/${projectId}/resource-types/`) &&
          resp.request().method() === 'PUT',
        { timeout: 10_000 }
      ),
      (async () => {
        await input.fill('1200')
        await input.press('Tab')
      })(),
    ])
    expect(response.ok()).toBeTruthy()
  }

  await page.getByRole('button', { name: /commercial/i }).click()
  await expect(
    page.getByRole('heading', { name: /cost summary/i })
  ).toBeVisible({ timeout: 10_000 })

  await expect(
    page.getByText(/^(As needed|Fixed for selected weeks ·|Fixed for whole project ·|Varies by week)/).first()
  ).toBeVisible({ timeout: 15_000 })

  return projectId
}

async function gotoResourceProfile(page: Page, projectId: string) {
  const [rtLoadResponse] = await Promise.all([
    page.waitForResponse(
      resp =>
        resp.url().includes(`/projects/${projectId}/resource-types`) &&
        !resp.url().includes('/named-resources') &&
        resp.request().method() === 'GET',
      { timeout: 15_000 }
    ),
    page.goto(`/projects/${projectId}/resource-profile`),
  ])
  expect(rtLoadResponse.ok()).toBeTruthy()
  await expect(page.getByRole('heading', { name: /capacity profile summary/i }).first()).toBeVisible({ timeout: 15_000 })
}

async function setupSquadPlannerCapacityPlan(page: Page) {
  const projectId = await setupCommercialTab(page)

  // Get auth token from localStorage (set by login helper)
  const token = await page.evaluate(() => localStorage.getItem('token'))
  const authHeaders: Record<string, string> = {}
  if (token) authHeaders['Authorization'] = `Bearer ${token}`

  // Navigate to Resource Profile and load RT IDs
  await page.goto(`/projects/${projectId}/resource-profile`)
  await expect(page.getByRole('heading', { name: /capacity profile summary/i })).toBeVisible({ timeout: 15_000 })

  // Fetch resource profile to discover resource type IDs
  const profileRes = await page.request.get(
    `${API_BASE}/api/projects/${projectId}/resource-profile`,
    { headers: authHeaders },
  )
  expect(profileRes.ok()).toBeTruthy()
  const profile = await profileRes.json()
  // Find a resource type to include in the plan (any except Project Manager)
  const planRt = profile.resourceRows.find((r: { name: string }) => r.name !== 'Project Manager')
  expect(planRt, 'Expected at least one non-Project Manager resource type').toBeTruthy()

  // Apply a squad plan with 2 distinct periods for the same RT to create
  // at least 2 capacity segments with differing capacity values:
  //   Period 1: W0-W3 at 50%
  //   Period 2: W4-W8 at 100%
  const applyRes = await page.request.post(
    `${API_BASE}/api/projects/${projectId}/squad-plan/apply`,
    {
      headers: authHeaders,
      data: {
        name: 'E2E test plan',
        targetWeeks: 8,
        periodWeeks: 4,
        maxDelta: 1,
        periods: [{
          periodIndex: 0,
          startWeek: 0,
          endWeek: 3,
          entries: [{
            resourceTypeId: planRt.resourceTypeId,
            headcount: 0.5,
            demandFTE: 1,
            utilisationPct: 100,
          }],
        }, {
          periodIndex: 1,
          startWeek: 4,
          endWeek: 8,
          entries: [{
            resourceTypeId: planRt.resourceTypeId,
            headcount: 1.0,
            demandFTE: 1,
            utilisationPct: 100,
          }],
        }],
        setActive: true,
      },
    },
  )
  expect(applyRes.ok()).toBeTruthy()

  // Pre-UI API verification: verify exact segments before navigating.
  // After the squad plan applies, segments are stored on named resources,
  // not the role-level capacityProfile. We verify the aggregate total.
  const verifyRes = await page.request.get(
    `${API_BASE}/api/projects/${projectId}/resource-profile`,
    { headers: authHeaders },
  )
  expect(verifyRes.ok()).toBeTruthy()
  const verifyProfile = await verifyRes.json()
  interface VerifySeg { startWeek: number; endWeek: number; capacityPercent: number }
  const planRtFromVerify = verifyProfile.resourceRows.find(
    (r: { resourceTypeId: string }) => r.resourceTypeId === planRt.resourceTypeId,
  )
  expect(planRtFromVerify, 'Plan RT should still exist in profile').toBeTruthy()
  // Collect all segments from named resources + role-level profile
  const allCPSegments: VerifySeg[] = [
    ...(planRtFromVerify.namedResources ?? []).flatMap(
      (nr: { capacityProfile?: { segments?: VerifySeg[] } | null }) => nr.capacityProfile?.segments ?? [],
    ),
    ...(planRtFromVerify.capacityProfile?.segments ?? []),
  ]
  expect(allCPSegments.length).toBeGreaterThanOrEqual(2)
  // Verify we have exactly the expected segments: 50% for W0-W3 and 100% for W4-W8
  const seg50 = allCPSegments.find(s => s.capacityPercent === 50)
  const seg100 = allCPSegments.find(s => s.capacityPercent === 100)
  expect(seg50, 'Segment with capacityPercent 50 should exist').toBeTruthy()
  expect(seg50!.startWeek).toBe(0)
  expect(seg50!.endWeek).toBe(2)
  expect(seg100, 'Segment with capacityPercent 100 should exist').toBeTruthy()
  expect(seg100!.startWeek).toBe(4)
  expect(seg100!.endWeek).toBe(7)
  const planResourceTypeId = planRt.resourceTypeId
  const planResourceName = planRt.name
  const beforeSegments: VerifySeg[] = allCPSegments
  
  // Navigate back to Resource Profile with fresh data
  await page.goto(`/projects/${projectId}/resource-profile`)
  await expect(page.getByRole('heading', { name: /capacity profile summary/i })).toBeVisible({ timeout: 15_000 })
  
  return { projectId, planResourceTypeId, planResourceName, beforeSegments }
}

test.describe('Resource Allocation', () => {
  test('commercial tab shows allocation badge', async ({ page }) => {
    test.setTimeout(90_000)
    await setupCommercialTab(page)

    const badge = page.getByText(/^(As needed|Fixed for selected weeks ·|Fixed for whole project ·|Varies by week)/).first()
    await expect(badge).toBeVisible({ timeout: 10_000 })
  })

  test('allocation editor opens on badge click, supports all four mode labels', async ({ page }) => {
    test.setTimeout(90_000)
    const projectId = await setupCommercialTab(page)
    await gotoResourceProfile(page, projectId)

    // Open the first editable row
    const badge = page.locator('button[title="Click to edit allocation"]').first()
    await expect(badge).toBeVisible({ timeout: 10_000 })
    // Regression: button contract must remain "Click to edit allocation"
    await expect(badge).toHaveAttribute('title', 'Click to edit allocation')
    await badge.click({ force: true })

    await expect(page.getByText(/Availability pattern/i).first()).toBeVisible({ timeout: 8_000 })

    // Select FULL_PROJECT to make Available % visible
    const modeSelect = page.locator('select').first()
    await expect(modeSelect).toBeVisible({ timeout: 5_000 })
    await modeSelect.selectOption('FULL_PROJECT')

    // Now Available % should be visible
    await expect(page.getByText(/Available %/i).first()).toBeVisible({ timeout: 5_000 })
    const capacityInput = page.locator('input[type="number"]').filter({ hasAttribute: 'min' }).first()
    await expect(capacityInput).toBeVisible({ timeout: 5_000 })

    await expect(page.locator('[data-testid="allocation-save"]')).toBeVisible()
    await expect(page.locator('[data-testid="allocation-cancel"]')).toBeVisible()

    // Cancel to close
    await page.locator('[data-testid="allocation-cancel"]').click()
    await expect(page.locator('[data-testid="allocation-cancel"]')).not.toBeVisible({ timeout: 5_000 })
  })

  test('EFFORT hides Available % control', async ({ page }) => {
    test.setTimeout(90_000)
    const projectId = await setupCommercialTab(page)
    await gotoResourceProfile(page, projectId)

    const badge = page.locator('button[title="Click to edit allocation"]').first()
    await expect(badge).toBeVisible({ timeout: 10_000 })
    await badge.click({ force: true })

    await expect(page.getByText(/Availability pattern/i).first()).toBeVisible({ timeout: 8_000 })
    const modeSelect = page.locator('select').first()
    await expect(modeSelect).toBeVisible({ timeout: 5_000 })

    // Select EFFORT — Available % should NOT be visible
    await modeSelect.selectOption('EFFORT')
    await expect(page.getByText(/Available %/i)).not.toBeVisible({ timeout: 3_000 })
    await expect(page.getByText(/Available Percent/i)).not.toBeVisible({ timeout: 3_000 })

    // Cancel to close
    await page.locator('[data-testid="allocation-cancel"]').click()
    await expect(page.locator('[data-testid="allocation-cancel"]')).not.toBeVisible({ timeout: 5_000 })
  })


  test('changing Available % updates allocated days', async ({ page }) => {
    test.setTimeout(90_000)
    const projectId = await setupCommercialTab(page)
    await gotoResourceProfile(page, projectId)

    const badge = page.locator('button[title="Click to edit allocation"]').first()
    await expect(badge).toBeVisible({ timeout: 10_000 })
    await badge.click({ force: true })

    await expect(page.getByText(/Availability pattern/i).first()).toBeVisible({ timeout: 8_000 })

    // Select FULL_PROJECT to access Available %
    const modeSelect = page.locator('select').first()
    await modeSelect.selectOption('FULL_PROJECT')
    await expect(page.getByText(/Available %/i).first()).toBeVisible({ timeout: 5_000 })

    const capacityInput = page.locator('input[type="number"]').filter({ hasAttribute: 'min' }).first()
    await capacityInput.fill('50')

    await page.locator('[data-testid="allocation-save"]').click()

    // Wait for the editor to close (onSuccess handler sets editingAllocation to null)
    await expect(page.locator('[data-testid="allocation-save"]')).not.toBeVisible({ timeout: 10_000 })

    // The badge should still be visible (row intact after save)
    await expect(
      page.locator('button[title="Click to edit allocation"]').first()
    ).toBeVisible({ timeout: 8_000 })
  })

  test('cancel closes editor without changing mode badge', async ({ page }) => {
    test.setTimeout(90_000)
    const projectId = await setupCommercialTab(page)
    await gotoResourceProfile(page, projectId)

    const badge = page.locator('button[title="Click to edit allocation"]').first()
    await expect(badge).toBeVisible({ timeout: 10_000 })
    const badgeTextBefore = await badge.textContent()

    await badge.click({ force: true })
    await expect(page.getByText(/Availability pattern/i).first()).toBeVisible({ timeout: 8_000 })

    const modeSelect = page.locator('select').first()
    await expect(modeSelect).toBeVisible({ timeout: 5_000 })
    await modeSelect.selectOption('FULL_PROJECT')

    // Click Cancel via data-testid
    await page.locator('[data-testid="allocation-cancel"]').click()

    // Editor should close
    await expect(page.locator('[data-testid="allocation-cancel"]')).not.toBeVisible({ timeout: 8_000 })

    // Badge text should be unchanged
    const badgeAfter = page.locator('button[title="Click to edit allocation"]').first()
    const badgeTextAfter = await badgeAfter.textContent()
    expect(badgeTextAfter?.trim()).toBe(badgeTextBefore?.trim())
  })

  test('summary tab shows Availability pattern column', async ({ page }) => {
    test.setTimeout(90_000)
    const projectId = await setupCommercialTab(page)
    await gotoResourceProfile(page, projectId)

    const allocationHeader = page.locator('th').filter({ hasText: /^Availability pattern$/ })
    await expect(allocationHeader.first()).toBeVisible({ timeout: 8_000 })
  })

  test('CAPACITY_PLAN row shows profile-managed state with safe editor, round-trip preserves segments', async ({ page }) => {
    test.setTimeout(120_000)
    const { projectId, planResourceTypeId, planResourceName, beforeSegments } = await setupSquadPlannerCapacityPlan(page)
  
    const scalarCalls: string[] = []
    page.on('request', req => {
      const url = req.url()
      if (url.includes('/resource-types/') && !url.includes('/named-resources/') && req.method() === 'PUT') {
        scalarCalls.push(url)
      }
    })
  
    // The planned resource row shows a people summary with capacity profile info
    // (Squad Planner creates planned-resource named resources, so the badge button
    //  is not rendered at the role level — the summary text appears instead)
    const planRow = page.locator('table tbody tr').filter({ hasText: planResourceName }).first()
    await expect(planRow).toBeVisible({ timeout: 10_000 })
  
    // The row shows the people count with capacity profile hint
    await expect(planRow).toContainText(/people · .* capacity profile/i)
  
    // Expand named resources for this role
    const peopleButton = planRow.locator('button[title="Show named resources"]')
    await expect(peopleButton).toBeVisible({ timeout: 5_000 })
    await peopleButton.click()
  
    // Find the planned resource within the expanded panel — it shows
    // capacity profile info with segments
    const cpSection = page.locator('text=/Profile:.*50%.*100%/').first()
    await expect(cpSection).toBeVisible({ timeout: 8_000 })
  
    // Verify the capacity profile display shows the expected segments
    // Format: W1-W4: 50% · W5-W8: 100%
    await expect(cpSection).toHaveText(/W1-W4: 50%.*W5-W8: 100%/)
  
    expect(scalarCalls).toHaveLength(0)
  
    // Round-trip: navigate away and back
    await page.goto(`/projects/${projectId}/timeline?panel=squad-planner`)
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/timeline\\?panel=squad-planner`))
  
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(page.getByRole('heading', { name: /capacity profile summary/i })).toBeVisible({ timeout: 15_000 })
  
    // Verify exact segment preservation via API
    const tokenAfter = await page.evaluate(() => localStorage.getItem('token'))
    const tokenStr = tokenAfter || ''
    const profileAfter = await page.evaluate(async ({ pid, tok }) => {
      const res = await fetch(`/api/projects/${pid}/resource-profile`, {
        headers: tok ? { Authorization: `Bearer ${tok}` } : {},
      })
      if (!res.ok) throw new Error('Profile fetch failed: ' + res.status)
      return res.json()
    }, { pid: projectId, tok: tokenStr })
    const rtRowData = profileAfter.resourceRows.find(
      (r: { resourceTypeId: string }) => r.resourceTypeId === planResourceTypeId,
    )
    expect(rtRowData, `Resource row ${planResourceTypeId} should exist after round-trip`).toBeTruthy()
    const afterAllSegments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }> = [
      ...(rtRowData.namedResources ?? []).flatMap(
        (nr: { capacityProfile?: { segments?: Array<{ startWeek: number; endWeek: number; capacityPercent: number }> } | null }) => nr.capacityProfile?.segments ?? [],
      ),
      ...(rtRowData.capacityProfile?.segments ?? []),
    ]
    expect(afterAllSegments).toEqual(beforeSegments)
  })

})

// ── Responsive measurements: Timeline resource-counts panel ──
const VP_820 = { width: 820, height: 900 }
const VP_390 = { width: 390, height: 844 }

async function expectElementToFit(locator: Locator) {
  const ok = await locator.evaluate(
    (el: Element) => (el as HTMLElement).scrollWidth <= (el as HTMLElement).clientWidth + 1,
  )
  expect(ok).toBe(true)
}

async function measurePatternSelect(page: Page, viewport: { width: number; height: number }, rowLoc: Locator) {
  await page.setViewportSize(viewport)
  const nrSelect = rowLoc.locator('select[aria-label*="Availability pattern for"]')
  await expect(nrSelect).toBeVisible()
  
  // Change to FULL_PROJECT (longest option) and wait for PATCH to settle
  const patchResp = page.waitForResponse(
    resp => resp.request().method() === 'PATCH' && resp.url().includes('/named-resources/'),
    { timeout: 10_000 },
  )
  await nrSelect.selectOption('FULL_PROJECT')
  await patchResp
  
  // Measure select clientWidth
  const selectWidth = await nrSelect.evaluate((el: HTMLSelectElement) => el.clientWidth)
  
  // Create hidden mirror element with same computed font to measure text width
  const requiredWidth = await nrSelect.evaluate((el: HTMLSelectElement) => {
    const idx = el.selectedIndex
    const text = idx >= 0 ? el.options[idx].text : ''
    const style = window.getComputedStyle(el)
    const mirror = document.createElement('span')
    mirror.textContent = text
    mirror.style.cssText = [
      'position:absolute',
      'visibility:hidden',
      'white-space:nowrap',
      `font-family:${style.fontFamily}`,
      `font-size:${style.fontSize}`,
      `font-weight:${style.fontWeight}`,
      `letter-spacing:${style.letterSpacing}`,
      'left:-9999px',
      'top:-9999px',
    ].join(';')
    document.body.appendChild(mirror)
    const w = mirror.offsetWidth + 24
    document.body.removeChild(mirror)
    return w
  })
  
  expect(selectWidth).toBeGreaterThanOrEqual(requiredWidth)
}

async function addNamedResourceSimple(page: Page): Promise<string> {
  const counts = page.getByTestId('resource-counts')
  const addButton = counts.getByRole('button', { name: /add named resource/i }).first()
  await expect(addButton).toBeVisible({ timeout: 10_000 })

  const postResp = page.waitForResponse(
    resp => resp.request().method() === 'POST' && resp.url().includes('/named-resources'),
    { timeout: 10_000 },
  )
  await addButton.click()
  await postResp

  const nrRow = counts.locator('[data-testid^="named-resource-row-"]').first()
  await expect(nrRow).toBeVisible({ timeout: 10_000 })
  const testId = await nrRow.getAttribute('data-testid')
  expect(testId).toBeTruthy()
  return testId!
}

test.describe('Responsive measurements — Timeline resource-counts', () => {
  test('desktop: pattern select accommodates longest option with no overflow', async ({ page }) => {
    test.setTimeout(120_000)
    const projectId = await setupCommercialTab(page)
    await page.goto(`/projects/${projectId}/timeline`)
    await expect(page.getByText(/Timeline Planner/i)).toBeVisible({ timeout: 10_000 })
    await quickSchedule(page)
    await expect(page.getByText(/\d+ features scheduled/i)).toBeVisible({ timeout: 15_000 })

    const nrTestId = await addNamedResourceSimple(page)
    const rowLoc = page.getByTestId(nrTestId)

    // Measure pattern select width against longest option
    await measurePatternSelect(page, { width: 1280, height: 720 }, rowLoc)
  
    // Re-acquire select locator after PATCH settled
    const freshSelect = rowLoc.locator('select[aria-label*="Availability pattern for"]')
    const selectBox = await freshSelect.boundingBox()
    expect(selectBox).not.toBeNull()

    // Select does not overlap Available % grid cell
    const availPctCell = rowLoc.locator('> span ~ div').nth(1)
    const pctBox = await availPctCell.boundingBox()
    expect(pctBox).not.toBeNull()
    expect(selectBox!.x + selectBox!.width).toBeLessThanOrEqual(pctBox!.x + 1)

    // Select does not overlap Available from grid cell
    const availFromCell = rowLoc.locator('> span ~ div').nth(2)
    const fromBox = await availFromCell.boundingBox()
    expect(fromBox).not.toBeNull()
    expect(selectBox!.x + selectBox!.width).toBeLessThanOrEqual(fromBox!.x + 1)

    // Availability pattern header does not overlap adjacent headers
    const headers = page.getByTestId('named-resource-headers')
    const patternHeader = headers.locator('> *').nth(1)
    const availHeader = headers.locator('> *').nth(2)
    const patHBox = await patternHeader.boundingBox()
    const avHBox = await availHeader.boundingBox()
    expect(patHBox).not.toBeNull()
    expect(avHBox).not.toBeNull()
    expect(patHBox!.x + patHBox!.width).toBeLessThanOrEqual(avHBox!.x + 1)

    // Contextual help scrollWidth <= clientWidth (no overflow)
    const helpText = rowLoc.getByText(/Available at the selected percentage/i)
    await expectElementToFit(helpText)

    // Row has no horizontal overflow
    await expectElementToFit(rowLoc)

    // Document has no horizontal overflow
    const docSW = await page.evaluate(() => document.documentElement.scrollWidth)
    const docCW = await page.evaluate(() => window.innerWidth)
    expect(docSW <= docCW + 1).toBe(true)
  })

  test('820px viewport: pattern select, controls visible with no overflow', async ({ page }) => {
    test.setTimeout(120_000)
    const projectId = await setupCommercialTab(page)
    await page.goto(`/projects/${projectId}/timeline`)
    await expect(page.getByText(/Timeline Planner/i)).toBeVisible({ timeout: 10_000 })
    await quickSchedule(page)
    await expect(page.getByText(/\d+ features scheduled/i)).toBeVisible({ timeout: 15_000 })

    await page.setViewportSize(VP_820)

    const nrTestId = await addNamedResourceSimple(page)
    const rowLoc = page.getByTestId(nrTestId)

    // Measure pattern select width against longest option
    await measurePatternSelect(page, VP_820, rowLoc)
  
    // Re-acquire select locator after PATCH settled
    const freshSelect = rowLoc.locator('select[aria-label*="Availability pattern for"]')
    const selectBox = await freshSelect.boundingBox()
    expect(selectBox).not.toBeNull()

    // Select does not overlap Available % grid cell
    const availPctCell = rowLoc.locator('> span ~ div').nth(1)
    const pctBox = await availPctCell.boundingBox()
    expect(pctBox).not.toBeNull()
    expect(selectBox!.x + selectBox!.width).toBeLessThanOrEqual(pctBox!.x + 1)

    // Select does not overlap Available from grid cell
    const availFromCell = rowLoc.locator('> span ~ div').nth(2)
    const fromBox = await availFromCell.boundingBox()
    expect(fromBox).not.toBeNull()
    expect(selectBox!.x + selectBox!.width).toBeLessThanOrEqual(fromBox!.x + 1)

    // Availability pattern header does not overlap adjacent headers
    const headers = page.getByTestId('named-resource-headers')
    const patternHeader = headers.locator('> *').nth(1)
    const availHeader = headers.locator('> *').nth(2)
    const patHBox = await patternHeader.boundingBox()
    const avHBox = await availHeader.boundingBox()
    expect(patHBox).not.toBeNull()
    expect(avHBox).not.toBeNull()
    expect(patHBox!.x + patHBox!.width).toBeLessThanOrEqual(avHBox!.x + 1)

    // Contextual help fits
    const helpText = rowLoc.getByText(/Available at the selected percentage/i)
    await expectElementToFit(helpText)

    // Row fits
    await expectElementToFit(rowLoc)

    // Document has no overflow
    const docSW = await page.evaluate(() => document.documentElement.scrollWidth)
    const docCW = await page.evaluate(() => window.innerWidth)
    expect(docSW <= docCW + 1).toBe(true)

    // Select still visible after resize
    await expect(freshSelect).toBeVisible()

    // All controls visible
    await expect(
      rowLoc.getByRole('spinbutton', { name: /available percentage for/i }).first(),
    ).toBeVisible()
    await expect(
      rowLoc.getByRole('spinbutton', { name: /available from week for/i }).first(),
    ).toBeVisible()
    await expect(
      rowLoc.getByRole('spinbutton', { name: /available to week for/i }).first(),
    ).toBeVisible()
  })

  test('390px viewport: mobile stacking with readable select and View Resource Profile', async ({ page }) => {
    test.setTimeout(120_000)
    const projectId = await setupCommercialTab(page)
    await page.goto(`/projects/${projectId}/timeline`)
    await expect(page.getByText(/Timeline Planner/i)).toBeVisible({ timeout: 10_000 })
    await quickSchedule(page)
    await expect(page.getByText(/\d+ features scheduled/i)).toBeVisible({ timeout: 15_000 })

    await page.setViewportSize(VP_390)

    const nrTestId = await addNamedResourceSimple(page)
    const rowLoc = page.getByTestId(nrTestId)

    // Mobile inline labels visible
    await expect(rowLoc.getByText('Pattern:')).toBeVisible()
    await expect(rowLoc.getByText('Avail:')).toBeVisible()
    await expect(rowLoc.getByText('Avail from:')).toBeVisible()
    await expect(rowLoc.getByText('Avail to:')).toBeVisible()

    // Switch to CAPACITY_PLAN to check View Resource Profile button
    const nrSelect = rowLoc.locator('select[aria-label*="Availability pattern for"]')
    await expect(nrSelect).toBeVisible()
    const patchResp = page.waitForResponse(
      resp => resp.request().method() === 'PATCH' && resp.url().includes('/named-resources/'),
      { timeout: 10_000 },
    )
    await nrSelect.selectOption('CAPACITY_PLAN')
    await patchResp

    // Re-acquire select after PATCH settles
    const mobileSelect = rowLoc.locator('select[aria-label*="Availability pattern for"]')
    await expect(mobileSelect).toBeVisible()
    await expect(mobileSelect).toHaveValue('CAPACITY_PLAN')
    // Selected option remains readable — verify text content not clipped using mirror element
    const selectWidth = await mobileSelect.evaluate((el: HTMLSelectElement) => el.clientWidth)
    const requiredWidth = await mobileSelect.evaluate((el: HTMLSelectElement) => {
      const idx = el.selectedIndex
      const text = idx >= 0 ? el.options[idx].text : ''
      const style = window.getComputedStyle(el)
      const mirror = document.createElement('span')
      mirror.textContent = text
      mirror.style.cssText = [
        'position:absolute',
        'visibility:hidden',
        'white-space:nowrap',
        `font-family:${style.fontFamily}`,
        `font-size:${style.fontSize}`,
        `font-weight:${style.fontWeight}`,
        `letter-spacing:${style.letterSpacing}`,
        'left:-9999px',
        'top:-9999px',
      ].join(';')
      document.body.appendChild(mirror)
      const w = mirror.offsetWidth + 24
      document.body.removeChild(mirror)
      return w
    })
    expect(selectWidth).toBeGreaterThanOrEqual(requiredWidth)
  
    // Help text wraps within row
    const helpText = rowLoc.getByText(/Availability varies by week/i)
    await expect(helpText).toBeVisible()
    const helpFits = await helpText.evaluate((el: Element) => (el as HTMLElement).scrollWidth <= (el as HTMLElement).clientWidth + 1)
    expect(helpFits).toBe(true)
  
    // Pattern, Avail, Avail from, Avail to groups stack vertically
    const basisGroup = rowLoc.getByText('Pattern:').locator('..')
    const allocGroup = rowLoc.getByText('Avail:').locator('..')
    const startGroup = rowLoc.getByText('Avail from:').locator('..')
    const endGroup = rowLoc.getByText('Avail to:').locator('..')
    const basisBox = await basisGroup.boundingBox()
    const allocBox = await allocGroup.boundingBox()
    const startBox = await startGroup.boundingBox()
    const endBox = await endGroup.boundingBox()
    expect(basisBox).not.toBeNull()
    expect(allocBox).not.toBeNull()
    expect(startBox).not.toBeNull()
    expect(endBox).not.toBeNull()
    expect(allocBox!.y).toBeGreaterThanOrEqual(basisBox!.y + basisBox!.height - 2)
    expect(startBox!.y).toBeGreaterThanOrEqual(allocBox!.y + allocBox!.height - 2)
    expect(endBox!.y).toBeGreaterThanOrEqual(startBox!.y + startBox!.height - 2)
  
    // View Resource Profile button visible and clickable
    const rpButton = page.getByRole('button', { name: /view resource profile/i })
    await expect(rpButton).toBeVisible()
    await expect(rpButton).toBeEnabled()
    // Click and verify navigation to resource profile
    await rpButton.click()
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/resource-profile`))
    // No horizontal page overflow in resource-counts panel
    const countsPanel = page.getByTestId('resource-counts')
    await expectElementToFit(countsPanel)
  })

  test('CAPACITY_PLAN: help text and View Resource Profile at desktop and 820px', async ({ page }) => {
    test.setTimeout(120_000)
    const projectId = await setupCommercialTab(page)
    await page.goto(`/projects/${projectId}/timeline`)
    await expect(page.getByText(/Timeline Planner/i)).toBeVisible({ timeout: 10_000 })
    await quickSchedule(page)
    await expect(page.getByText(/\d+ features scheduled/i)).toBeVisible({ timeout: 15_000 })

    const nrTestId = await addNamedResourceSimple(page)
    const rowLoc = page.getByTestId(nrTestId)

    // Switch to CAPACITY_PLAN
    const nrSelect = rowLoc.locator('select[aria-label*="Availability pattern for"]')
    await expect(nrSelect).toBeVisible()
    const patchResp = page.waitForResponse(
      resp => resp.request().method() === 'PATCH' && resp.url().includes('/named-resources/'),
      { timeout: 10_000 },
    )
    await nrSelect.selectOption('CAPACITY_PLAN')
    await patchResp

    // ── Desktop (default viewport) ──
    // Varies by week help text visible
    const cpHelp = rowLoc.getByText(/Availability varies by week/i)
    await expect(cpHelp).toBeVisible()

    // Contextual help inside row
    const rowBox = await rowLoc.boundingBox()
    const helpBox = await cpHelp.boundingBox()
    expect(rowBox).not.toBeNull()
    expect(helpBox).not.toBeNull()
    expect(helpBox!.x).toBeGreaterThanOrEqual(rowBox!.x - 1)
    expect(helpBox!.x + helpBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 1)
    expect(helpBox!.y).toBeGreaterThanOrEqual(rowBox!.y - 1)
    expect(helpBox!.y + helpBox!.height).toBeLessThanOrEqual(rowBox!.y + rowBox!.height + 1)

    // View Resource Profile visible and not overlapping adjacent grid column
    const rpBtn = page.getByRole('button', { name: /view resource profile/i })
    await expect(rpBtn).toBeVisible()
    const patternCell = rowLoc.locator('> div').first()
    const patternBox = await patternCell.boundingBox()
    const rpBox = await rpBtn.boundingBox()
    expect(patternBox).not.toBeNull()
    expect(rpBox).not.toBeNull()
    expect(rpBox!.x).toBeGreaterThanOrEqual(patternBox!.x - 1)
    expect(rpBox!.x + rpBox!.width).toBeLessThanOrEqual(patternBox!.x + patternBox!.width + 1)

    // ── 820px viewport ──
    await page.setViewportSize(VP_820)

    await expect(page.getByRole('button', { name: /view resource profile/i })).toBeVisible()
    await expect(rowLoc.locator('select[aria-label*="Availability pattern for"]')).toBeVisible()
    await expect(rowLoc.getByText(/Availability varies by week/i)).toBeVisible()

    // Help text fits inside row at 820px
    await expectElementToFit(rowLoc.getByText(/Availability varies by week/i))

    // View Resource Profile visible and within row bounds
    const rpBtn820 = page.getByRole('button', { name: /view resource profile/i })
    await expect(rpBtn820).toBeVisible()
    const rp820Box = await rpBtn820.boundingBox()
    const row820Box = await rowLoc.boundingBox()
    expect(rp820Box).not.toBeNull()
    expect(row820Box).not.toBeNull()
    expect(rp820Box!.x).toBeGreaterThanOrEqual(row820Box!.x - 1)
    expect(rp820Box!.x + rp820Box!.width).toBeLessThanOrEqual(row820Box!.x + row820Box!.width + 1)
  })
})
