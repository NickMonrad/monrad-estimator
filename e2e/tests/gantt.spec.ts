/**
 * E2E tests for the Gantt chart on the Timeline page.
 *
 * Tests cover chart rendering, inline editing, and the searchable feature
 * dependency picker.
 */
import { test, expect, type Page, type Locator } from '@playwright/test'
import { login, createProject, quickSchedule } from './helpers'

// ---------------------------------------------------------------------------
// Shared setup helper
// ---------------------------------------------------------------------------

/**
 * Log in, create a project with 1 epic + 1 feature, navigate to the
 * Timeline page, fill the start date, click Update timeline, and wait
 * until the Gantt grid footer ("X features scheduled") is visible.
 */
async function setupTimeline(
  page: Page,
  featureCount = 1,
): Promise<{ projectName: string; epicName: string; featureName: string; featureNames: string[] }> {
  const suffix = Date.now()
  const projectName = `E2E Gantt ${suffix}`
  const epicName = `GanttEpic ${suffix}`
  const featureNames = Array.from({ length: featureCount }, (_, index) =>
    index === 0 ? `GanttFeat ${suffix}` : `GanttFeat ${suffix} ${index + 1}`,
  )

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

  // Add features (the epic expands after each creation, revealing "+ Add feature")
  for (const featureName of featureNames) {
    await expect(page.getByText('+ Add feature')).toBeVisible({ timeout: 5_000 })
    await page.getByText('+ Add feature').click()
    await page.getByPlaceholder('Feature name *').fill(featureName)
    await page.getByRole('button', { name: /^save$/i }).click()
    await expect(page.getByText(featureName)).toBeVisible({ timeout: 8_000 })
  }

  // Navigate hub → Timeline
  const hubUrl = page.url().replace('/backlog', '')
  await page.goto(hubUrl)
  await page.getByRole('button', { name: /timeline/i }).waitFor({ timeout: 8_000 })
  await page.getByRole('button', { name: /timeline/i }).click()
  await expect(page.getByRole('heading', { name: /timeline planner/i })).toBeVisible({
    timeout: 8_000,
  })

  // Set start date, then Update timeline
  const dateInput = page.locator('input[type="date"]')
  await expect(dateInput).toBeVisible({ timeout: 8_000 })
  await dateInput.fill('2026-06-01')
  await expect(dateInput).toHaveValue('2026-06-01')
  await quickSchedule(page)

  // Wait until the Gantt footer appears — it is only rendered once
  // timeline.entries.length > 0, so it's the earliest reliable signal
  // that the chart has been fully populated.
  await expect(page.getByText(/features scheduled/)).toBeVisible({ timeout: 15_000 })

  return { projectName, epicName, featureName: featureNames[0], featureNames }
}

async function dragDependencyHandle(page: Page, handle: Locator, targetFeature: Locator) {
  await handle.scrollIntoViewIfNeeded()
  await targetFeature.scrollIntoViewIfNeeded()
  const handleBox = await handle.boundingBox()
  const targetBox = await targetFeature.locator('rect').first().boundingBox()
  if (!handleBox || !targetBox) throw new Error('Dependency drag geometry is unavailable')
  const handlePoint = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 }
  await page.mouse.move(handlePoint.x, handlePoint.y)
  await page.mouse.down()
  await expect(page.getByTestId('dependency-drag-preview')).toBeVisible()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 5 })
  await page.mouse.up()
}
// Tests
// ---------------------------------------------------------------------------

