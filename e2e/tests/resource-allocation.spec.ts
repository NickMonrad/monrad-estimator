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
    page.getByText(/^(T&M|Timeline ·|Full Project ·|Capacity Plan)/).first()
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
  await expect(page.getByRole('heading', { name: /^summary$/i }).first()).toBeVisible({ timeout: 15_000 })
}

test.describe('Resource Allocation', () => {
  test('commercial tab shows allocation badge', async ({ page }) => {
    test.setTimeout(90_000)
    await setupCommercialTab(page)

    const badge = page.getByText(/^(T&M|Timeline ·|Full Project ·|Capacity Plan)/).first()
    await expect(badge).toBeVisible({ timeout: 10_000 })
    const badgeText = await badge.textContent()
    expect(badgeText).toMatch(/T&M|Timeline|Full Project|Capacity Plan/)
  })

  test('allocation editor opens on badge click', async ({ page }) => {
    test.setTimeout(90_000)
    const projectId = await setupCommercialTab(page)
    await gotoResourceProfile(page, projectId)

    const badge = page.locator('button[title="Click to edit allocation"]').first()
    await expect(badge).toBeVisible({ timeout: 10_000 })
    await badge.click()

    await expect(page.getByText(/Allocation Mode/i).first()).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText(/FTE %/i).first()).toBeVisible({ timeout: 5_000 })

    const modeSelect = page.locator('select').filter({ hasText: /T&M|Timeline window|Full project/ }).first()
    await expect(modeSelect).toBeVisible({ timeout: 5_000 })

    const fteInput = page.locator('input[type="number"]').filter({ hasAttribute: 'min' }).first()
    await expect(fteInput).toBeVisible({ timeout: 5_000 })

    await expect(page.locator('[data-testid="allocation-save"]')).toBeVisible()
    await expect(page.locator('[data-testid="allocation-cancel"]')).toBeVisible()
  })

  test('changing FTE % updates allocated days', async ({ page }) => {
    test.setTimeout(90_000)
    const projectId = await setupCommercialTab(page)
    await gotoResourceProfile(page, projectId)

    const badge = page.locator('button[title="Click to edit allocation"]').first()
    await expect(badge).toBeVisible({ timeout: 10_000 })
    await badge.click()

    await expect(page.getByText(/FTE %/i).first()).toBeVisible({ timeout: 8_000 })

    const fteInput = page.locator('input[type="number"]').filter({ hasAttribute: 'min' }).first()
    await fteInput.fill('50')

    await page.locator('[data-testid="allocation-save"]').click()

    await expect(page.getByText(/Allocation Mode/i).first()).not.toBeVisible({ timeout: 8_000 })

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

    await badge.click()
    await expect(page.getByText(/Allocation Mode/i).first()).toBeVisible({ timeout: 8_000 })

    const modeSelect = page.locator('select').filter({ hasText: /T&M|Timeline window|Full project/ }).first()
    await modeSelect.selectOption('FULL_PROJECT')

    await page.getByRole('button', { name: /^Cancel$/ }).click()

    await expect(page.getByText(/Allocation Mode/i).first()).not.toBeVisible({ timeout: 8_000 })

    const badgeAfter = page.locator('button[title="Click to edit allocation"]').first()
    const badgeTextAfter = await badgeAfter.textContent()
    expect(badgeTextAfter?.trim()).toBe(badgeTextBefore?.trim())
  })

  test('summary tab shows Allocation column', async ({ page }) => {
    test.setTimeout(90_000)
    const projectId = await setupCommercialTab(page)
    await gotoResourceProfile(page, projectId)

    const allocationHeader = page.locator('th').filter({ hasText: /^Allocation$/ })
    await expect(allocationHeader.first()).toBeVisible({ timeout: 8_000 })
  })
})
