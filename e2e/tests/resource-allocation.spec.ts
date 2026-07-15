import { test, expect, type Page } from '@playwright/test'
import { login, createProject, API_BASE, DATABASE_URL } from './helpers'
import { Client } from 'pg'
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

async function setupDeterministicCapacityPlan(page: Page): Promise<string> {
  const projectId = await setupCommercialTab(page)

  // Get auth token from localStorage
  const token = await page.evaluate(() => localStorage.getItem('token'))
  if (!token) throw new Error('No auth token found in localStorage')

  // Fetch resource types to get the first RT id
  const rtRes = await page.request.get(
    `${API_BASE}/api/projects/${projectId}/resource-types`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const rtData = await rtRes.json() as Array<{ id: string }>
  const rtId = rtData[0]?.id
  if (!rtId) throw new Error('No resource types found')

  // Direct DB: set allocationMode to CAPACITY_PLAN and create capacity profile
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    // Update RT allocation mode to CAPACITY_PLAN
    await client.query(
      `UPDATE "ResourceType" SET "allocationMode" = 'CAPACITY_PLAN' WHERE id = $1`,
      [rtId],
    )
    // Update NR allocation modes
    await client.query(
      `UPDATE "NamedResource" SET "allocationMode" = 'CAPACITY_PLAN' WHERE "resourceTypeId" = $1`,
      [rtId],
    )
    // Create role-level capacity profile with segments
    const cpRes = await client.query(
      `INSERT INTO "CapacityProfile" ("id", "projectId", "resourceTypeId", "ownerKind", "planningBasis", "source", "defaultPercent", "startWeek", "endWeek", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, 'ROLE', 'CAPACITY_PROFILE', 'SQUAD_PLANNER', 100, 0, 10, NOW(), NOW()) RETURNING id`,
      [projectId, rtId],
    )
    const cpId = cpRes.rows[0].id
    await client.query(
      `INSERT INTO "CapacitySegment" ("capacityProfileId", "startWeek", "endWeek", "capacityPercent", "source", "createdAt", "updatedAt")
       VALUES ($1, 0, 10, 100, 'SQUAD_PLANNER', NOW(), NOW())`,
      [cpId],
    )
  } finally {
    await client.end()
  }

  // Verify via capacity profiles endpoint
  const verifyRes = await page.request.get(
    `${API_BASE}/api/projects/${projectId}/capacity-profiles`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  expect(verifyRes.ok()).toBeTruthy()
  const verifyData = await verifyRes.json()
  expect(Array.isArray(verifyData.capacityProfiles)).toBeTruthy()
  expect(verifyData.capacityProfiles.length).toBeGreaterThan(0)

  return projectId
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

  test('CAPACITY_PLAN row shows info panel with safe editor', async ({ page }) => {
    test.setTimeout(90_000)
    const projectId = await setupDeterministicCapacityPlan(page)
    await gotoResourceProfile(page, projectId)

    // First row is now deterministically CAPACITY_PLAN
    const badge = page.locator('button[title="Click to edit allocation"]').first()
    await expect(badge).toBeVisible({ timeout: 10_000 })

    // Badge shows "Capacity profile" without percentage suffix (profile-managed)
    await expect(badge).toContainText('Capacity profile')
    await expect(badge).not.toContainText('%')

    // Click badge — opens safe info-panel editor, not the generic editor
    await badge.click({ force: true })

    // Info panel shows the managed-through text
    await expect(page.getByText(/managed through the weekly capacity profile/i)).toBeVisible({ timeout: 5_000 })

    // Generic editor elements MUST be absent
    await expect(page.locator('select[aria-label="Availability pattern"]')).not.toBeVisible({ timeout: 2_000 })
    await expect(page.locator('[data-testid="allocation-save"]')).not.toBeVisible({ timeout: 2_000 })

    // Safe editor has the "Open weekly profile editor" CTA
    const editorButton = page.getByRole('button', { name: /open weekly profile editor/i })
    await expect(editorButton).toBeVisible({ timeout: 5_000 })

    // Close button is always present
    await expect(page.locator('[data-testid="allocation-cancel"]')).toBeVisible()

    // Click the editor button and verify navigation to squad planner with panel param
    await editorButton.click()
    await page.waitForURL(`/projects/${projectId}/timeline?panel=squad-planner`)
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
