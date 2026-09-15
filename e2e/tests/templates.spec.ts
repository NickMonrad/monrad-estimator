import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import fs from 'fs'
import { login, createProject, deleteTemplatesByName } from './helpers'

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
