/**
 * Shared helpers reused across test files.
 * Credentials match the test/seed user — override via env vars if needed.
 */
import { Page, expect, request } from '@playwright/test'

export const TEST_EMAIL = process.env.TEST_EMAIL ?? 'test@example.com'
export const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'password123'
export const API_BASE = process.env.API_URL ?? 'http://localhost:3001'

/** Log in and land on the Projects page. */
export async function login(page: Page) {
  await page.goto('/login')
  await page.getByPlaceholder('you@example.com').fill(TEST_EMAIL)
  await page.getByPlaceholder('Password').fill(TEST_PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  // After login the app redirects to '/' (Projects page)
  await expect(page.getByRole('heading', { name: /projects/i })).toBeVisible({ timeout: 10_000 })
}

/** Create a project and return its name. */
export async function createProject(page: Page, name: string) {
  await page.getByRole('button', { name: /new project/i }).click()
  await page.getByPlaceholder('Project name').fill(name)
  await page.getByRole('button', { name: /create project/i }).click()
  // wait for the project card heading — using heading role avoids matching the input text
  await page.getByRole('heading', { name, exact: true }).first().waitFor({ timeout: 10_000 })
}

/**
 * Delete templates by name via the API. Call from afterAll to clean up
 * any templates created during a test run.
 */
export async function deleteTemplatesByName(...names: string[]) {
  const ctx = await request.newContext({ baseURL: API_BASE })
  const loginRes = await ctx.post('/api/auth/login', {
    data: { email: TEST_EMAIL, password: TEST_PASSWORD },
  })
  const { token } = await loginRes.json() as { token: string }

  const listRes = await ctx.get('/api/templates', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const templates = await listRes.json() as Array<{ id: string; name: string }>

  for (const t of templates) {
    if (names.some(n => t.name === n || t.name.startsWith(n))) {
      await ctx.delete(`/api/templates/${t.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    }
  }
  await ctx.dispose()
}