test.describe('Gantt Chart', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // 1. Smoke test: feature bars are rendered after update timeline
  // ──────────────────────────────────────────────────────────────────────────
  test('update timeline renders feature bars in the Gantt grid', async ({ page }) => {
    await setupTimeline(page)

    // The footer "X weeks total · X features scheduled" is only rendered when
    // timeline.entries.length > 0 — it has already been waited for in
    // setupTimeline, so this assert is nearly instant.
    await expect(page.getByText(/1 features scheduled/)).toBeVisible({ timeout: 8_000 })

    // Feature bars are SVG <rect> elements inside the Gantt SVG.
    // At least one must exist once entries are present.
    await expect(page.locator('svg rect').first()).toBeVisible({ timeout: 8_000 })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Epic feature-mode toggle: sequential ↔ parallel
  // ──────────────────────────────────────────────────────────────────────────
  test('epic feature-mode button toggles between sequential and parallel', async ({ page }) => {
    await setupTimeline(page)

    // The epic header row always shows the mode button (default: sequential).
    // The button's aria-label is 'sequential' in default state and 'parallel' after toggle.
    const seqButton = page.getByRole('button', { name: 'sequential' })
    await expect(seqButton).toBeVisible({ timeout: 8_000 })

    // Clicking switches to parallel mode
    await seqButton.click()

    await expect(
      page.getByRole('button', { name: 'parallel' }),
    ).toBeVisible({ timeout: 10_000 })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Feature bar click opens inline edit panel
  // ──────────────────────────────────────────────────────────────────────────
  test('clicking a feature bar opens the inline edit panel', async ({ page }) => {
    const { featureName } = await setupTimeline(page)

    // The feature label element carries title={featureName}.
    // Clicking it opens the inline edit.
    await page.locator(`[title="${featureName}"]`).click()

    // Inline edit panel appears with labelled number inputs
    await expect(page.getByText('Start week:').first()).toBeVisible({ timeout: 8_000 })
    // Start week input (min="0") and duration input (min="0.2") are distinct
    await expect(page.locator('input[min="0"]').first()).toBeVisible({ timeout: 8_000 })
    await expect(page.locator('input[min="0.2"]').first()).toBeVisible({ timeout: 8_000 })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Manual start-week override shows ✏ indicator on the bar
  // ──────────────────────────────────────────────────────────────────────────
  test('saving a manual start week shows the ✏ override indicator', async ({ page }) => {
    const { featureName } = await setupTimeline(page)

    // Open the inline edit by clicking the feature label
    await page.locator(`[title="${featureName}"]`).click()
    await expect(page.getByText('Start week:').first()).toBeVisible({ timeout: 8_000 })

    // Move the feature to week 2 (any value ≠ current auto-scheduled week)
    const startWeekInput = page.locator('input[min="0"]:not([id])').first()
    await startWeekInput.fill('2')

    // Save — triggers PUT /timeline/:featureId with isManual: true
    await page.getByRole('button', { name: /^save$/i }).click()

    // After the server persists isManual=true the Gantt re-renders and the
    // edit panel shows the "↺ Reset to auto" button (only visible when isManual=true)
    await expect(page.getByRole('button', { name: /reset to auto/i })).toBeVisible({ timeout: 10_000 })
  })
  test('searches and creates a feature dependency in Timeline order', async ({ page }) => {
    test.setTimeout(60_000)
    const suffix = Date.now()
    const projectName = `E2E Dependency Picker ${suffix}`
    const epics = [
      { name: `Picker Alpha ${suffix}`, features: [`Alpha First ${suffix}`, `Alpha Second ${suffix}`] },
      { name: `Picker Beta ${suffix}`, features: [`Beta First ${suffix}`, `Beta Second ${suffix}`] },
    ]

    await login(page)
    await createProject(page, projectName)
    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).click()

    for (const epic of epics) {
      await page.getByRole('button', { name: /add epic/i }).click()
      await page.getByPlaceholder(/epic name/i).fill(epic.name)
      await page.getByRole('button', { name: /save epic/i }).click()
      await expect(page.getByText(epic.name, { exact: true })).toBeVisible()
      for (const feature of epic.features) {
        await page.getByText('+ Add feature').last().click()
        await page.getByPlaceholder('Feature name *').fill(feature)
        await page.getByRole('button', { name: /^save$/i }).click()
        await expect(page.getByText(feature, { exact: true })).toBeVisible()
      }
    }

    const hubUrl = page.url().replace('/backlog', '')
    await page.goto(hubUrl)
    await page.getByRole('button', { name: /timeline/i }).click()
    await expect(page.getByRole('heading', { name: /timeline planner/i })).toBeVisible()
    await page.locator('input[type="date"]').fill('2026-06-01')
    await quickSchedule(page)
    await expect(page.getByText(/features scheduled/)).toBeVisible({ timeout: 15_000 })

    await page.locator(`[title="Alpha First ${suffix}"]`).click()
    const picker = page.getByRole('button', { name: 'Add dependency' })
    await picker.click()

    const search = page.getByRole('combobox', { name: 'Search dependencies' })
    await expect(search).toBeFocused()
    await search.fill('second')
    await expect(page.getByRole('option')).toHaveText([
      `Picker Alpha ${suffix} / Alpha Second ${suffix}`,
      `Picker Beta ${suffix} / Beta Second ${suffix}`,
    ])

    await search.fill('beta')
    await expect(page.getByRole('option')).toHaveText([
      `Picker Beta ${suffix} / Beta First ${suffix}`,
      `Picker Beta ${suffix} / Beta Second ${suffix}`,
    ])
    await search.press('Escape')
    await expect(page.getByRole('combobox', { name: 'Search dependencies' })).not.toBeVisible()

    await picker.click()
    await search.fill('second')
    await search.press('ArrowDown')
    await expect(page.getByRole('option', { name: `Picker Alpha ${suffix} / Alpha Second ${suffix}` })).toHaveAttribute('aria-selected', 'true')
    await search.press('Enter')

    await page.reload()
    await expect(page.getByRole('heading', { name: /timeline planner/i })).toBeVisible()
    await page.locator(`[title="Alpha First ${suffix}"]`).click()
    await expect(page.getByTestId('dep-section')).toContainText(`Alpha Second ${suffix}`)
  })
  test('dragging a right handle creates and persists a feature dependency', async ({ page }) => {
    test.setTimeout(60_000)
    const { featureNames } = await setupTimeline(page, 2)
    const source = page.locator(`[data-feature-name="${featureNames[0]}"]`)
    const target = page.locator(`[data-feature-name="${featureNames[1]}"]`)

    const rightHandle = source.getByRole('button', { name: 'Create dependency from this feature' })
    await expect(rightHandle).toBeVisible()
    await dragDependencyHandle(page, rightHandle, target)
    await expect(page.getByRole('status')).toHaveText('Dependency created.')
    await expect(page.locator('[data-testid^="dependency-arrow-"]')).toBeVisible()

    await page.reload()
    await expect(page.getByRole('heading', { name: /timeline planner/i })).toBeVisible()
    await page.locator(`[title="${featureNames[1]}"]`).click()
    await expect(page.getByTestId('dep-section')).toContainText(featureNames[0])
  })

  test('dragging a left handle uses the reverse UI direction mapping', async ({ page }) => {
    test.setTimeout(60_000)
    const { featureNames } = await setupTimeline(page, 2)
    const source = page.locator(`[data-feature-name="${featureNames[1]}"]`)
    const target = page.locator(`[data-feature-name="${featureNames[0]}"]`)

    await dragDependencyHandle(page, source.getByRole('button', { name: 'Create dependency to this feature' }), target)
    await expect(page.getByRole('status')).toHaveText('Dependency created.')
    await expect(page.locator('[data-testid^="dependency-arrow-"]')).toBeVisible()
  })

  test('blocks self and duplicate dependency drops in the chart', async ({ page }) => {
    test.setTimeout(60_000)
    const { featureNames } = await setupTimeline(page, 2)
    const source = page.locator(`[data-feature-name="${featureNames[0]}"]`)
    const target = page.locator(`[data-feature-name="${featureNames[1]}"]`)

    const rightHandle = source.getByRole('button', { name: 'Create dependency from this feature' })
    await dragDependencyHandle(page, rightHandle, source)
    await expect(page.getByRole('alert')).toHaveText(/cannot depend on itself/i)

    await dragDependencyHandle(page, rightHandle, target)
    await expect(page.getByRole('status')).toHaveText('Dependency created.')
    await dragDependencyHandle(page, rightHandle, target)
    await expect(page.getByRole('alert')).toHaveText(/already exists/i)
  })

  test('surfaces a server-rejected cyclic dependency drop', async ({ page }) => {
    test.setTimeout(60_000)
    const { featureNames } = await setupTimeline(page, 2)
    const first = page.locator(`[data-feature-name="${featureNames[0]}"]`)
    const second = page.locator(`[data-feature-name="${featureNames[1]}"]`)

    await dragDependencyHandle(page, second.getByRole('button', { name: 'Create dependency to this feature' }), first)
    await expect(page.getByRole('status')).toHaveText('Dependency created.')
    await dragDependencyHandle(page, first.getByRole('button', { name: 'Create dependency to this feature' }), second)
    await expect(page.getByRole('alert')).toHaveText(/circular reference/i)
  })

})

test.describe('Timeline Gantt UX — scale toggle, expand/collapse, allocation', () => {
  test('scale toggle switches between Week, Month, Quarter, and Year views', async ({ page }) => {
    await setupTimeline(page)

    // The scale buttons are labelled Wk, Mo, Qtr, Yr
    const wkBtn = page.getByRole('button', { name: /^wk$/i })
    const moBtn = page.getByRole('button', { name: /^Mo$/ })
    const qtrBtn = page.getByRole('button', { name: /^Qtr$/ })
    const yrBtn = page.getByRole('button', { name: /^Yr$/ })

    await expect(wkBtn).toBeVisible()
    await expect(moBtn).toBeVisible()
    await expect(qtrBtn).toBeVisible()
    await expect(yrBtn).toBeVisible()

    // Week is active by default
    await expect(wkBtn).toHaveClass(/bg-lab3-navy/)

    // Switch to Month — button becomes active, Gantt re-renders
    await moBtn.click()
    await expect(moBtn).toHaveClass(/bg-lab3-navy/)

    // Switch to Quarter
    await qtrBtn.click()
    await expect(qtrBtn).toHaveClass(/bg-lab3-navy/)

    await yrBtn.click()
    await expect(yrBtn).toHaveClass(/bg-lab3-navy/)

    // Year scale should show H1/H2 half-year header labels in the SVG
    await expect(page.locator('svg text').filter({ hasText: /^H[12]/ })).toBeVisible({ timeout: 5_000 })

    // Gantt still renders feature bars after scale switch
    await expect(page.getByText(/features scheduled/)).toBeVisible({ timeout: 8_000 })

    // Switch back to Week
    await wkBtn.click()
    await expect(wkBtn).toHaveClass(/bg-lab3-navy/)

    await expect(page.getByText(/features scheduled/)).toBeVisible({ timeout: 8_000 })
  })

  test('Expand All and Collapse All toggle epic rows persistently across refetch', async ({ page }) => {
    const { featureName } = await setupTimeline(page)

    // The feature label/title is rendered in the Gantt label panel.
    // On first load, the single epic is auto-expanded, so the feature row is visible.
    const featureLoc = page.locator(`[title="${featureName}"]`).first()
    await expect(featureLoc).toBeVisible({ timeout: 8_000 })

    // "Collapse All" button — title attribute set by the component
    const collapseBtn = page.getByTitle('Collapse all epics')
    const expandBtn = page.getByTitle('Expand all epics')

    await expect(collapseBtn).toBeVisible()
    await expect(expandBtn).toBeVisible()

    // Click Collapse All — all epics should collapse, hiding child rows
    await collapseBtn.click()
    await expect(featureLoc).not.toBeVisible({ timeout: 5_000 })

    // Re-schedule to trigger a refetch — knownEpicIds ref prevents auto-expand
    // of previously known epics, verifying the persistence fix for #232.
    await quickSchedule(page)
    await expect(featureLoc).not.toBeVisible({ timeout: 15_000 })

    // Click Expand All — child rows should reappear
    await expandBtn.click()
    await expect(featureLoc).toBeVisible({ timeout: 5_000 })

    // Trigger another refetch and confirm expanded state persists
    // (knownEpicIds ref maintains expanded state for known epics after manual toggle)
    await quickSchedule(page)
    await expect(featureLoc).toBeVisible({ timeout: 15_000 })
  })

  // Note: Named resource allocation editing and per-person histogram bar count tests
  // (issue #232) require creating named resources first. The Resource Profile allocation
  // mode/FTE/window tests are covered in timeline.spec.ts. The histogram bar count test
  // (visual sanity check that per-person bars render, not full-pool aggregate) is
  // deferred as a follow-up since it requires named resources setup via CSV import.
})
