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


  test('can manage project dependencies and risks in settings', async ({ page }) => {
    const projectName = `E2E Project Context ${Date.now()}`
    await createProject(page, projectName)
    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    const projectId = new URL(page.url()).pathname.split('/')[2]
    await page.goto(`/projects/${projectId}/settings`)

    await expect(page.getByRole('heading', { name: 'Project Settings', exact: true })).toBeVisible()
    await page.getByLabel('Add dependency').fill('API access')
    await page.getByRole('button', { name: 'Add dependency' }).click()
    await expect(page.getByText('API access', { exact: true })).toBeVisible()

    await page.getByLabel('Add risk').fill('Vendor delay')
    await page.getByLabel('Mitigation / response (optional)').fill('Escalate early')
    await page.getByRole('button', { name: 'Add risk' }).click()
    await expect(page.getByText('Vendor delay', { exact: true })).toBeVisible()
    await expect(page.getByText(/Mitigation \/ response: Escalate early/)).toBeVisible()

    await page.reload()
    await expect(page.getByText('API access', { exact: true })).toBeVisible()
    await expect(page.getByText(/Mitigation \/ response: Escalate early/)).toBeVisible()
  })
})
