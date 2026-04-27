import { test, expect } from '@playwright/test'
import { login, createProject, deleteTemplatesByName } from './helpers'
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
    const DURATION_TEMPLATE_NAME = `E2E Duration Template ${Date.now()}`
    const DURATION_TASK_NAME = `E2E Duration Task ${Date.now()}`
    // Create a template with a task that has medium hours = 8
    await page.goto('/templates')
    await page.getByRole('button', { name: /new template/i }).click()
    await page.getByPlaceholder(/template name/i).fill(DURATION_TEMPLATE_NAME)
    await page.getByRole('button', { name: /save/i }).click()
    await page.getByText(DURATION_TEMPLATE_NAME).first().click()
    await page.getByRole('button', { name: /add task/i }).click()
    await page.getByPlaceholder(/task name/i).fill(DURATION_TASK_NAME)
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
    await expect(page.getByText(DURATION_TASK_NAME).first()).toBeVisible({ timeout: 8_000 })

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
    await templateSelect.selectOption({ label: DURATION_TEMPLATE_NAME })
    await page.getByRole('button', { name: 'M', exact: true }).click()
    await page.getByPlaceholder('Enter story name…').fill('E2E Duration Story')
    await page.getByRole('button', { name: 'Apply template', exact: true }).click()
    await expect(page.getByText('E2E Duration Story')).toBeVisible({ timeout: 10_000 })

    // Export and verify DurationDays is populated for the template task
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /export csv/i }).click()
    const download = await downloadPromise
    const exportPath = await download.path()
    const content = fs.readFileSync(exportPath!, 'utf-8')
    const lines = content.trim().split('\n')
    const headerCols = lines[0].split(',')
    const durationIdx = headerCols.indexOf('DurationDays')
    const taskLine = lines.find(l => l.includes(DURATION_TASK_NAME))!
    expect(taskLine).toBeTruthy()
    const durationValue = parseFloat(taskLine.split(',')[durationIdx])
    // hoursEffort=8 / hoursPerDay=7.6 → durationDays > 0
    expect(durationValue).toBeGreaterThan(0)
  })

  test('refresh from template updates task duration days (bug #47)', async ({ page }) => {
    // Unique names so this test is fully isolated from the other template tests
    const TEMPLATE_NAME = `E2E Refresh Template ${Date.now()}`
    const TASK_NAME = 'E2E Refresh Task'

    // ── Step 1: Create a template with a task at MEDIUM hours = 8 ──────────
    await page.goto('/templates')
    await page.getByRole('button', { name: /new template/i }).click()
    await page.getByPlaceholder(/template name/i).fill(TEMPLATE_NAME)
    await page.getByRole('button', { name: /save/i }).click()
    await page.getByText(TEMPLATE_NAME).first().click()
    await page.getByRole('button', { name: /add task/i }).click()
    await page.getByPlaceholder(/task name/i).fill(TASK_NAME)

    // Resource type: prefer a select if one is present, otherwise fall back to text input
    const rtSelect = page.locator('select').filter({ has: page.locator('option[value=""]') }).first()
    const rtInput = page.getByPlaceholder(/resource type name/i)
    if (await rtSelect.isVisible()) {
      await rtSelect.selectOption({ index: 1 })
    } else {
      await rtInput.fill('Developer')
    }

    // Hours inputs are unlabelled number fields; MEDIUM (M) is index 2 in the XS/S/M/L/XL grid
    const hoursInputs = page.locator('input[type="number"]')
    await hoursInputs.nth(2).fill('8')
    await page.getByRole('button', { name: /save task/i }).click()
    await expect(page.getByText(TASK_NAME)).toBeVisible({ timeout: 8_000 })

    // ── Step 2: Apply the template to the project backlog ──────────────────
    // beforeEach has already created PROJECT_NAME and landed us on its hub
    await page.goto('/')
    await page.getByRole('heading', { name: PROJECT_NAME, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /backlog/i }).click()

    // Store the backlog URL so we can return without re-finding the project
    const backlogUrl = page.url()

    // Create epic
    await page.getByRole('button', { name: /add epic/i }).click()
    await page.getByPlaceholder(/epic name/i).fill('E2E Refresh Epic')
    await page.getByRole('button', { name: /save epic/i }).click()
    await expect(page.getByText('E2E Refresh Epic')).toBeVisible()

    // Epic auto-expands after creation — Add feature button is immediately available
    await expect(page.getByText('+ Add feature')).toBeVisible({ timeout: 5_000 })
    await page.getByText('+ Add feature').click()
    await page.getByPlaceholder('Feature name *').fill('E2E Refresh Feature')
    await page.getByRole('button', { name: /^save$/i }).click()
    await expect(page.getByText('E2E Refresh Feature')).toBeVisible({ timeout: 8_000 })

    // Apply the template at M complexity
    await page.locator('button', { hasText: '+ Template' }).first().click()
    const templateSelect = page.locator('select').last()
    await expect(templateSelect).toBeVisible({ timeout: 8_000 })
    await templateSelect.selectOption({ label: TEMPLATE_NAME })
    await page.getByRole('button', { name: 'M', exact: true }).click()
    await page.getByPlaceholder('Enter story name…').fill('E2E Refresh Story')
    await page.getByRole('button', { name: 'Apply template', exact: true }).click()
    await expect(page.getByText('E2E Refresh Story')).toBeVisible({ timeout: 10_000 })

    // ── Step 3: Export CSV and record the initial DurationDays ─────────────
    let downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /export csv/i }).click()
    let download = await downloadPromise
    let exportPath = await download.path()
    let content = fs.readFileSync(exportPath!, 'utf-8')
    let lines = content.trim().split('\n')
    let headerCols = lines[0].split(',')
    let durationIdx = headerCols.indexOf('DurationDays')
    let taskLine = lines.find(l => l.includes(TASK_NAME))!
    expect(taskLine).toBeTruthy()
    const originalDuration = parseFloat(taskLine.split(',')[durationIdx])
    // hoursEffort=8 / hoursPerDay=7.6 → durationDays ≈ 1.05
    expect(originalDuration).toBeGreaterThan(0)

    // ── Step 4: Update the template task's MEDIUM hours from 8 → 16 ────────
    await page.goto('/templates')
    // Templates use accordion — click the template row to expand it and reveal tasks
    await page.getByText(TEMPLATE_NAME).first().click()
    // Wait for the task table to appear
    await expect(page.locator('tr').filter({ hasText: TASK_NAME })).toBeVisible({ timeout: 8_000 })

    // Use XPath to find the Edit button in the SAME <tr> as the task name cell,
    // avoiding any template-name Edit button (which lives outside a <tr>)
    await page
      .getByText(TASK_NAME, { exact: true })
      .first()
      .locator('xpath=ancestor::tr//button[normalize-space(text())="Edit"]')
      .click()

    // Scope number inputs to the editing row (the one containing "Save task")
    // to avoid any number inputs elsewhere on the page.
    const editingRow = page.locator('tr').filter({ has: page.getByRole('button', { name: /save task/i }) })
    await expect(editingRow).toBeVisible({ timeout: 8_000 })
    // Hours inputs within the editing row: XS(0) / S(1) / M(2) / L(3) / XL(4)
    await editingRow.locator('input[type="number"]').nth(2).fill('16')

    // Wait for the task update PUT to succeed before navigating away
    const taskUpdatePromise = page.waitForResponse(
      resp => resp.url().includes('/tasks/') && resp.request().method() === 'PUT',
      { timeout: 8_000 }
    )
    await page.getByRole('button', { name: /save task/i }).click()
    const taskUpdateResp = await taskUpdatePromise
    expect(taskUpdateResp.status()).toBe(200)

    // After save the editing row closes; wait for the task row to reappear
    // with the new hours visible in the M column to confirm the update committed.
    await expect(page.locator('tr').filter({ hasText: TASK_NAME })).toBeVisible({ timeout: 8_000 })
    await expect(
      page.locator('tr').filter({ hasText: TASK_NAME }).getByText('16')
    ).toBeVisible({ timeout: 8_000 })

    // ── Step 5: Return to the backlog and expand epic + feature ────────────
    await page.goto(backlogUrl)
    await expect(page.getByRole('button', { name: /export csv/i })).toBeVisible({ timeout: 8_000 })

    // Epics start collapsed on fresh load — click to expand
    await page.getByText('E2E Refresh Epic').first().click()
    // Features also start collapsed — click to expand
    await expect(page.getByText('E2E Refresh Feature')).toBeVisible({ timeout: 5_000 })
    await page.getByText('E2E Refresh Feature').first().click()

    // ── Step 6: Click the ↺ Refresh button on the story ───────────────────
    const refreshButton = page.getByTitle('Refresh tasks from template')
    await expect(refreshButton).toBeVisible({ timeout: 8_000 })
    await refreshButton.click()

    // ── Step 7: Select M (MEDIUM) complexity ──────────────────────────────
    await expect(page.getByText(/refresh complexity/i)).toBeVisible({ timeout: 5_000 })
    // The button labels are XS / S / M / L / XL
    await page.getByRole('button', { name: 'M', exact: true }).click()

    // ── Step 8: Assert success message contains "Updated" ─────────────────
    await expect(page.getByText(/updated/i)).toBeVisible({ timeout: 8_000 })

    // ── Step 9: Export CSV again and verify DurationDays has increased ─────
    downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /export csv/i }).click()
    download = await downloadPromise
    exportPath = await download.path()
    content = fs.readFileSync(exportPath!, 'utf-8')
    lines = content.trim().split('\n')
    headerCols = lines[0].split(',')
    durationIdx = headerCols.indexOf('DurationDays')
    taskLine = lines.find(l => l.includes(TASK_NAME))!
    expect(taskLine).toBeTruthy()
    const updatedDuration = parseFloat(taskLine.split(',')[durationIdx])
    // hoursEffort=16 / hoursPerDay=7.6 → durationDays ≈ 2.10 > original ≈ 1.05
    expect(updatedDuration).toBeGreaterThan(originalDuration)
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

  test.afterAll(async () => {
    // Clean up templates created during this test suite (prefix match)
    await deleteTemplatesByName('E2E Duration Template', 'E2E Refresh Template')
  })
})

