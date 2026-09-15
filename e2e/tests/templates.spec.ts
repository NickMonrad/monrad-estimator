import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import fs from 'fs'
import { login, createProject, deleteTemplatesByName, csvFile } from './helpers'

/** Replace the contents of a RichTextEditor identified by its accessible name. */
async function setRichText(page: Page, label: string, text: string) {
  const editor = page.getByLabel(label).locator('.ProseMirror')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.type(text)
}

/**
 * Click a save control and wait for the write it triggers to commit, so later
 * steps (apply/refresh/export) cannot observe pre-write server state.
 */
async function saveAndWaitForWrite(page: Page, button: RegExp, method: string, pathPattern: RegExp) {
  const response = page.waitForResponse(res =>
    res.request().method() === method && pathPattern.test(new URL(res.url()).pathname))
  await page.getByRole('button', { name: button }).click()
  expect((await response).status()).toBeLessThan(300)
}

/** Export the backlog CSV and expose header-indexed field access. */
async function exportBacklog(page: Page) {
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /export csv/i }).click()
  const download = await downloadPromise
  const lines = fs.readFileSync((await download.path())!, 'utf-8').trim().split('\n')
  const columns = lines[0].split(',')
  const field = (line: string, header: string) => line.split(',')[columns.indexOf(header)]
  return { lines, field }
}

test.describe('Template Library', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('template library page loads', async ({ page }) => {
    await page.goto('/templates')
    await expect(page.getByRole('heading', { name: /template library/i })).toBeVisible()
  })

  test('can create a new template', async ({ page }) => {
    const templateName = `E2E Template ${Date.now()}`

    await page.goto('/templates')
    await page.getByRole('button', { name: /new template/i }).click()
    await page.getByPlaceholder(/template name/i).fill(templateName)
    await page.getByRole('button', { name: /^save template$/i }).click()
    await expect(page.getByText(templateName).first()).toBeVisible({ timeout: 10_000 })
  })

  test('Export CSV button is visible', async ({ page }) => {
    await page.goto('/templates')
    await expect(page.getByRole('button', { name: /export csv/i })).toBeVisible()
  })

  test('can create a template task with XS complexity hours', async ({ page }) => {
    const templateName = `E2E XS Template ${Date.now()}`

    await page.goto('/templates')
    // Create a template first
    await page.getByRole('button', { name: /new template/i }).click()
    await page.getByPlaceholder(/template name/i).fill(templateName)
    await page.getByRole('button', { name: /^save template$/i }).click()
    await expect(page.getByText(templateName).first()).toBeVisible({ timeout: 10_000 })
    await page.getByText(templateName).first().click()

    // Add a task
    await page.getByRole('button', { name: /add task/i }).click()
    await page.getByPlaceholder(/task name/i).fill('E2E XS Task')

    // Fill resource type — may be a text input or a select
    const rtInput = page.getByPlaceholder(/resource type name/i)
    const rtSelect = page.locator('select').filter({ hasText: /resource type/i })
    if (await rtInput.isVisible()) {
      await rtInput.fill('Developer')
    } else {
      await rtSelect.selectOption({ index: 1 })
    }

    // XS hours label should be present in the form
    await expect(page.getByText('XS hours')).toBeVisible()

    await page.getByRole('button', { name: /save task/i }).click()

    // XS column header should be visible in the task table
    await expect(page.getByRole('columnheader', { name: 'XS' })).toBeVisible()
  })

  test('Import CSV button opens modal with template download', async ({ page }) => {
    await page.goto('/templates')
    await page.getByRole('button', { name: /import csv/i }).click()
    await expect(page.getByText(/download current templates as csv/i)).toBeVisible()
  })

  test.afterAll(async () => {
    // Clean up templates created during this test suite
    await deleteTemplatesByName('E2E Template', 'E2E XS Template')
  })
})

/**
 * Issue #168 — template metadata contract.
 *
 * Template/task rich-text metadata is authored in the Template Library, copied
 * onto the generated Story and Tasks when the template is applied, and follows
 * the current template when the Story is refreshed — without removing manual tasks.
 */
