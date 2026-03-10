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
  'Task,Alpha Epic,Alpha Feature,Alpha Story,Alpha Task,,Tech Lead,8,1,,,,,',
  'Epic,Beta Epic,,,,,,,,,,active,,',
  'Feature,Beta Epic,Beta Feature,,,,,,,,,,,',
  'Story,Beta Epic,Beta Feature,Beta Story,,,,,,,,,,active',
  'Task,Beta Epic,Beta Feature,Beta Story,Beta Task,,Tech Lead,4,0.5,,,,,',
].join('\n')

/**
 * Navigate to the backlog, import the seeding CSV, and then navigate to
 * the Effort Review page for the current project.
 */
async function seedAndNavigateToEffort(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /backlog/i }).click()

  // Open import modal and upload the CSV
  await page.getByRole('button', { name: /import csv/i }).click()
  const tmpFile = path.join(os.tmpdir(), `effort-review-seed-${Date.now()}.csv`)
  fs.writeFileSync(tmpFile, CSV_CONTENT)
  await page.locator('input[type="file"]').setInputFiles(tmpFile)
  fs.unlinkSync(tmpFile)

  // Two-step staging flow
  await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })

  // Wait for backlog to reflect the imported data
  await expect(page.getByText('Alpha Epic')).toBeVisible({ timeout: 10_000 })

  // Extract the project ID from the current URL and navigate to effort page
  const url = page.url()
  const projectId = url.match(/\/projects\/([^/]+)/)?.[1]
  await page.goto(`/projects/${projectId}/effort`)
  await expect(page.getByRole('heading', { name: /effort review/i })).toBeVisible({ timeout: 10_000 })
}

test.describe('Effort Review', () => {
  let projectName: string

  test.beforeEach(async ({ page }) => {
    // CSV import + navigation takes ~15-20s; give each test 60s total
    test.setTimeout(60_000)
    projectName = `E2E Effort Review ${Date.now()}`
    await login(page)
    await createProject(page, projectName)
    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor()
    await seedAndNavigateToEffort(page)
  })

  test('effort review page loads with summary and detail tabs', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /effort review/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /^summary$/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /^detail$/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /active scope/i })).toBeVisible()
  })

  test('active-scope toggle switches label', async ({ page }) => {
    // Default state: "Active scope" (green / active)
    const toggle = page.getByRole('button', { name: /active scope/i })
    await expect(toggle).toBeVisible()

    // First click → "All tasks"
    await toggle.click()
    await expect(page.getByRole('button', { name: /all tasks/i })).toBeVisible()

    // Second click → back to "Active scope"
    await page.getByRole('button', { name: /all tasks/i }).click()
    await expect(page.getByRole('button', { name: /active scope/i })).toBeVisible()
  })

  test('summary view shows resource type rows', async ({ page }) => {
    // Summary is the default view — "Tech Lead" should be visible in the table
    await expect(page.getByText('Tech Lead').first()).toBeVisible({ timeout: 10_000 })
  })

  test('clicking a resource type row in summary expands epic sub-rows', async ({ page }) => {
    // Find and click the "Tech Lead" row in the summary table
    const techLeadRow = page.locator('tr').filter({ hasText: 'Tech Lead' }).first()
    await expect(techLeadRow).toBeVisible({ timeout: 15_000 })
    await techLeadRow.click()

    // After expanding, epic sub-rows appear as italic cells
    await expect(
      page.locator('td.italic, td[class*="italic"]').filter({ hasText: /Alpha Epic|Beta Epic/ }).first()
    ).toBeVisible({ timeout: 8_000 })
  })

  test('detail view filter bar renders correctly', async ({ page }) => {
    await page.getByRole('button', { name: /^detail$/i }).click()

    // Filter selects should be present — "All Epics" is the first option in the epic select
    await expect(page.locator('select').first()).toBeVisible({ timeout: 8_000 })

    // "Showing X of Y tasks" text
    await expect(page.getByText(/showing/i).first()).toBeVisible()
  })

  test('detail view epic filter cascades to feature dropdown', async ({ page }) => {
    await page.getByRole('button', { name: /^detail$/i }).click()

    // Wait for filter bar to appear
    await page.locator('select').first().waitFor({ timeout: 8_000 })

    // Select "Alpha Epic" in the epic dropdown (first select)
    const epicSelect = page.locator('select').first()
    await epicSelect.selectOption('Alpha Epic')

    // Feature dropdown (second select) should now only contain Alpha Feature (not Beta Feature)
    const featureSelect = page.locator('select').nth(1)
    await expect(featureSelect.locator('option', { hasText: 'Alpha Feature' })).toBeAttached()
    await expect(featureSelect.locator('option', { hasText: 'Beta Feature' })).not.toBeAttached()
  })

  test('detail view task name filter works', async ({ page }) => {
    await page.getByRole('button', { name: /^detail$/i }).click()

    // Wait for the task name input
    const taskInput = page.getByPlaceholder('Task name…')
    await taskInput.waitFor({ timeout: 8_000 })

    // Type "Alpha" to filter
    await taskInput.fill('Alpha')

    // "Beta Task" should no longer be visible in the table rows
    await expect(page.getByRole('cell', { name: 'Beta Task' })).not.toBeVisible()

    // The "Showing X of Y tasks" counter should reflect the filtered count
    await expect(page.getByText(/showing 1 of 2 tasks/i)).toBeVisible()
  })
})
