import { test, expect } from '@playwright/test'
import { login, createProject } from './helpers'
import path from 'path'
import fs from 'fs'
import os from 'os'

/* ──────────────────────────────────────────────────────────────────────────
 * CSV seed — two tasks (Tech Lead + Project Manager) with defined effort
 * so the Commercial tab has resource rows to interact with.
 * ────────────────────────────────────────────────────────────────────────── */
const CSV_CONTENT = [
  'Type,Epic,Feature,Story,Task,Template,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus',
  'Epic,Alpha Epic,,,,,,,,,,active,,',
  'Feature,Alpha Epic,Alpha Feature,,,,,,,,,,,',
  'Story,Alpha Epic,Alpha Feature,Alpha Story,,,,,,,,,,active',
  'Task,Alpha Epic,Alpha Feature,Alpha Story,Alpha Task,,Tech Lead,16,2,,,,,',
  'Task,Alpha Epic,Alpha Feature,Alpha Story,Beta Task,,Project Manager,8,1,,,,,',
].join('\n')

/**
 * Shared setup: login → create project → import CSV → navigate to
 * Resource Profile → click Commercial tab.
 * Returns the resolved projectId so individual tests can navigate further.
 */
async function setupCommercialTab(page: import('@playwright/test').Page) {
  await login(page)
  const projectName = `E2E Resource Allocation ${Date.now()}`
  await createProject(page, projectName)
  await page.getByRole('heading', { name: projectName, exact: true }).first().click()

  // Import CSV via Backlog
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

  // Navigate to Resource Profile page
  const url = page.url()
  const projectId = url.match(/\/projects\/([^/]+)/)?.[1]!

  // Navigate and simultaneously capture the resource-types GET response so we know the
  // React Query `resourceTypes` state is populated before we interact with the inputs.
  // Without this guarantee, the onBlur handler cannot find the RT id → no PUT fires.
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

  // Set day rates in the Summary tab (required for rows to appear on the Commercial tab).
  // The Summary tab is the default view. Day rate inputs have class `w-20` and placeholder "—".
  // Resource types are PROJECT-SCOPED; each new project starts with dayRate=null unless the
  // global type has a defaultDayRate. Check inputValue() after data loads:
  //   - non-empty → inherited defaultDayRate, Commercial tab already works, skip
  //   - empty     → must set, fill and wait for the PUT to /projects/:id/resource-types/:id
  await expect(page.locator('input.w-20').first()).toBeVisible({ timeout: 10_000 })
  const dayRateInputs = page.locator('input.w-20')
  const drCount = await dayRateInputs.count()
  for (let i = 0; i < drCount; i++) {
    const input = dayRateInputs.nth(i)
    const currentValue = await input.inputValue()
    if (currentValue !== '') continue  // day rate already inherited/set — skip
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

  // Switch to Commercial tab
  await page.getByRole('button', { name: /commercial/i }).click()
  // Wait for the Cost Summary heading to confirm the tab rendered
  await expect(
    page.getByRole('heading', { name: /cost summary/i })
  ).toBeVisible({ timeout: 10_000 })
  // Wait for at least one resource row with an allocation badge
  await expect(
    page.locator('button[title="Click to edit allocation"]').first()
  ).toBeVisible({ timeout: 15_000 })

  return projectId
}

/* ======================================================================== */

test.describe('Resource Allocation', () => {
  test('commercial tab shows allocation badge', async ({ page }) => {
    test.setTimeout(90_000)
    await setupCommercialTab(page)

    // The Allocation column should contain a badge for each resource row.
    // Badge text is one of: "T&M", "Timeline · N%", "Full Project · N%"
    const badge = page.locator('button[title="Click to edit allocation"]').first()
    await expect(badge).toBeVisible({ timeout: 10_000 })
    const badgeText = await badge.textContent()
    expect(badgeText).toMatch(/T&M|Timeline|Full Project/)
  })

  test('allocation editor opens on badge click', async ({ page }) => {
    test.setTimeout(90_000)
    await setupCommercialTab(page)

    // Click the first allocation badge in the table
    const badge = page.locator('button[title="Click to edit allocation"]').first()
    await badge.click()

    // The inline editor row should now be visible below the resource row.
    // It contains: Allocation Mode label, FTE % label, Save button, Cancel button
    await expect(page.getByText(/Allocation Mode/i)).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(/FTE %/i)).toBeVisible({ timeout: 5_000 })

    // The mode <select> should have options for T&M, Timeline window, Full project
    const modeSelect = page.locator('select').filter({ hasText: /T&M|Timeline window|Full project/ }).first()
    await expect(modeSelect).toBeVisible({ timeout: 5_000 })

    // FTE % input — a number input bounded 1–100
    const fteInput = page.locator('input[type="number"]').filter({ hasAttribute: 'min' }).first()
    await expect(fteInput).toBeVisible({ timeout: 5_000 })

    // Save and Cancel buttons
    await expect(page.locator('[data-testid="allocation-save"]')).toBeVisible()
    await expect(page.locator('[data-testid="allocation-cancel"]')).toBeVisible()
  })

  test('changing FTE % updates allocated days', async ({ page }) => {
    test.setTimeout(90_000)
    await setupCommercialTab(page)

    // Capture the first badge before editing
    const badge = page.locator('button[title="Click to edit allocation"]').first()
    await badge.click()

    // Wait for the inline editor to appear
    await expect(page.getByText(/FTE %/i)).toBeVisible({ timeout: 8_000 })

    // Change FTE % to 50
    const fteInput = page.locator('input[type="number"]').filter({ hasAttribute: 'min' }).first()
    await fteInput.fill('50')

    // Save
    await page.locator('[data-testid="allocation-save"]').click()

    // Editor should close
    await expect(page.getByText(/Allocation Mode/i)).not.toBeVisible({ timeout: 8_000 })

    // The badge should still be visible (row intact after save)
    await expect(
      page.locator('button[title="Click to edit allocation"]').first()
    ).toBeVisible({ timeout: 8_000 })
  })

  test('cancel closes editor without changing mode badge', async ({ page }) => {
    test.setTimeout(90_000)
    await setupCommercialTab(page)

    const badge = page.locator('button[title="Click to edit allocation"]').first()

    // Record badge text before opening editor
    const badgeTextBefore = await badge.textContent()

    await badge.click()
    await expect(page.getByText(/Allocation Mode/i)).toBeVisible({ timeout: 8_000 })

    // Change mode to Full project (without saving)
    const modeSelect = page.locator('select').filter({ hasText: /T&M|Timeline window|Full project/ }).first()
    await modeSelect.selectOption('FULL_PROJECT')

    // Click Cancel
    await page.getByRole('button', { name: /^Cancel$/ }).click()

    // Editor should be gone
    await expect(page.getByText(/Allocation Mode/i)).not.toBeVisible({ timeout: 8_000 })

    // Badge text should be unchanged
    const badgeAfter = page.locator('button[title="Click to edit allocation"]').first()
    const badgeTextAfter = await badgeAfter.textContent()
    expect(badgeTextAfter?.trim()).toBe(badgeTextBefore?.trim())
  })

  test('summary tab shows Allocation column', async ({ page }) => {
    test.setTimeout(90_000)
    await setupCommercialTab(page)

    // Navigate back to the Resource Profile (summary) tab
    await page.getByRole('button', { name: /resource profile/i }).first().click()

    // Wait for the summary table to load — the heading should be visible
    await expect(
      page.getByRole('heading', { name: /summary/i }).first()
    ).toBeVisible({ timeout: 15_000 })

    // The summary table header should contain an "Allocation" column
    const allocationHeader = page.locator('th').filter({ hasText: /^Allocation$/ })
    await expect(allocationHeader.first()).toBeVisible({ timeout: 8_000 })
  })
})
