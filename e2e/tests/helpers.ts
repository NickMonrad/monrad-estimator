/**
 * Shared helpers reused across test files.
 * Credentials match the test/seed user — override via env vars if needed.
 */
import { Page, Locator, expect, request } from '@playwright/test'

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

/** Click the timeline scheduling CTA using the current Timeline UX label. */
export async function quickSchedule(page: Page) {
  const button = page.getByRole('button', {
    name: /^quick schedule( again)?$/i,
  }).first()
  await expect(button).toBeVisible({ timeout: 10_000 })
  await button.click()
}

/** Open the Starting Team Finder drawer and return its dialog locator. */
export async function openStartingTeamFinder(page: Page): Promise<Locator> {
  const trigger = page.getByRole('button', { name: /starting team finder/i }).first()
  await expect(trigger).toBeVisible({ timeout: 10_000 })
  await trigger.click()

  const drawer = page.getByRole('dialog', { name: /starting team finder/i })
  await expect(drawer).toBeVisible({ timeout: 10_000 })
  return drawer
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

/* ── Test user creation ──────────────────────────────────────────────────────
 * Create isolated regular / admin users for global-admin auth tests.
 * Uses the API to register, then (for ADMIN) directly updates the DB role
 * and re-logins so the JWT carries the ADMIN claim.
 * ──────────────────────────────────────────────────────────────────────────── */
import { Client } from 'pg'

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/monrad_estimator'

export interface TestUser {
  email: string
  password: string
  token: string
  name: string
}

async function registerUser(email: string, password: string, name: string) {
  const ctx = await request.newContext({ baseURL: API_BASE })
  try {
    const res = await ctx.post('/api/auth/register', {
      data: { email, password, name },
    })
    const body = await res.json()
    return body as { token: string; user: { id: string; email: string; name: string; role: string } }
  } finally {
    await ctx.dispose()
  }
}

async function updateUserRole(email: string, role: 'USER' | 'ADMIN') {
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    await client.query(`UPDATE "User" SET role = $1 WHERE email = $2`, [role, email])
  } finally {
    await client.end()
  }
}

async function loginAndGetToken(email: string, password: string) {
  const ctx = await request.newContext({ baseURL: API_BASE })
  try {
    const res = await ctx.post('/api/auth/login', {
      data: { email, password },
    })
    const body = await res.json() as { token: string }
    return body.token
  } finally {
    await ctx.dispose()
  }
}

/**
 * Create a test user with the specified role.
 * - Registers a unique user via the API (always creates as regular user).
 * - For ADMIN role, updates the DB directly and re-logins for a fresh JWT.
 * - Uses unique email per call (Date.now + random suffix) to avoid collisions.
 */
export async function createTestUser(role: 'USER' | 'ADMIN' = 'USER'): Promise<TestUser> {
  const suffix = Date.now() + Math.random().toString(36).slice(2, 6)
  const email = `e2e-${suffix}@monrad-estimator-test.com`
  const password = 'E2ETestPass123!'
  const name = `E2E ${role} ${suffix}`

  await registerUser(email, password, name)

  if (role === 'ADMIN') {
    await updateUserRole(email, 'ADMIN')
  }

  // Login (or re-login for admin) to get a JWT carrying the correct role
  const token = await loginAndGetToken(email, password)
  return { email, password, token, name }
}

/**
 * Create a test user and log them in via the browser UI.
 * Returns the TestUser for subsequent API calls.
 */
export async function createUserAndLogin(page: Page, role: 'USER' | 'ADMIN' = 'USER'): Promise<TestUser> {
  const user = await createTestUser(role)
  await page.goto('/login')
  await page.getByPlaceholder('you@example.com').fill(user.email)
  await page.getByPlaceholder('Password').fill(user.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await expect(page.getByRole('heading', { name: /projects/i })).toBeVisible({ timeout: 10_000 })
  return user
}
