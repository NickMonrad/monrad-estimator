import { test, expect } from '@playwright/test'
import { login } from './helpers'

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