test.describe('Template metadata propagation', () => {
  const TEMPLATE_NAME = `E2E Metadata Template ${Date.now()}`
  const TASK_NAME = 'E2E Metadata Task'
  const MANUAL_TASK_NAME = 'E2E Manual Task'
  const PROJECT_NAME = `E2E Template Metadata ${Date.now()}`
  const EPIC_NAME = 'E2E Metadata Epic'
  const FEATURE_NAME = 'E2E Metadata Feature'
  const STORY_NAME = 'E2E Metadata Story'

  const TEMPLATE_DESCRIPTION = 'E2E template description'
  const TEMPLATE_ASSUMPTIONS = 'E2E template assumptions'
  const UPDATED_TEMPLATE_ASSUMPTIONS = 'E2E updated template assumptions'
  const TASK_DESCRIPTION = 'E2E task description'
  const TASK_ASSUMPTIONS = 'E2E task assumptions'
  const UPDATED_TASK_DESCRIPTION = 'E2E updated task description'

  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test.afterAll(async () => {
    await deleteTemplatesByName(TEMPLATE_NAME)
  })

  test('propagates rich-text template metadata through apply and refresh', async ({ page }) => {
    // ── 1. Author template description + assumptions with the rich-text editors
    await page.goto('/templates')
    await page.getByRole('button', { name: /new template/i }).click()
    await page.getByPlaceholder(/template name/i).fill(TEMPLATE_NAME)
    await setRichText(page, 'Template description', TEMPLATE_DESCRIPTION)
    await setRichText(page, 'Template assumptions', TEMPLATE_ASSUMPTIONS)
    await saveAndWaitForWrite(page, /^save template$/i, 'POST', /^\/api\/templates$/)

    await expect(page.getByText(TEMPLATE_NAME).first()).toBeVisible({ timeout: 10_000 })
    // Saved metadata is rendered, never shown as raw markup
    await expect(page.getByText(TEMPLATE_DESCRIPTION)).toBeVisible()
    await expect(page.getByText(TEMPLATE_ASSUMPTIONS)).toBeVisible()
    await expect(page.locator('main')).not.toContainText('<p>')

    // ── 2. Author task description + assumptions
    await page.getByText(TEMPLATE_NAME).first().click()
    await page.getByRole('button', { name: /add task/i }).click()
    await page.getByPlaceholder(/task name/i).fill(TASK_NAME)

    const rtInput = page.getByPlaceholder(/resource type name/i)
    const rtSelect = page.locator('select').filter({ hasText: /resource type/i })
    if (await rtInput.isVisible()) {
      await rtInput.fill('Developer')
    } else {
      await rtSelect.selectOption({ index: 1 })
    }

    await page.locator('input[type="number"]').nth(2).fill('8')
    await setRichText(page, 'Task description', TASK_DESCRIPTION)
    await setRichText(page, 'Task assumptions', TASK_ASSUMPTIONS)
    await saveAndWaitForWrite(page, /^save task$/i, 'POST', /^\/api\/templates\/[^/]+\/tasks$/)

    const taskRow = page.locator('tr').filter({ hasText: TASK_NAME })
    await expect(taskRow).toBeVisible({ timeout: 8_000 })
    await taskRow.getByRole('button', { name: /description & assumptions/i }).click()
    await expect(page.getByText(TASK_DESCRIPTION)).toBeVisible()
    await expect(page.getByText(TASK_ASSUMPTIONS)).toBeVisible()
    await expect(page.locator('main')).not.toContainText('<p>')

    // ── 3. Apply the template to a feature
    await page.goto('/')
    await createProject(page, PROJECT_NAME)
    await page.getByRole('heading', { name: PROJECT_NAME, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /backlog/i }).click()
    const backlogUrl = page.url()

    await page.getByRole('button', { name: /add epic/i }).click()
    await page.getByPlaceholder(/epic name/i).fill(EPIC_NAME)
    await page.getByRole('button', { name: /save epic/i }).click()
    await expect(page.getByText(EPIC_NAME)).toBeVisible()

    await expect(page.getByText('+ Add feature')).toBeVisible({ timeout: 5_000 })
    await page.getByText('+ Add feature').click()
    await page.getByPlaceholder('Feature name *').fill(FEATURE_NAME)
    await page.getByRole('button', { name: /^save$/i }).click()
    await expect(page.getByText(FEATURE_NAME)).toBeVisible({ timeout: 8_000 })

    await page.locator('button', { hasText: '+ Template' }).first().click()
    const templateSelect = page.locator('select').last()
    await expect(templateSelect).toBeVisible({ timeout: 8_000 })
    await templateSelect.selectOption({ label: TEMPLATE_NAME })
    await page.getByRole('button', { name: 'M', exact: true }).click()
    await page.getByPlaceholder('Enter story name…').fill(STORY_NAME)
    await saveAndWaitForWrite(page, /^Apply template$/i, 'POST', /^\/api\/features\/[^/]+\/apply-template$/)
    await expect(page.getByText(STORY_NAME)).toBeVisible({ timeout: 10_000 })

    // ── 4. Applied Story and Task carry the template metadata
    let csv = await exportBacklog(page)
    const appliedStory = csv.lines.find(line => line.startsWith('Story,') && csv.field(line, 'Story') === STORY_NAME)!
    expect(csv.field(appliedStory, 'Description')).toBe(`<p>${TEMPLATE_DESCRIPTION}</p>`)
    expect(csv.field(appliedStory, 'Assumptions')).toBe(`<p>${TEMPLATE_ASSUMPTIONS}</p>`)

    const appliedTask = csv.lines.find(line => line.startsWith('Task,') && csv.field(line, 'Task') === TASK_NAME)!
    expect(csv.field(appliedTask, 'Description')).toBe(`<p>${TASK_DESCRIPTION}</p>`)
    expect(csv.field(appliedTask, 'Assumptions')).toBe(`<p>${TASK_ASSUMPTIONS}</p>`)

    // ── 5. Change the template metadata
    // Other specs leave templates behind, so scope the edit to this template's
    // header row (the only `group` row carrying its own History/Edit/Export actions).
    await page.goto('/templates')
    const templateHeader = page.locator('div.group').filter({ hasText: TEMPLATE_NAME })
    await templateHeader.getByRole('button', { name: 'Edit' }).click()
    await expect(page.getByPlaceholder(/template name/i)).toHaveValue(TEMPLATE_NAME)
    await setRichText(page, 'Template assumptions', UPDATED_TEMPLATE_ASSUMPTIONS)
    await saveAndWaitForWrite(page, /^save template$/i, 'PUT', /^\/api\/templates\/[^/]+$/)
    await expect(page.getByText(UPDATED_TEMPLATE_ASSUMPTIONS)).toBeVisible({ timeout: 10_000 })

    await templateHeader.getByText(TEMPLATE_NAME).first().click()
    const editTaskRow = page.locator('tr').filter({ hasText: TASK_NAME })
    await expect(editTaskRow).toBeVisible({ timeout: 8_000 })
    await editTaskRow.getByRole('button', { name: 'Edit' }).click()
    await setRichText(page, 'Task description', UPDATED_TASK_DESCRIPTION)
    await saveAndWaitForWrite(page, /^save task$/i, 'PUT', /^\/api\/templates\/[^/]+\/tasks\/[^/]+$/)
    await editTaskRow.getByRole('button', { name: /description & assumptions/i }).click()
    await expect(page.getByText(UPDATED_TASK_DESCRIPTION)).toBeVisible({ timeout: 10_000 })

    // ── 6. Add an unrelated manual task to the generated Story
    await page.goto(backlogUrl)
    await expect(page.getByRole('button', { name: /export csv/i })).toBeVisible({ timeout: 8_000 })
    await page.getByText(EPIC_NAME).first().click()
    await expect(page.getByText(FEATURE_NAME)).toBeVisible({ timeout: 5_000 })
    await page.getByText(FEATURE_NAME).first().click()
    await expect(page.getByText(STORY_NAME)).toBeVisible({ timeout: 5_000 })
    await page.getByText(STORY_NAME).first().click()

    await page.getByText('+ Add task').first().click()
    const taskNameInput = page.getByPlaceholder('Task name *')
    await taskNameInput.fill(MANUAL_TASK_NAME)
    const taskForm = taskNameInput.locator('xpath=ancestor::div[contains(@class,"space-y-2")][1]')
    await taskForm.locator('select').selectOption({ index: 1 })
    const manualTaskWrite = page.waitForResponse(res =>
      res.request().method() === 'POST' && /^\/api\/stories\/[^/]+\/tasks$/.test(new URL(res.url()).pathname))
    await taskForm.getByRole('button', { name: /^save$/i }).click()
    expect((await manualTaskWrite).status()).toBeLessThan(300)
    await expect(page.getByText(MANUAL_TASK_NAME)).toBeVisible({ timeout: 8_000 })

    // ── 7. Refresh the Story from the template
    await page.getByTitle('Refresh tasks from template').click()
    await expect(page.getByText(/refresh complexity/i)).toBeVisible({ timeout: 5_000 })
    const refreshWrite = page.waitForResponse(res =>
      res.request().method() === 'POST' && /^\/api\/features\/[^/]+\/refresh-template\/[^/]+$/.test(new URL(res.url()).pathname))
    await page.getByRole('button', { name: 'M', exact: true }).click()
    expect((await refreshWrite).status()).toBeLessThan(300)
    await expect(page.getByText(/updated 1 task/i)).toBeVisible({ timeout: 8_000 })

    // ── 8. Story and matched Task metadata follow the template; manual task survives
    csv = await exportBacklog(page)
    const refreshedStory = csv.lines.find(line => line.startsWith('Story,') && csv.field(line, 'Story') === STORY_NAME)!
    expect(csv.field(refreshedStory, 'Assumptions')).toBe(`<p>${UPDATED_TEMPLATE_ASSUMPTIONS}</p>`)

    const refreshedTask = csv.lines.find(line => line.startsWith('Task,') && csv.field(line, 'Task') === TASK_NAME)!
    expect(csv.field(refreshedTask, 'Description')).toBe(`<p>${UPDATED_TASK_DESCRIPTION}</p>`)

    const manualTask = csv.lines.find(line => line.startsWith('Task,') && csv.field(line, 'Task') === MANUAL_TASK_NAME)
    expect(manualTask).toBeTruthy()
  })
})

