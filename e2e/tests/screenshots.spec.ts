/**
 * Screenshot spec — captures representative UI pages for documentation.
 *
 * All tests are tagged @screenshots so they can be excluded from CI:
 *   npx playwright test --grep-invert @screenshots
 *
 * Output: docs/screenshots/*.png  (relative to repo root)
 */
import { test, expect } from '@playwright/test'
import { login, createProject } from './helpers'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SCREENSHOTS_DIR = path.join(__dirname, '../../docs/screenshots')

// Ensure the output directory exists before any test writes to it
test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true })
})

// ---------------------------------------------------------------------------
// 1. Projects page — at least two project cards visible
// ---------------------------------------------------------------------------
test('projects @screenshots', async ({ page }) => {
  await login(page)

  // Create two named projects so the listing is visually interesting
  await createProject(page, 'Acme Platform Redesign')
  await createProject(page, 'Mobile App v2.0')

  // Return to the projects listing root
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /^projects$/i })).toBeVisible()

  // Wait for project cards to fully render
  await expect(page.getByRole('heading', { name: 'Acme Platform Redesign', exact: true }).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Mobile App v2.0', exact: true }).first()).toBeVisible()

  await page.waitForLoadState('networkidle')

  // Move the cursor off-screen to avoid hover artefacts
  await page.mouse.move(0, 0)

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, 'projects.png'),
    fullPage: true,
  })
})

// ---------------------------------------------------------------------------
// 2. Backlog page — epic → feature → story → task hierarchy visible
// ---------------------------------------------------------------------------
test('backlog @screenshots', async ({ page }) => {
  const PROJECT_NAME = `Screenshot Project ${Date.now()}`

  await login(page)
  await createProject(page, PROJECT_NAME)

  // Open the project hub
  await page.getByRole('heading', { name: PROJECT_NAME, exact: true }).first().click()
  await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: /backlog/i }).click()

  await expect(page.getByRole('button', { name: /add epic/i })).toBeVisible()

  // ── Add an epic ──────────────────────────────────────────────────────────
  await page.getByRole('button', { name: /add epic/i }).click()
  await page.getByPlaceholder(/epic name/i).fill('User Authentication')
  await page.getByRole('button', { name: /save epic/i }).click()
  await expect(page.getByText('User Authentication')).toBeVisible()

  // Epic auto-expands after creation; wait for the "Add feature" inline link
  await expect(page.getByText('+ Add feature')).toBeVisible({ timeout: 8_000 })

  // ── Add a feature ────────────────────────────────────────────────────────
  await page.getByText('+ Add feature').click()
  await page.getByPlaceholder('Feature name *').fill('Login & Registration')
  await page.getByRole('button', { name: /^save$/i }).click()
  await expect(page.getByText('Login & Registration')).toBeVisible({ timeout: 8_000 })

  // ── Add a story ──────────────────────────────────────────────────────────
  // Features auto-expand after creation; look for "Add user story" link
  await expect(page.getByText('+ Add user story')).toBeVisible({ timeout: 8_000 })
  await page.getByText('+ Add user story').click()
  await page.getByPlaceholder(/story name/i).fill('As a user I can log in with email and password')
  await page.getByRole('button', { name: /^save$/i }).click()
  await expect(page.getByText(/As a user I can log in/i)).toBeVisible({ timeout: 8_000 })

  // ── Add a task ───────────────────────────────────────────────────────────
  // Stories auto-expand; look for "Add task" or a task-level add button
  const addTaskBtn = page.getByText('+ Add task').first()
  await expect(addTaskBtn).toBeVisible({ timeout: 8_000 })
  await addTaskBtn.click()

  await page.getByPlaceholder(/task name/i).fill('Implement JWT token generation')

  // Resource type field — could be a select or a text input
  const rtSelect = page.locator('select').filter({ has: page.locator('option[value=""]') }).first()
  const rtInput = page.getByPlaceholder(/resource type name/i)
  if (await rtInput.isVisible()) {
    await rtInput.fill('Backend Engineer')
  } else if (await rtSelect.isVisible()) {
    await rtSelect.selectOption({ index: 1 })
  }

  await page.getByRole('button', { name: /^save$/i }).click()
  await expect(page.getByText('Implement JWT token generation')).toBeVisible({ timeout: 8_000 })

  await page.waitForLoadState('networkidle')
  await page.mouse.move(0, 0)

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, 'backlog.png'),
    fullPage: true,
  })
})

