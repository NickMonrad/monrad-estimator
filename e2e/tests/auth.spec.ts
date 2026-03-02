import { test, expect } from '@playwright/test'
import { login } from './helpers'

test.describe('Authentication', () => {
  test('shows login page at root when unauthenticated', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
  })

  test('shows error on invalid credentials', async ({ page }) => {
    await page.goto('/')
    await page.getByPlaceholder('Email').fill('wrong@example.com')
    await page.getByPlaceholder('Password').fill('wrongpass')
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page.getByText(/invalid credentials|incorrect|error/i)).toBeVisible({ timeout: 5_000 })
  })

  test('can register a new account', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /register|sign up|create account/i }).click()
    const email = `e2e-${Date.now()}@example.com`
    await page.getByPlaceholder('Email').fill(email)
    await page.getByPlaceholder('Password').fill('TestPass123!')
    await page.getByRole('button', { name: /register|sign up|create/i }).click()
    await page.waitForURL('**/projects**', { timeout: 10_000 })
    await expect(page.getByText(/projects|no projects/i)).toBeVisible()
  })

  test('can sign in with valid credentials', async ({ page }) => {
    await login(page)
    await expect(page).toHaveURL(/projects/)
  })

  test('sign out returns to login', async ({ page }) => {
    await login(page)
    await page.getByRole('button', { name: /sign out/i }).click()
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
  })
})
