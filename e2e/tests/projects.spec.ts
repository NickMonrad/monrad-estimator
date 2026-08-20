import { readFile } from 'node:fs/promises'
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
  test('generates current project context and preserves historical documents', async ({ page }) => {
    test.setTimeout(180_000)
    const projectName = `E2E Project Documents ${Date.now()}`
    const firstLabel = `Scope context before edit ${Date.now()}`
    const secondLabel = `Scope context after edit ${Date.now()}`

    await createProject(page, projectName)
    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    const projectId = new URL(page.url()).pathname.split('/')[2]

    await page.goto(`/projects/${projectId}/settings`)
    const addDependencyButton = page.getByRole('button', { name: 'Add dependency' })
    await page.getByLabel('Add dependency').fill('API access')
    await addDependencyButton.click()
    await expect(page.getByText('API access', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit dependency 1' })).toBeEnabled()
    await page.getByLabel('Add dependency').fill('Production data')
    await expect(addDependencyButton).toBeEnabled()
    await addDependencyButton.click()
    await expect(page.getByText('Production data', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Move dependency 2 up' })).toBeEnabled()
    await page.getByRole('button', { name: 'Move dependency 2 up' }).click()

    const addRiskButton = page.getByRole('button', { name: 'Add risk' })
    await page.getByLabel('Add risk').fill('Vendor delay')
    await page.getByLabel('Mitigation / response (optional)').fill('Escalate early')
    await addRiskButton.click()
    await expect(page.getByText('Vendor delay', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit risk 1' })).toBeEnabled()
    await page.getByLabel('Add risk').fill('Scope change')
    await expect(addRiskButton).toBeEnabled()
    await addRiskButton.click()
    await expect(page.getByText('Scope change', { exact: true })).toBeVisible()
    await page.goto(`/projects/${projectId}/documents`)
    await expect(page.getByRole('checkbox', { name: 'Dependencies' })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Risks' })).toBeChecked()
    await expect(page.getByPlaceholder('Label for this document')).toHaveValue(new RegExp(projectName))
    await page.getByPlaceholder('Label for this document').fill(firstLabel)
    const generateButton = page.getByRole('button', { name: 'Generate & Save' })
    await expect(generateButton).toBeEnabled({ timeout: 30_000 })
    await generateButton.click()
    await expect(page.getByText(firstLabel, { exact: true })).toBeVisible({ timeout: 120_000 })

    const firstCard = page.getByText(firstLabel, { exact: true }).locator('..')
    await expect(firstCard.getByText('Dependencies', { exact: true })).toBeVisible()
    await expect(firstCard.getByText('Risks', { exact: true })).toBeVisible()
    const firstDownload = page.waitForEvent('download')
    await firstCard.getByRole('button', { name: 'Download' }).click()
    const firstDownloadPath = await (await firstDownload).path()
    expect(firstDownloadPath).not.toBeNull()
    const firstBytes = await readFile(firstDownloadPath!)

    await page.goto(`/projects/${projectId}/settings`)
    await expect(page.getByText('Production data', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Edit dependency 1' }).click()
    await page.getByLabel('Dependency description').fill('Production data updated')
    await page.getByLabel('Dependency description').locator('..').getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Production data updated', { exact: true })).toBeVisible()

    await page.goto(`/projects/${projectId}/documents`)
    await expect(page.getByPlaceholder('Label for this document')).toHaveValue(new RegExp(projectName))
    await page.getByPlaceholder('Label for this document').fill(secondLabel)
    await expect(generateButton).toBeEnabled({ timeout: 30_000 })
    await generateButton.click()
    await expect(page.getByText(secondLabel, { exact: true })).toBeVisible({ timeout: 120_000 })

    const firstCardAfterRegeneration = page.getByText(firstLabel, { exact: true }).locator('..')
    const historicalDownload = page.waitForEvent('download')
    await firstCardAfterRegeneration.getByRole('button', { name: 'Download' }).click()
    const historicalPath = await (await historicalDownload).path()
    expect(historicalPath).not.toBeNull()
    await expect(readFile(historicalPath!)).resolves.toStrictEqual(firstBytes)
  })
})