// ---------------------------------------------------------------------------
// 3. Timeline page — Gantt chart area visible (may be empty / placeholder)
// ---------------------------------------------------------------------------
test('timeline @screenshots', async ({ page }) => {
  const PROJECT_NAME = `Screenshot Timeline ${Date.now()}`

  await login(page)
  await createProject(page, PROJECT_NAME)

  // Open the project hub then navigate to Timeline
  await page.getByRole('heading', { name: PROJECT_NAME, exact: true }).first().click()
  await page.getByRole('button', { name: /timeline/i }).waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: /timeline/i }).click()

  // Confirm the Timeline Planner heading is visible
  await expect(
    page.getByRole('heading', { name: /timeline planner/i })
  ).toBeVisible({ timeout: 10_000 })

  // Set a start date so the planner has something to render
  const dateInput = page.locator('input[type="date"]')
  if (await dateInput.isVisible()) {
    await dateInput.fill('2025-01-06')
    // Blur by clicking elsewhere to trigger any save handlers
    await page.mouse.click(0, 0)
  }

  await page.waitForLoadState('networkidle')
  await page.mouse.move(0, 0)

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, 'timeline.png'),
    fullPage: true,
  })
})

// ---------------------------------------------------------------------------
// 4. Templates page — template cards visible in the library
// ---------------------------------------------------------------------------
test('templates @screenshots', async ({ page }) => {
  await login(page)
  await page.goto('/templates')

  await expect(page.getByRole('heading', { name: /template library/i })).toBeVisible({ timeout: 10_000 })

  // Create a couple of templates so the page has visible content
  const templates = ['Frontend Component Kit', 'API Integration Pack']

  for (const name of templates) {
    await page.getByRole('button', { name: /new template/i }).click()
    await page.getByPlaceholder(/template name/i).fill(name)
    await page.getByRole('button', { name: /save/i }).click()
    // Wait for the new template to appear before creating the next one
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 8_000 })
  }

  // Dismiss any open modals / focus state before screenshotting
  await page.keyboard.press('Escape')
  await page.waitForLoadState('networkidle')
  await page.mouse.move(0, 0)

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, 'templates.png'),
    fullPage: true,
  })
})

// ---------------------------------------------------------------------------
// 5. Resource Profile page — summary table, overhead section, chart
// ---------------------------------------------------------------------------
test('resource-profile @screenshots', async ({ page }) => {
  await login(page)
  const PROJECT_NAME = `Screenshot Resource Profile ${Date.now()}`

  // Create a project
  await createProject(page, PROJECT_NAME)
  await page.getByRole('heading', { name: PROJECT_NAME, exact: true }).first().click()
  await page.waitForURL(/\/projects\/[^/]+$/)
  const projectUrl = page.url()
  const projectId = projectUrl.split('/projects/')[1]

  // Add an epic → feature → story → task via the backlog
  await page.getByRole('button', { name: /backlog/i }).click()
  await page.waitForURL(/\/backlog/)

  await page.getByRole('button', { name: /add epic/i }).click()
  await page.getByPlaceholder(/epic name/i).fill('Platform Engineering')
  await page.getByRole('button', { name: /save epic/i }).click()
  await expect(page.getByText('Platform Engineering')).toBeVisible({ timeout: 8_000 })

  // Epic auto-expands after creation — Add feature button is immediately available
  await expect(page.getByText('+ Add feature')).toBeVisible({ timeout: 5_000 })
  await page.getByText('+ Add feature').click()
  await page.getByPlaceholder('Feature name *').fill('API Gateway')
  await page.getByRole('button', { name: /^save$/i }).click()
  await expect(page.getByText('API Gateway')).toBeVisible({ timeout: 8_000 })

  // Feature auto-expands — Add user story button is immediately available
  await expect(page.getByText('+ Add user story')).toBeVisible({ timeout: 5_000 })
  await page.getByText('+ Add user story').click()
  await page.getByPlaceholder('Story name *').fill('Design API contract')
  await page.getByRole('button', { name: /^save$/i }).first().click()

  // Story auto-expands on creation — immediately click + Add task before refetch remounts
  await page.getByText('+ Add task').first().click()
  await page.getByPlaceholder('Task name *').fill('API Design')
  await page.locator('select').first().selectOption({ index: 1 })
  await page.getByRole('spinbutton').first().fill('16')
  await page.getByRole('button', { name: /^save$/i }).first().click()
  await expect(page.getByText('API Design')).toBeVisible({ timeout: 8_000 })

  // Navigate to Resource Profile
  await page.goto(`/projects/${projectId}/resource-profile`)
  await expect(page.getByRole('heading', { name: /resource profile/i })).toBeVisible({ timeout: 10_000 })
  await page.waitForLoadState('networkidle')
  await page.mouse.move(0, 0)

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, 'resource-profile.png'),
    fullPage: true,
  })
})

