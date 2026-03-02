import { test, expect } from '@playwright/test'
import { login, createProject } from './helpers'
import path from 'path'
import fs from 'fs'
import os from 'os'

const PROJECT_NAME = `E2E Backlog ${Date.now()}`

test.describe('Backlog', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
    await createProject(page, PROJECT_NAME)
    await page.getByRole('heading', { name: PROJECT_NAME, exact: true }).first().click()
    // Wait for the project detail hub to fully render
    await page.getByRole('button', { name: /backlog/i }).waitFor()
  })

  test('backlog page loads with Add epic button', async ({ page }) => {
    await page.getByRole('button', { name: /backlog/i }).click()
    await expect(page.getByRole('button', { name: /add epic/i })).toBeVisible()
  })

  test('can add an epic', async ({ page }) => {
    await page.getByRole('button', { name: /backlog/i }).click()
    await page.getByRole('button', { name: /add epic/i }).click()
    await page.getByPlaceholder(/epic name/i).fill('E2E Epic')
    await page.getByRole('button', { name: /save epic/i }).click()
    await expect(page.getByText('E2E Epic')).toBeVisible()
  })

  test('CSV import button is visible', async ({ page }) => {
    await page.getByRole('button', { name: /backlog/i }).click()
    await expect(page.getByRole('button', { name: /import csv/i })).toBeVisible()
  })

  test('CSV export button is visible', async ({ page }) => {
    await page.getByRole('button', { name: /backlog/i }).click()
    await expect(page.getByRole('button', { name: /export csv/i })).toBeVisible()
  })

  test('CSV import modal opens and shows template download link', async ({ page }) => {
    await page.getByRole('button', { name: /backlog/i }).click()
    await page.getByRole('button', { name: /import csv/i }).click()
    await expect(page.getByText(/download blank csv template/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /choose csv file/i })).toBeVisible()
  })

  test('CSV import shows parse errors on bad file', async ({ page }) => {
    await page.getByRole('button', { name: /backlog/i }).click()
    await page.getByRole('button', { name: /import csv/i }).click()

    // Write a badly formatted CSV to a temp file
    const csv = 'this is not, a valid, csv with the wrong headers\nbad,data'
    const tmpFile = path.join(os.tmpdir(), 'bad-import.csv')
    fs.writeFileSync(tmpFile, csv)

    const fileInput = page.locator('input[type="file"]')
    await fileInput.setInputFiles(tmpFile)

    // Should show either a parse error or validation errors in staging
    await expect(
      page.getByText(/error|invalid|required/i).first()
    ).toBeVisible({ timeout: 8_000 })

    fs.unlinkSync(tmpFile)
  })

  test('durationDays is auto-calculated from hoursEffort on CSV import', async ({ page }) => {
    await page.getByRole('button', { name: /backlog/i }).click()

    // CSV with HoursEffort=8 and blank DurationDays
    const headers = 'Epic,Feature,Story,Task,ResourceType,HoursExtraSmall,HoursSmall,HoursMedium,HoursLarge,HoursExtraLarge,HoursEffort,DurationDays,Description,Assumptions'
    const dataRow = 'E2E DurationEpic,E2E DurationFeature,E2E DurationStory,E2E DurationTask,Developer,0,0,0,0,0,8,,Task desc,'
    const csv = [headers, dataRow].join('\n')
    const tmpFile = path.join(os.tmpdir(), 'duration-import.csv')
    fs.writeFileSync(tmpFile, csv)

    await page.getByRole('button', { name: /import csv/i }).click()
    const fileInput = page.locator('input[type="file"]')
    await fileInput.setInputFiles(tmpFile)
    fs.unlinkSync(tmpFile)

    // Step through the two-step modal: staging → confirm → import
    await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
    await expect(page.getByText('E2E DurationEpic')).toBeVisible({ timeout: 10_000 })

    // Export and verify DurationDays is populated
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /export csv/i }).click()
    const download = await downloadPromise
    const exportPath = await download.path()
    const content = fs.readFileSync(exportPath!, 'utf-8')
    const lines = content.trim().split('\n')
    const headerCols = lines[0].split(',')
    const durationIdx = headerCols.indexOf('DurationDays')
    const taskLine = lines.find(l => l.includes('E2E DurationTask'))!
    const durationValue = parseFloat(taskLine.split(',')[durationIdx])

    // hoursEffort=8 / hoursPerDay=7.6 → durationDays ≈ 1.05
    expect(durationValue).toBeGreaterThan(0)
  })

  test('durationDays is populated when applying a template', async ({ page }) => {
    // Create a template with a task that has medium hours = 8
    await page.goto('/templates')
    await page.getByRole('button', { name: /new template/i }).click()
    await page.getByPlaceholder(/template name/i).fill('E2E Duration Template')
    await page.getByRole('button', { name: /save/i }).click()
    await page.getByText('E2E Duration Template').first().click()
    await page.getByRole('button', { name: /add task/i }).click()
    await page.getByPlaceholder(/task name/i).fill('E2E Duration Task')
    // Resource type is a select when global types exist, otherwise a text input
    const rtSelect = page.locator('select').filter({ has: page.locator('option[value=""]') }).first()
    const rtInput = page.getByPlaceholder(/resource type name/i)
    if (await rtSelect.isVisible()) {
      await rtSelect.selectOption({ index: 1 })
    } else {
      await rtInput.fill('Developer')
    }

    // Hours inputs are unlabelled number fields; M (medium) is index 2 in the grid
    const hoursInputs = page.locator('input[type="number"]')
    await hoursInputs.nth(2).fill('8')
    await page.getByRole('button', { name: /save task/i }).click()
    await expect(page.getByText('E2E Duration Task')).toBeVisible({ timeout: 8_000 })

    // Navigate to project backlog and apply the template
    await page.goto('/')
    await page.getByRole('heading', { name: PROJECT_NAME, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).click()

    // Create an epic and feature to apply the template to
    await page.getByRole('button', { name: /add epic/i }).click()
    await page.getByPlaceholder(/epic name/i).fill('E2E Duration Epic')
    await page.getByRole('button', { name: /save epic/i }).click()
    await expect(page.getByText('E2E Duration Epic')).toBeVisible()
    // Epic auto-expands after creation — Add feature button is immediately available
    await expect(page.getByText('+ Add feature')).toBeVisible({ timeout: 5_000 })
    await page.getByText('+ Add feature').click()
    await page.getByPlaceholder('Feature name *').fill('E2E Duration Feature')
    await page.getByRole('button', { name: /^save$/i }).click()
    // Wait for feature to appear before clicking + Template
    await expect(page.getByText('E2E Duration Feature')).toBeVisible({ timeout: 8_000 })

    // Apply the template — use button text selector and wait for the select to be ready
    await page.locator('button', { hasText: '+ Template' }).first().click()
    // Modal contains a select for template choice — wait for it
    const templateSelect = page.locator('select').last()
    await expect(templateSelect).toBeVisible({ timeout: 8_000 })
    await templateSelect.selectOption({ label: 'E2E Duration Template' })
    await page.getByRole('button', { name: 'M', exact: true }).click()
    await page.getByRole('button', { name: 'Apply template', exact: true }).click()
    await expect(page.getByText(/E2E Duration Template/)).toBeVisible({ timeout: 10_000 })

    // Export and verify DurationDays is populated for the template task
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /export csv/i }).click()
    const download = await downloadPromise
    const exportPath = await download.path()
    const content = fs.readFileSync(exportPath!, 'utf-8')
    const lines = content.trim().split('\n')
    const headerCols = lines[0].split(',')
    const durationIdx = headerCols.indexOf('DurationDays')
    const taskLine = lines.find(l => l.includes('E2E Duration Task'))!
    expect(taskLine).toBeTruthy()
    const durationValue = parseFloat(taskLine.split(',')[durationIdx])
    // hoursEffort=8 / hoursPerDay=7.6 → durationDays > 0
    expect(durationValue).toBeGreaterThan(0)
  })

  test('History button toggles history panel', async ({ page }) => {
    await page.getByRole('button', { name: /backlog/i }).click()
    await page.getByRole('button', { name: /history/i }).click()
    await expect(page.getByText(/backlog history/i)).toBeVisible()
  })

  test('drag handle is visible on epics for reordering', async ({ page }) => {
    await page.getByRole('button', { name: /backlog/i }).click()

    // Create two epics
    await page.getByRole('button', { name: /add epic/i }).click()
    await page.getByPlaceholder(/epic name/i).fill('E2E Epic Alpha')
    await page.getByRole('button', { name: /save epic/i }).click()

    await page.getByRole('button', { name: /add epic/i }).click()
    await page.getByPlaceholder(/epic name/i).fill('E2E Epic Beta')
    await page.getByRole('button', { name: /save epic/i }).click()

    // Drag handles (⠿) should be visible on hover
    const epicRows = page.locator('.group').filter({ hasText: /E2E Epic Alpha/ })
    await epicRows.first().hover()
    await expect(epicRows.first().locator('text=⠿')).toBeVisible()
  })
})
