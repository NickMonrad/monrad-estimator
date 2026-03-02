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

  test('History button toggles history panel', async ({ page }) => {
    await page.getByRole('button', { name: /backlog/i }).click()
    await page.getByRole('button', { name: /history/i }).click()
    await expect(page.getByText(/backlog history/i)).toBeVisible()
  })
})
