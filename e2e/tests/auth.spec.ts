import { test, expect } from '@playwright/test'
import { login, TEST_EMAIL, TEST_PASSWORD, API_BASE } from './helpers'

test.describe('Authentication', () => {
  test('shows login page at root when unauthenticated', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
  })

  test('shows error on invalid credentials', async ({ page }) => {
    await page.goto('/login')
    await page.getByPlaceholder('you@example.com').fill('wrong@example.com')
    await page.getByPlaceholder('Password').fill('wrongpass')
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page.getByText(/invalid email or password|invalid credentials|incorrect/i)).toBeVisible({ timeout: 5_000 })
  })

  test('can register a new account', async ({ page }) => {
    await page.goto('/register')
    const email = `e2e-${Date.now()}@example.com`
    await page.getByPlaceholder('Full name').fill('E2E User')
    await page.getByPlaceholder('you@example.com').fill(email)
    await page.getByPlaceholder(/password/i).fill('TestPass123!')
    await page.getByRole('button', { name: /create account|register|sign up/i }).click()
    // After register the app redirects to '/' (Projects page)
    await expect(page.getByRole('heading', { name: /projects/i })).toBeVisible({ timeout: 10_000 })
  })

  test('can sign in with valid credentials', async ({ page }) => {
    await login(page)
    await expect(page.getByRole('heading', { name: /projects/i })).toBeVisible()
  })

  test('sign out returns to login', async ({ page }) => {
    await login(page)
    await page.getByRole('button', { name: /sign out/i }).click()
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Security hardening (feature/security-sprint-1)
// ---------------------------------------------------------------------------
test.describe('Security hardening', () => {
  // Run in serial so the rate-limit test (last) always runs after the login
  // success test rather than potentially interleaving concurrent attempts.
  test.describe.configure({ mode: 'serial' })

  // ── Test 1: Helmet security headers ──────────────────────────────────────
  test('security headers are present on API responses', async ({ request }) => {
    // POST a dummy login — we only care about the response headers, not the body.
    const response = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: 'probe@example.com', password: 'probe' },
    })

    const headers = response.headers()

    // Helmet sets these on every response regardless of status code.
    expect(headers['x-frame-options'],
      'x-frame-options header should be set by Helmet').toBeTruthy()

    expect(headers['x-content-type-options'],
      'x-content-type-options header should be set by Helmet').toBeTruthy()

    expect(headers['x-dns-prefetch-control'],
      'x-dns-prefetch-control header should be set by Helmet').toBeTruthy()
  })

  // ── Test 2: Email enumeration fix ─────────────────────────────────────────
  test('registering with an existing email returns success (no enumeration)', async ({ page }) => {
    // Create a unique email that is guaranteed not to exist yet.
    const uniqueEmail = `e2e-sec-${Date.now()}@example.com`
    const password = 'TestPass123!'

    // ── First registration — should always succeed ──
    await page.goto('/register')
    await page.getByPlaceholder('Full name').fill('Security Test User')
    await page.getByPlaceholder('you@example.com').fill(uniqueEmail)
    await page.getByPlaceholder(/password/i).fill(password)
    await page.getByRole('button', { name: /create account|register|sign up/i }).click()
    // Successful registration lands on the Projects page.
    await expect(page.getByRole('heading', { name: /projects/i })).toBeVisible({ timeout: 10_000 })

    // Sign out so we can hit the register page again as an unauthenticated user.
    await page.getByRole('button', { name: /sign out/i }).click()
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()

    // ── Second registration with the SAME email ──
    // With the enumeration fix the server returns HTTP 200 and the client
    // treats it as a successful registration (no "already in use" error shown).
    await page.goto('/register')
    await page.getByPlaceholder('Full name').fill('Security Test User')
    await page.getByPlaceholder('you@example.com').fill(uniqueEmail)
    await page.getByPlaceholder(/password/i).fill(password)
    await page.getByRole('button', { name: /create account|register|sign up/i }).click()

    // The page must NOT surface an error about the email being taken.
    await expect(
      page.getByText(/already (in use|registered|exists|taken)|email.*exist/i),
    ).not.toBeVisible({ timeout: 5_000 })

    // And it should show the same success state as a real registration.
    await expect(page.getByRole('heading', { name: /projects/i })).toBeVisible({ timeout: 10_000 })
  })

  // ── Test 3: Protected routes require a JWT ────────────────────────────────
  test('GET /api/projects returns 401 when no Authorization header is provided', async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/projects`)
    expect(response.status()).toBe(401)
  })

  // ── Test 4: Rate limit not triggered by normal login activity ─────────────
  test('one failed login attempt followed by correct credentials still succeeds', async ({ page }) => {
    // Wrong password first — should show an error message.
    await page.goto('/login')
    await page.getByPlaceholder('you@example.com').fill(TEST_EMAIL)
    await page.getByPlaceholder('Password').fill('definitively-wrong-password')
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(
      page.getByText(/invalid email or password|invalid credentials|incorrect/i),
    ).toBeVisible({ timeout: 5_000 })

    // Correct credentials immediately after — should succeed.
    // The rate limit (5 attempts / 15 min) must not have kicked in yet.
    await page.getByPlaceholder('you@example.com').fill(TEST_EMAIL)
    await page.getByPlaceholder('Password').fill(TEST_PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page.getByRole('heading', { name: /projects/i })).toBeVisible({ timeout: 10_000 })
  })
})
