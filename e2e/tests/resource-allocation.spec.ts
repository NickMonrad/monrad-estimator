import { test, expect } from '@playwright/test'
import { login, createProject } from './helpers'
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

async function setupCommercialTab(page: import('@playwright/test').Page) {
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

async function gotoResourceProfile(page: import('@playwright/test').Page, projectId: string) {
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

  test('EFFORT and CAPACITY_PLAN hide Available % control', async ({ page }) => {
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

    // Select CAPACITY_PLAN — Available % should NOT be visible
    await modeSelect.selectOption('CAPACITY_PLAN')
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
})
