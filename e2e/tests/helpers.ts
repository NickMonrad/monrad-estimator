/**
 * Shared helpers reused across test files.
 * Credentials match the test/seed user — override via env vars if needed.
 */
import { Page } from '@playwright/test'

export const TEST_EMAIL = process.env.TEST_EMAIL ?? 'test@example.com'
export const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'password123'

/** Log in and land on the Projects page. */
export async function login(page: Page) {
  await page.goto('/')
  await page.getByPlaceholder('Email').fill(TEST_EMAIL)
  await page.getByPlaceholder('Password').fill(TEST_PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('**/projects**', { timeout: 10_000 })
}

/** Create a project and return its name. */
export async function createProject(page: Page, name: string) {
  await page.getByRole('button', { name: /new project/i }).click()
  await page.getByPlaceholder(/project name/i).fill(name)
  await page.getByRole('button', { name: /create/i }).click()
  // wait for the card to appear
  await page.getByText(name).waitFor()
}