// ─── CSV redesign: Type column and status fields ──────────────────────────────
test.describe('CSV redesign — Type column and status fields', () => {
  test('export includes Type column and status columns at end', async ({ page }) => {
    const PROJ = `E2E CSV Type Export ${Date.now()}`
    await login(page)
    await createProject(page, PROJ)
    await page.getByRole('heading', { name: PROJ, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor()
    await page.getByRole('button', { name: /backlog/i }).click()

    // Seed via old-format CSV to create the full Epic > Feature > Story > Task hierarchy.
    // (Backwards compat of the old format is verified by the existing
    // "durationDays is auto-calculated…" test; here we only care about export format.)
    const oldHeaders = 'Epic,Feature,Story,Task,ResourceType,HoursExtraSmall,HoursSmall,HoursMedium,HoursLarge,HoursExtraLarge,HoursEffort,DurationDays,Description,Assumptions'
    const oldData = 'E2E TypeExportEpic,E2E TypeExportFeature,E2E TypeExportStory,E2E TypeExportTask,Developer,0,0,0,0,0,8,,,'
    const csv = [oldHeaders, oldData].join('\n')
    const tmpFile = path.join(os.tmpdir(), `csv-type-export-${Date.now()}.csv`)
    fs.writeFileSync(tmpFile, csv)

    await page.getByRole('button', { name: /import csv/i }).click()
    const fileInput = page.locator('input[type="file"]')
    await fileInput.setInputFiles(tmpFile)
    fs.unlinkSync(tmpFile)

    await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
    await expect(page.getByText('E2E TypeExportEpic')).toBeVisible({ timeout: 10_000 })

    // Export and verify the redesigned headers
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /export csv/i }).click()
    const download = await downloadPromise
    const exportPath = await download.path()
    const content = fs.readFileSync(exportPath!, 'utf-8')
    const lines = content.trim().split(/\r?\n/)
    const headerCols = lines[0].split(',').map(c => c.trim())

    // Type must be the first column
    expect(headerCols[0]).toBe('Type')

    // Status and mode columns must be present
    expect(headerCols).toContain('EpicStatus')
    expect(headerCols).toContain('FeatureStatus')
    expect(headerCols).toContain('StoryStatus')
    expect(headerCols).toContain('EpicMode')
    expect(headerCols).toContain('FeatureMode')

    // All 4 row types must be present
    const typeIdx = headerCols.indexOf('Type')
    expect(lines.some(l => l.split(',')[typeIdx]?.trim() === 'Epic')).toBe(true)
    expect(lines.some(l => l.split(',')[typeIdx]?.trim() === 'Feature')).toBe(true)
    expect(lines.some(l => l.split(',')[typeIdx]?.trim() === 'Story')).toBe(true)
    expect(lines.some(l => l.split(',')[typeIdx]?.trim() === 'Task')).toBe(true)

    // Epic row: EpicStatus=active, FeatureStatus and StoryStatus empty
    const epicStatusIdx = headerCols.indexOf('EpicStatus')
    const featureStatusIdx = headerCols.indexOf('FeatureStatus')
    const storyStatusIdx = headerCols.indexOf('StoryStatus')
    const epicLine = lines.find(l => l.split(',')[typeIdx]?.trim() === 'Epic')!
    expect(epicLine).toBeTruthy()
    const epicCols = epicLine.split(',').map(c => c.trim())
    expect(epicCols[epicStatusIdx]).toBe('active')
    expect(epicCols[featureStatusIdx]).toBe('')
    expect(epicCols[storyStatusIdx]).toBe('')
  })

  test('import with status columns — inactive epic/feature visible after import', async ({ page }) => {
    const PROJ = `E2E CSV Status Import ${Date.now()}`
    await login(page)
    await createProject(page, PROJ)
    await page.getByRole('heading', { name: PROJ, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor()
    await page.getByRole('button', { name: /backlog/i }).click()

    // New-format CSV: inactive Epic row, inactive Feature row, active Story row, Task row.
    // Header has 14 columns (Type … StoryStatus).
    // Row layout: Type(0),Epic(1),Feature(2),Story(3),Task(4),Template(5),
    //             ResourceType(6),HoursEffort(7),DurationDays(8),Description(9),
    //             Assumptions(10),EpicStatus(11),FeatureStatus(12),StoryStatus(13)
    const csv = [
      'Type,Epic,Feature,Story,Task,Template,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus',
      // EpicStatus=inactive at index 11 — 9 empty fields between epicName(1) and inactive(11)
      'Epic,E2E StatusImportEpic,,,,,,,,,,inactive,,',
      // FeatureStatus=inactive at index 12 — 9 empty fields between featureName(2) and inactive(12)
      'Feature,E2E StatusImportEpic,E2E StatusImportFeature,,,,,,,,,,inactive,',
      // StoryStatus=active at index 13 — 9 empty fields between storyName(3) and active(13)
      'Story,E2E StatusImportEpic,E2E StatusImportFeature,E2E StatusImportStory,,,,,,,,,,active',
      // Task row — no status columns
      'Task,E2E StatusImportEpic,E2E StatusImportFeature,E2E StatusImportStory,E2E StatusImportTask,,Developer,4,,,,,,',
    ].join('\n')

    const tmpFile = path.join(os.tmpdir(), `csv-status-import-${Date.now()}.csv`)
    fs.writeFileSync(tmpFile, csv)

    await page.getByRole('button', { name: /import csv/i }).click()
    const fileInput = page.locator('input[type="file"]')
    await fileInput.setInputFiles(tmpFile)
    fs.unlinkSync(tmpFile)

    await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })

    // Inactive epics are still rendered in the backlog (with strikethrough styling),
    // so the element is present and visible in the DOM.
    await expect(page.getByText('E2E StatusImportEpic')).toBeVisible({ timeout: 10_000 })
  })

  test('staging warns when EpicStatus is set on a Task row (wrong type)', async ({ page }) => {
    const PROJ = `E2E CSV Warn WrongType ${Date.now()}`
    await login(page)
    await createProject(page, PROJ)
    await page.getByRole('heading', { name: PROJ, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor()
    await page.getByRole('button', { name: /backlog/i }).click()

    // Task row with EpicStatus=inactive — the server emits a warning because
    // EpicStatus is only meaningful on Epic rows.
    // EpicStatus sits at index 11; indices 8-10 are DurationDays/Description/Assumptions (empty).
    const csv = [
      'Type,Epic,Feature,Story,Task,Template,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus',
      'Task,E2E WarnEpic,E2E WarnFeature,E2E WarnStory,E2E WarnTask,,Developer,4,,,,inactive,,',
    ].join('\n')

    const tmpFile = path.join(os.tmpdir(), `csv-warn-wrongtype-${Date.now()}.csv`)
    fs.writeFileSync(tmpFile, csv)

    await page.getByRole('button', { name: /import csv/i }).click()
    const fileInput = page.locator('input[type="file"]')
    await fileInput.setInputFiles(tmpFile)
    fs.unlinkSync(tmpFile)

    // After file upload the modal automatically moves to the staging step.
    // The yellow warning panel should appear with the EpicStatus message.
    await expect(
      page.getByText(/Warnings \(import will still proceed\)/i)
    ).toBeVisible({ timeout: 10_000 })
    await expect(
      page.getByText(/EpicStatus is only applied on Epic rows/)
    ).toBeVisible({ timeout: 5_000 })
  })

  // Note: backwards compatibility with old CSV format (no Type column, defaults to Task)
  // is already covered by the existing test in the 'Backlog' describe block above:
  //   "durationDays is auto-calculated from hoursEffort on CSV import"
})

// ─── Dependencies (PR #228 / issue #226) ────────────────────────────────────
test.describe('Dependencies', () => {
  test('CSV export includes EpicDependsOn and FeatureDependsOn columns', async ({ page }) => {
    const PROJ = `E2E Dep CSV Export ${Date.now()}`
    await login(page)
    await createProject(page, PROJ)
    await page.getByRole('heading', { name: PROJ, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor()
    await page.getByRole('button', { name: /backlog/i }).click()

    // Seed one epic + feature via CSV import so the export has real hierarchy rows
    const csv = [
      'Type,Epic,Feature,Story,Task,Template,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus,EpicMode,FeatureMode,EpicDependsOn,FeatureDependsOn',
      'Epic,E2E DepEpic,,,,,,,,,,active,,,sequential,,, ',
      'Feature,E2E DepEpic,E2E DepFeature,,,,,,,,,,,,,sequential,,',
    ].join('\n')
    const tmpFile = path.join(os.tmpdir(), `csv-dep-export-${Date.now()}.csv`)
    fs.writeFileSync(tmpFile, csv)

    await page.getByRole('button', { name: /import csv/i }).click()
    const fileInput = page.locator('input[type="file"]')
    await fileInput.setInputFiles(tmpFile)
    fs.unlinkSync(tmpFile)

    await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
    await expect(page.getByText('E2E DepEpic')).toBeVisible({ timeout: 10_000 })

    // Export and verify that both new dependency columns are present in the header
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /export csv/i }).click()
    const download = await downloadPromise
    const exportPath = await download.path()
    const content = fs.readFileSync(exportPath!, 'utf-8')
    const headerCols = content.trim().split(/\r?\n/)[0].split(',').map(c => c.trim())

    expect(headerCols).toContain('EpicDependsOn')
    expect(headerCols).toContain('FeatureDependsOn')
  })

  test('epic rows on backlog page show Add dep button', async ({ page }) => {
    const PROJ = `E2E Dep UI ${Date.now()}`
    await login(page)
    await createProject(page, PROJ)
    await page.getByRole('heading', { name: PROJ, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor()
    await page.getByRole('button', { name: /backlog/i }).click()

    // Add an epic so the epic row is rendered
    await page.getByRole('button', { name: /add epic/i }).click()
    await page.getByPlaceholder(/epic name/i).fill('E2E Dep UI Epic')
    await page.getByRole('button', { name: /save epic/i }).click()
    await expect(page.getByText('E2E Dep UI Epic')).toBeVisible({ timeout: 8_000 })

    // The "＋ dep" button (title="Add epic dependency") must be visible on the epic row
    await expect(page.getByTitle('Add epic dependency').first()).toBeVisible({ timeout: 8_000 })
  })
})