/**
 * Issue #237 — project-level Refresh templates.
 *
 * One Backlog action refreshes every template-backed Story at the complexity
 * that Story recorded when its template was applied. The #168 additive
 * metadata/effort semantics are preserved and manual tasks remain.
 */
test.describe('Project-level Refresh templates', () => {
  const TEMPLATE_BASE = `E2E Bulk Template ${Date.now()}`
  const TASK_NAME = 'E2E Bulk Task'
  const MANUAL_TASK_NAME = 'E2E Bulk Manual Task'
  const PROJECT_BASE = `E2E Bulk Refresh ${Date.now()}`
  const EPIC_NAME = 'E2E Bulk Epic'
  const FEATURE_NAME = 'E2E Bulk Feature'
  const STORY_SMALL = 'E2E Bulk Story Small'
  const STORY_LARGE = 'E2E Bulk Story Large'
  const LEGACY_STORY_NAME = 'E2E Bulk Legacy Story'

  const TEMPLATE_DESCRIPTION = 'E2E bulk template description'
  const TASK_DESCRIPTION = 'E2E bulk task description'
  const UPDATED_TEMPLATE_ASSUMPTIONS = 'E2E bulk updated assumptions'
  const UPDATED_TASK_DESCRIPTION = 'E2E bulk updated task description'

  /** XS → XL hours, so every tier produces a distinguishable effort. */
  const TIER_HOURS = ['1', '2', '4', '8', '16']

  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test.afterAll(async () => {
    await deleteTemplatesByName(TEMPLATE_BASE)
  })

  /** Author a template whose tiers give each Story a distinct effort. */
  async function createTieredTemplate(page: Page, templateName: string) {
    await page.goto('/templates')
    await page.getByRole('button', { name: /new template/i }).click()
    await page.getByPlaceholder(/template name/i).fill(templateName)
    await setRichText(page, 'Template description', TEMPLATE_DESCRIPTION)
    await saveAndWaitForWrite(page, /^save template$/i, 'POST', /^\/api\/templates$/)
    await expect(page.getByText(templateName).first()).toBeVisible({ timeout: 10_000 })

    await page.getByText(templateName).first().click()
    await page.getByRole('button', { name: /add task/i }).click()
    await page.getByPlaceholder(/task name/i).fill(TASK_NAME)

    const rtInput = page.getByPlaceholder(/resource type name/i)
    const rtSelect = page.locator('select').filter({ hasText: /resource type/i })
    if (await rtInput.isVisible()) {
      await rtInput.fill('Developer')
    } else {
      await rtSelect.selectOption({ index: 1 })
    }

    for (const [index, hours] of TIER_HOURS.entries()) {
      await page.locator('input[type="number"]').nth(index).fill(hours)
    }
    await setRichText(page, 'Task description', TASK_DESCRIPTION)
    await saveAndWaitForWrite(page, /^save task$/i, 'POST', /^\/api\/templates\/[^/]+\/tasks$/)
    await expect(page.locator('tr').filter({ hasText: TASK_NAME })).toBeVisible({ timeout: 8_000 })
  }

  /** Create a project and open its Backlog, returning the Backlog URL. */
  async function openBacklog(page: Page, projectName: string) {
    await page.goto('/')
    await createProject(page, projectName)
    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
    await page.getByRole('button', { name: /backlog/i }).click()
    return page.url()
  }

  /** Add an epic and a feature to the open Backlog. */
  async function createEpicAndFeature(page: Page) {
    await page.getByRole('button', { name: /add epic/i }).click()
    await page.getByPlaceholder(/epic name/i).fill(EPIC_NAME)
    await page.getByRole('button', { name: /save epic/i }).click()
    await expect(page.getByText(EPIC_NAME)).toBeVisible()

    await expect(page.getByText('+ Add feature')).toBeVisible({ timeout: 5_000 })
    await page.getByText('+ Add feature').click()
    await page.getByPlaceholder('Feature name *').fill(FEATURE_NAME)
    await page.getByRole('button', { name: /^save$/i }).click()
    await expect(page.getByText(FEATURE_NAME)).toBeVisible({ timeout: 8_000 })
  }

  /** Apply the tiered template to a new Story at the requested tier. */
  async function applyTemplate(page: Page, templateName: string, storyName: string, tier: string) {
    await page.locator('button', { hasText: '+ Template' }).first().click()
    const templateSelect = page.locator('select').last()
    await expect(templateSelect).toBeVisible({ timeout: 8_000 })
    await templateSelect.selectOption({ label: templateName })
    await page.getByRole('button', { name: tier, exact: true }).click()
    await page.getByPlaceholder('Enter story name…').fill(storyName)
    await saveAndWaitForWrite(page, /^Apply template$/i, 'POST', /^\/api\/features\/[^/]+\/apply-template$/)
    await expect(page.getByText(storyName)).toBeVisible({ timeout: 10_000 })
  }

  test('refreshes every template-backed story at its own recorded complexity', async ({ page }) => {
    const templateName = `${TEMPLATE_BASE} Sizes`
    await createTieredTemplate(page, templateName)
    const backlogUrl = await openBacklog(page, `${PROJECT_BASE} Sizes`)
    await createEpicAndFeature(page)

    // Two template-backed stories at different tiers: Small → 2h, Large → 8h
    await applyTemplate(page, templateName, STORY_SMALL, 'S')
    await applyTemplate(page, templateName, STORY_LARGE, 'L')

    // ── The template's metadata changes before the bulk refresh
    await page.goto('/templates')
    const templateHeader = page.locator('div.group').filter({ hasText: templateName })
    await templateHeader.getByRole('button', { name: 'Edit' }).click()
    await expect(page.getByPlaceholder(/template name/i)).toHaveValue(templateName)
    await setRichText(page, 'Template assumptions', UPDATED_TEMPLATE_ASSUMPTIONS)
    await saveAndWaitForWrite(page, /^save template$/i, 'PUT', /^\/api\/templates\/[^/]+$/)

    await templateHeader.getByText(templateName).first().click()
    const editTaskRow = page.locator('tr').filter({ hasText: TASK_NAME })
    await expect(editTaskRow).toBeVisible({ timeout: 8_000 })
    await editTaskRow.getByRole('button', { name: 'Edit' }).click()
    await setRichText(page, 'Task description', UPDATED_TASK_DESCRIPTION)
    await saveAndWaitForWrite(page, /^save task$/i, 'PUT', /^\/api\/templates\/[^/]+\/tasks\/[^/]+$/)

    // ── A manual task on one generated story must survive the bulk refresh
    await page.goto(backlogUrl)
    await expect(page.getByRole('button', { name: /export csv/i })).toBeVisible({ timeout: 8_000 })
    await page.getByText(EPIC_NAME).first().click()
    await expect(page.getByText(FEATURE_NAME)).toBeVisible({ timeout: 5_000 })
    await page.getByText(FEATURE_NAME).first().click()
    await expect(page.getByText(STORY_SMALL)).toBeVisible({ timeout: 5_000 })
    await page.getByText(STORY_SMALL).first().click()

    await page.getByText('+ Add task').first().click()
    const taskNameInput = page.getByPlaceholder('Task name *')
    await taskNameInput.fill(MANUAL_TASK_NAME)
    const taskForm = taskNameInput.locator('xpath=ancestor::div[contains(@class,"space-y-2")][1]')
    await taskForm.locator('select').selectOption({ index: 1 })
    const manualTaskWrite = page.waitForResponse(res =>
      res.request().method() === 'POST' && /^\/api\/stories\/[^/]+\/tasks$/.test(new URL(res.url()).pathname))
    await taskForm.getByRole('button', { name: /^save$/i }).click()
    expect((await manualTaskWrite).status()).toBeLessThan(300)
    await expect(page.getByText(MANUAL_TASK_NAME)).toBeVisible({ timeout: 8_000 })

    // ── One Backlog-level action refreshes both stories
    await page.getByRole('button', { name: /refresh templates/i }).click()
    const dialog = page.getByRole('dialog', { name: 'Refresh templates' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/2 template-backed stories/i)).toBeVisible()
    await dialog.getByRole('button', { name: /refresh 2 stories/i }).click()
    await expect(dialog.getByText(/refreshed 2 of 2 stories/i)).toBeVisible({ timeout: 20_000 })
    await dialog.getByRole('button', { name: /close refresh templates/i }).click()
    await expect(dialog).toBeHidden()

    // ── Each story kept its own tier; #168 metadata propagated; manual task survived
    const csv = await exportBacklog(page)
    const templateTaskLineFor = (story: string) => csv.lines.find(line =>
      line.startsWith('Task,') && csv.field(line, 'Story') === story && csv.field(line, 'Task') === TASK_NAME)

    const smallTask = templateTaskLineFor(STORY_SMALL)
    const largeTask = templateTaskLineFor(STORY_LARGE)
    expect(smallTask).toBeTruthy()
    expect(largeTask).toBeTruthy()
    expect(csv.field(smallTask!, 'HoursEffort')).toBe('2')
    expect(csv.field(largeTask!, 'HoursEffort')).toBe('8')
    expect(csv.field(smallTask!, 'Description')).toBe(`<p>${UPDATED_TASK_DESCRIPTION}</p>`)

    const smallStory = csv.lines.find(line =>
      line.startsWith('Story,') && csv.field(line, 'Story') === STORY_SMALL)!
    expect(csv.field(smallStory, 'Assumptions')).toBe(`<p>${UPDATED_TEMPLATE_ASSUMPTIONS}</p>`)

    const manualTaskLine = csv.lines.find(line =>
      line.startsWith('Task,') && csv.field(line, 'Story') === STORY_SMALL && csv.field(line, 'Task') === MANUAL_TASK_NAME)
    expect(manualTaskLine).toBeTruthy()
  })

  test('requires a complexity choice for a template-backed story that has none', async ({ page }) => {
    const templateName = `${TEMPLATE_BASE} Legacy`
    await createTieredTemplate(page, templateName)
    await openBacklog(page, `${PROJECT_BASE} Legacy`)

    // A Story row that names the template without a TemplateSize behaves like a
    // story created before the complexity was recorded.
    const headers = 'Type,Epic,Feature,Story,Task,Template,TemplateSize,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus'
    const row = ['Story', EPIC_NAME, FEATURE_NAME, LEGACY_STORY_NAME, '', templateName, '', '', '', '', '', '', '', '', 'active'].join(',')
    await page.getByRole('button', { name: /import csv/i }).click()
    await page.locator('input[type="file"]').setInputFiles(csvFile([headers, row].join('\n')))
    await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
    await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
    await expect(page.getByText(EPIC_NAME)).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: /refresh templates/i }).click()
    const dialog = page.getByRole('dialog', { name: 'Refresh templates' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/1 template-backed story has no recorded complexity/i)).toBeVisible()

    const startButton = dialog.getByRole('button', { name: /refresh 1 story/i })
    await expect(startButton).toBeDisabled()

    await dialog.getByLabel(`Complexity for ${LEGACY_STORY_NAME}`).selectOption('MEDIUM')
    await expect(startButton).toBeEnabled()
    await startButton.click()
    await expect(dialog.getByText(/refreshed 1 of 1 story/i)).toBeVisible({ timeout: 20_000 })
    await dialog.getByRole('button', { name: /close refresh templates/i }).click()
    await expect(dialog).toBeHidden()

    // The chosen complexity is persisted and round-trips through the CSV column
    const csv = await exportBacklog(page)
    const storyLine = csv.lines.find(line =>
      line.startsWith('Story,') && csv.field(line, 'Story') === LEGACY_STORY_NAME)!
    expect(csv.field(storyLine, 'Template')).toBe(templateName)
    expect(csv.field(storyLine, 'TemplateSize')).toBe('Medium')
  })
})
