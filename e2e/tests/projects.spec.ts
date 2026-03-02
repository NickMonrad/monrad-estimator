import { test, expect } from '@playwright/test'
import { login, createProject } from './helpers'

const PROJECT_NAME = `E2E Project ${Date.now()}`

test.describe('Projects', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('projects page loads', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /^projects$/i })).toBeVisible()
  })

  test('can create a new project', async ({ page }) => {
    await createProject(page, PROJECT_NAME)
    await expect(page.getByRole('heading', { name: PROJECT_NAME, exact: true }).first()).toBeVisible()
  })

  test('can open a project backlog', async ({ page }) => {
    await createProject(page, PROJECT_NAME)
    await page.getByRole('heading', { name: PROJECT_NAME, exact: true }).first().click()
    // Should navigate to project hub
    await expect(page).toHaveURL(/\/projects\/.+/)
  })

  test('can search/filter projects', async ({ page }) => {
    await createProject(page, PROJECT_NAME)
    const searchInput = page.getByPlaceholder(/search/i)
    if (await searchInput.isVisible()) {
      await searchInput.fill(PROJECT_NAME)
      await expect(page.getByRole('heading', { name: PROJECT_NAME, exact: true }).first()).toBeVisible()
      await searchInput.fill('zzznomatch')
      await expect(page.getByRole('heading', { name: PROJECT_NAME, exact: true }).first()).not.toBeVisible()
    }
  })
})
