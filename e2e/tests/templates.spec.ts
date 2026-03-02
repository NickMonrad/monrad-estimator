import { test, expect } from '@playwright/test'
import { login } from './helpers'

test.describe('Template Library', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('template library page loads', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /templates/i }).click()
    await expect(page.getByText(/template library/i)).toBeVisible()
  })

  test('can create a new template', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /templates/i }).click()
    await page.getByRole('button', { name: /new template/i }).click()
    await page.getByPlaceholder(/template name/i).fill('E2E Template')
    await page.getByRole('button', { name: /save/i }).click()
    await expect(page.getByText('E2E Template')).toBeVisible()
  })

  test('Export CSV button is visible', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /templates/i }).click()
    await expect(page.getByRole('button', { name: /export csv/i })).toBeVisible()
  })

  test('Import CSV button opens modal with template download', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /templates/i }).click()
    await page.getByRole('button', { name: /import csv/i }).click()
    await expect(page.getByText(/download blank csv template/i)).toBeVisible()
  })
})
