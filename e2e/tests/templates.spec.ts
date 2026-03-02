import { test, expect } from '@playwright/test'
import { login } from './helpers'

test.describe('Template Library', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('template library page loads', async ({ page }) => {
    await page.goto('/templates')
    await expect(page.getByRole('heading', { name: /template library/i })).toBeVisible()
  })

  test('can create a new template', async ({ page }) => {
    await page.goto('/templates')
    await page.getByRole('button', { name: /new template/i }).click()
    await page.getByPlaceholder(/template name/i).fill('E2E Template')
    await page.getByRole('button', { name: /save/i }).click()
    await expect(page.getByText('E2E Template').first()).toBeVisible()
  })

  test('Export CSV button is visible', async ({ page }) => {
    await page.goto('/templates')
    await expect(page.getByRole('button', { name: /export csv/i })).toBeVisible()
  })

  test('can create a template task with XS complexity hours', async ({ page }) => {
    await page.goto('/templates')
    // Create a template first
    await page.getByRole('button', { name: /new template/i }).click()
    await page.getByPlaceholder(/template name/i).fill('E2E XS Template')
    await page.getByRole('button', { name: /save/i }).click()
    await page.getByText('E2E XS Template').first().click()

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
    await expect(page.getByText(/download blank csv template/i)).toBeVisible()
  })
})
