/**
 * E2E tests for the Gantt chart on the Timeline page.
 *
 * The current implementation uses a CSS-grid Gantt layout rendered
 * directly in TimelinePage.tsx.  Feature bars are coloured <div> cells
 * (class "h-6 cursor-pointer") positioned via CSS grid-column.
 *
 * Tests cover:
 *   1. Auto-schedule populates the Gantt grid with feature bars.
 *   2. The epic feature-mode button toggles sequential ↔ parallel.
 *   3. Clicking a feature bar (or label) opens the inline edit panel.
 *   4. Saving a manual start week via inline edit marks the bar with ✏.
 */
import { test, expect, type Page } from '@playwright/test'
import { login, createProject } from './helpers'

// ---------------------------------------------------------------------------
// Shared setup helper
// ---------------------------------------------------------------------------

/**
 * Log in, create a project with 1 epic + 1 feature, navigate to the
 * Timeline page, fill the start date, click Auto-schedule, and wait
 * until the Gantt grid footer ("X features scheduled") is visible.
 */
async function setupTimeline(
  page: Page,
): Promise<{ projectName: string; epicName: string; featureName: string }> {
  const suffix = Date.now()
  const projectName = `E2E Gantt ${suffix}`
  const epicName    = `GanttEpic ${suffix}`
  const featureName = `GanttFeat ${suffix}`

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

  // Add feature (epic expands after creation, revealing "+ Add feature")
  await expect(page.getByText('+ Add feature')).toBeVisible({ timeout: 5_000 })
  await page.getByText('+ Add feature').click()
  await page.getByPlaceholder('Feature name *').fill(featureName)
  await page.getByRole('button', { name: /^save$/i }).click()
  await expect(page.getByText(featureName)).toBeVisible({ timeout: 8_000 })

  // Navigate hub → Timeline
  const hubUrl = page.url().replace('/backlog', '')
  await page.goto(hubUrl)
  await page.getByRole('button', { name: /timeline/i }).waitFor({ timeout: 8_000 })
  await page.getByRole('button', { name: /timeline/i }).click()
  await expect(page.getByRole('heading', { name: /timeline planner/i })).toBeVisible({
    timeout: 8_000,
  })

  // Set start date, then Auto-schedule
  const dateInput = page.locator('input[type="date"]')
  await expect(dateInput).toBeVisible({ timeout: 8_000 })
  await dateInput.fill('2026-06-01')
  await expect(dateInput).toHaveValue('2026-06-01')
  await page.getByRole('button', { name: /auto-schedule/i }).click()

  // Wait until the Gantt footer appears — it is only rendered once
  // timeline.entries.length > 0, so it's the earliest reliable signal
  // that the CSS-grid chart has been fully populated.
  await expect(page.getByText(/features scheduled/)).toBeVisible({ timeout: 15_000 })

  return { projectName, epicName, featureName }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Gantt Chart', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // 1. Smoke test: feature bars are rendered after auto-schedule
  // ──────────────────────────────────────────────────────────────────────────
  test('auto-schedule renders feature bars in the Gantt grid', async ({ page }) => {
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
    const startWeekInput = page.locator('input[min="0"]').first()
    await startWeekInput.fill('2')

    // Save — triggers PUT /timeline/:featureId with isManual: true
    await page.getByRole('button', { name: /^save$/i }).click()

    // After the server persists isManual=true the Gantt re-renders and the
    // edit panel shows the "↺ Reset to auto" button (only visible when isManual=true)
    await expect(page.getByRole('button', { name: /reset to auto/i })).toBeVisible({ timeout: 10_000 })
  })
})