// ---------------------------------------------------------------------------
// 6. Effort Review page — summary table with cost columns and epic sub-rows
// ---------------------------------------------------------------------------
test('effort-review @screenshots', async ({ page }) => {
  await login(page)
  const PROJECT_NAME = `Screenshot Effort Review ${Date.now()}`

  await createProject(page, PROJECT_NAME)
  await page.getByRole('heading', { name: PROJECT_NAME, exact: true }).first().click()
  await page.waitForURL(/\/projects\/[^/]+$/)
  const projectUrl = page.url()
  const projectId = projectUrl.split('/projects/')[1]

  // Seed data via CSV import (2 epics, each with a feature/story/task)
  await page.getByRole('button', { name: /backlog/i }).click()
  await page.waitForURL(/\/backlog/)

  const csvContent = [
    'Type,Epic,Feature,Story,Task,Template,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus',
    'Epic,Platform Build,,,,,,,,,,,,',
    'Feature,Platform Build,Core API,,,,,,,,,,,',
    'Story,Platform Build,Core API,API Design,,,,,,,,,,',
    'Task,Platform Build,Core API,API Design,Design endpoints,,Developer,24,3,,,,,',
    'Task,Platform Build,Core API,API Design,Review API spec,,Tech Lead,8,1,,,,,',
    'Epic,Mobile App,,,,,,,,,,,,',
    'Feature,Mobile App,iOS Build,,,,,,,,,,,',
    'Story,Mobile App,iOS Build,Screen Development,,,,,,,,,,',
    'Task,Mobile App,iOS Build,Screen Development,Build login screen,,Developer,16,2,,,,,',
    'Task,Mobile App,iOS Build,Screen Development,Build home screen,,Developer,12,1.5,,,,,',
  ].join('\n')

  const os = await import('os')
  const tmpPath = path.join(os.tmpdir(), `screenshot-effort-${Date.now()}.csv`)
  fs.writeFileSync(tmpPath, csvContent)

  await page.getByRole('button', { name: /import csv/i }).click()
  const fileInput = page.locator('input[type="file"]')
  await fileInput.setInputFiles(tmpPath)
  await page.getByRole('button', { name: /review.*confirm/i }).click()
  await page.getByRole('button', { name: /import backlog/i }).click()
  // Wait for backlog to show imported data
  await expect(page.getByText(/platform build/i)).toBeVisible({ timeout: 10_000 })
  fs.unlinkSync(tmpPath)

  // Navigate to Effort Review
  await page.goto(`/projects/${projectId}/effort`)
  await expect(page.getByRole('heading', { name: /effort review/i })).toBeVisible({ timeout: 10_000 })
  await page.waitForLoadState('networkidle')
  await page.mouse.move(0, 0)

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, 'effort-review.png'),
    fullPage: true,
  })
})
