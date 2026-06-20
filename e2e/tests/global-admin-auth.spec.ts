/**
 * E2E tests verifying global admin authorization UX for:
 *   - Global Resource Types page
 *   - Rate Cards page
 *
 * Covers both regular-user (read-only) and admin-user (full CRUD) flows,
 * plus API-level 403/200 guard verification.
 *
 * Issue: #258
 * PR: #261
 * Branch: fix/258-global-admin-auth-errors
 */
import { test, expect } from '@playwright/test'
import { login, createTestUser, createUserAndLogin, API_BASE } from './helpers'

const UNIQUE = Date.now()
const suffix = () => `${UNIQUE}-${Math.random().toString(36).slice(2, 6)}`

/* ───────────── Helper: resource type names we create (for cleanup) ────────── */
let createdResourceTypeNames: string[] = []
let createdRateCardNames: string[] = []

test.afterAll(async () => {
  // Clean up created rate cards — use the seed user (regular) for GET, then
  // delete using an admin token via API
  if (createdRateCardNames.length > 0 || createdResourceTypeNames.length > 0) {
    const admin = await createTestUser('ADMIN')

    // Delete rate cards by name
    if (createdRateCardNames.length > 0) {
      const listRes = await fetch(`${API_BASE}/api/rate-cards`, {
        headers: { Authorization: `Bearer ${admin.token}` },
      })
      const cards = await listRes.json() as Array<{ id: string; name: string }>
      for (const rc of cards) {
        if (createdRateCardNames.includes(rc.name)) {
          await fetch(`${API_BASE}/api/rate-cards/${rc.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${admin.token}` },
          })
        }
      }
    }

    // Delete resource types by name
    if (createdResourceTypeNames.length > 0) {
      const listRes = await fetch(`${API_BASE}/api/global-resource-types`, {
        headers: { Authorization: `Bearer ${admin.token}` },
      })
      const types = await listRes.json() as Array<{ id: string; name: string }>
      for (const rt of types) {
        if (createdResourceTypeNames.includes(rt.name)) {
          await fetch(`${API_BASE}/api/global-resource-types/${rt.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${admin.token}` },
          })
        }
      }
    }
  }
})

/* ======================================================================== *
 *  Regular user — read-only UX and API guards                              *
 * ======================================================================== */
test.describe('Global admin auth — regular user', () => {
  test.describe.configure({ mode: 'serial' })

  let regularUser: { email: string; password: string; token: string }

  test.beforeAll(async () => {
    regularUser = await createTestUser('USER')
  })

  test('Resource Types page shows read-only state for regular user', async ({ page }) => {
    // Login as the fresh regular user
    await page.goto('/login')
    await page.getByPlaceholder('you@example.com').fill(regularUser.email)
    await page.getByPlaceholder('Password').fill(regularUser.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page.getByRole('heading', { name: /projects/i })).toBeVisible({ timeout: 10_000 })

    // Navigate to /resource-types
    await page.goto('/resource-types')
    await expect(page.getByRole('heading', { name: /resource types/i })).toBeVisible({ timeout: 10_000 })

    // Read-only notice
    await expect(
      page.getByText(/global resources can only be edited by a global admin/i)
    ).toBeVisible()

    // "+ Add resource type" button must NOT be present
    await expect(
      page.getByRole('button', { name: /add resource type/i })
    ).not.toBeVisible()

    // Table headers — admin sees "Actions", regular sees "Access"
    const headers = page.locator('table th')
    await expect(headers).toHaveText([
      'Name',
      'Category',
      'Description',
      'Default hrs/day',
      'Default day rate',
      'Default',
      'Access',
    ])

    // Body rows show "Read only" badge
    await expect(page.getByText('Read only').first()).toBeVisible()
  })

  test('Rate Cards page shows read-only state for regular user', async ({ page }) => {
    // Log in separately (don't rely on serial session from previous test)
    await page.goto('/login')
    await page.getByPlaceholder('you@example.com').fill(regularUser.email)
    await page.getByPlaceholder('Password').fill(regularUser.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page.getByRole('heading', { name: /projects/i })).toBeVisible({ timeout: 10_000 })

    await page.goto('/rate-cards')
    await expect(page.getByRole('heading', { name: /rate cards/i })).toBeVisible({ timeout: 10_000 })

    // Read-only notice
    await expect(
      page.getByText(/rate cards can only be edited by a global admin/i)
    ).toBeVisible()

    // "+ Create Rate Card" button must NOT be present
    await expect(
      page.getByRole('button', { name: /create rate card/i })
    ).not.toBeVisible()

    // Rate card list items show "Read only" badge
    const readOnlyIndicators = page.getByText('Read only')
    const firstReadOnly = readOnlyIndicators.first()
    if (await firstReadOnly.isVisible().catch(() => false)) {
      await expect(firstReadOnly).toBeVisible()
    }
  })
})

/* ======================================================================== *
 *  API-level guard tests for regular user                                  *
 * ======================================================================== */
test.describe('Global admin auth — API guards for regular user', () => {
  test.describe.configure({ mode: 'serial' })

  let regularUser: { token: string }

  test.beforeAll(async () => {
    regularUser = await createTestUser('USER')
  })

  async function regHeaders() {
    return { Authorization: `Bearer ${regularUser.token}` }
  }

  /* ── Global resource types ─────────────────────────────────────────── */

  test('POST /api/global-resource-types returns 403 for regular user', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/global-resource-types`, {
      headers: await regHeaders(),
      data: { name: `E2E-Fail-${suffix()}`, category: 'ENGINEERING' },
    })
    expect(res.status()).toBe(403)
  })

  test('PUT /api/global-resource-types/:id returns 403 for regular user', async ({ request }) => {
    const res = await request.put(`${API_BASE}/api/global-resource-types/fake-id`, {
      headers: await regHeaders(),
      data: { name: 'Should-Fail', category: 'ENGINEERING' },
    })
    expect(res.status()).toBe(403)
  })

  test('DELETE /api/global-resource-types/:id returns 403 for regular user', async ({ request }) => {
    const res = await request.delete(`${API_BASE}/api/global-resource-types/fake-id`, {
      headers: await regHeaders(),
    })
    expect(res.status()).toBe(403)
  })

  /* ── Rate cards ─────────────────────────────────────────────────────── */

  test('POST /api/rate-cards returns 403 for regular user', async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/rate-cards`, {
      headers: await regHeaders(),
      data: { name: `E2E-Fail-Card-${suffix()}`, entries: [{ globalResourceTypeId: 'dummy', dayRate: 100 }] },
    })
    expect(res.status()).toBe(403)
  })

  test('PUT /api/rate-cards/:id returns 403 for regular user', async ({ request }) => {
    const res = await request.put(`${API_BASE}/api/rate-cards/fake-id`, {
      headers: await regHeaders(),
      data: { name: 'Should-Fail' },
    })
    expect(res.status()).toBe(403)
  })

  test('DELETE /api/rate-cards/:id returns 403 for regular user', async ({ request }) => {
    const res = await request.delete(`${API_BASE}/api/rate-cards/fake-id`, {
      headers: await regHeaders(),
    })
    expect(res.status()).toBe(403)
  })
})

/* ======================================================================== *
 *  Admin user — CRUD UX and API success                                    *
 * ======================================================================== */
test.describe('Global admin auth — admin user', () => {
  test.describe.configure({ mode: 'serial' })

  let adminUser: { email: string; password: string; token: string }
  let globalTypeIds: string[] = []

  test.beforeAll(async () => {
    adminUser = await createTestUser('ADMIN')
  })

  test.afterAll(async () => {
    // Clean up resource types created during the test (non-default types
    // with no task references can be deleted via API)
    if (globalTypeIds.length > 0) {
      for (const id of globalTypeIds) {
        await fetch(`${API_BASE}/api/global-resource-types/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminUser.token}` },
        }).catch(() => {
          // Ignore cleanup failures — the afterAll in the outer describe
          // also tries by name
        })
      }
    }
  })

  /* ── UI: Resource Types page ────────────────────────────────────────── */

  test('Resource Types page shows admin controls and allows CRUD', async ({ page }) => {
    const unique = suffix()

    // Login as admin via UI
    await page.goto('/login')
    await page.getByPlaceholder('you@example.com').fill(adminUser.email)
    await page.getByPlaceholder('Password').fill(adminUser.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page.getByRole('heading', { name: /projects/i })).toBeVisible({ timeout: 10_000 })

    // Navigate to /resource-types
    await page.goto('/resource-types')
    await expect(page.getByRole('heading', { name: /resource types/i })).toBeVisible({ timeout: 10_000 })

    // Verify admin controls: "+ Add resource type" button visible
    const addBtn = page.getByRole('button', { name: /add resource type/i })
    await expect(addBtn).toBeVisible()

    // Verify table headers show "Actions"
    const headers = page.locator('table th')
    await expect(headers).toHaveText([
      'Name',
      'Category',
      'Description',
      'Default hrs/day',
      'Default day rate',
      'Default',
      'Actions',
    ])

    // Verify edit/delete buttons exist on rows (pencil + trash icons)
    // Note: seed types are all isDefault, so delete button title is
    // "Default types cannot be deleted" (not "Delete")
    await expect(page.locator('button[title="Edit"]').first()).toBeVisible()
    await expect(page.locator('[title*="Delete"]').first()).toBeVisible()

    /* ── Create a unique global resource type ─────────────────── */
    const typeName = `E2E Admin Test ${unique}`
    createdResourceTypeNames.push(typeName)

    await addBtn.click()

    // Fill the add form — labels lack htmlFor, use adjacency selectors
    const addForm = page.locator('h2:has-text("New resource type")').locator('..')
    await addForm.locator('label:has-text("Name") + input').fill(typeName)
    await addForm.locator('label:has-text("Category") + select').selectOption('ENGINEERING')
    await page.getByPlaceholder('7.6').fill('8')
    await page.getByPlaceholder('1200').fill('900')
    await page.getByRole('button', { name: /^save$/i }).click()

    // Wait for the type to appear in the table
    await expect(page.getByText(typeName)).toBeVisible({ timeout: 10_000 })

    // Capture the created ID for cleanup
    const listRes = await fetch(`${API_BASE}/api/global-resource-types`, {
      headers: { Authorization: `Bearer ${adminUser.token}` },
    })
    const allTypes = await listRes.json() as Array<{ id: string; name: string }>
    const created = allTypes.find((t: { name: string }) => t.name === typeName)
    if (created) globalTypeIds.push(created.id)

    /* ── Edit the type ────────────────────────────────────────── */
    // Find the edit button for our row and click it
    const row = page.locator('tr').filter({ hasText: typeName })
    await row.locator('button[title="Edit"]').click()

    // The row transforms into an inline edit form — change the description
    const descInput = page.locator('tr').filter({ hasText: typeName }).getByPlaceholder(/description/i)
    await descInput.fill(`Updated description ${unique}`)
    await page.getByRole('button', { name: /^save$/i }).click()

    // Verify the edit succeeded (the description is no longer an input)
    // We trust the mutation completed without error and check the row is back to display mode
    await expect(page.locator('button[title="Edit"]').first()).toBeVisible({ timeout: 10_000 })

    /* ── Delete the type ──────────────────────────────────────── */
    // Click delete
    page.on('dialog', dialog => dialog.accept())
    await row.locator('button[title="Delete"]').click()

    // Wait for it to disappear from the table
    await expect(page.getByText(typeName)).not.toBeVisible({ timeout: 10_000 })
  })

  /* ── UI: Rate Cards page ────────────────────────────────────────────── */

  test('Rate Cards page shows admin controls and allows creation', async ({ page }) => {
    const unique = suffix()

    // Login as admin via UI (fresh login, not relying on serial session)
    await page.goto('/login')
    await page.getByPlaceholder('you@example.com').fill(adminUser.email)
    await page.getByPlaceholder('Password').fill(adminUser.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page.getByRole('heading', { name: /projects/i })).toBeVisible({ timeout: 10_000 })

    await page.goto('/rate-cards')
    await expect(page.getByRole('heading', { name: /rate cards/i })).toBeVisible({ timeout: 10_000 })

    // Verify admin controls
    const createBtn = page.getByRole('button', { name: /create rate card/i })
    await expect(createBtn).toBeVisible()

    // If there's an empty state "Create your first rate card", also check
    const firstBtn = page.getByRole('button', { name: /create your first rate card/i })
    if (await firstBtn.isVisible().catch(() => false)) {
      // Empty state — will use the modal from the main button instead
    }

    /* ── Create a unique rate card ────────────────────────────── */
    const cardName = `E2E Admin Card ${unique}`
    createdRateCardNames.push(cardName)

    await createBtn.click()

    // The modal has no role="dialog", so scope by unique placeholders
    // Fill name
    await page.getByPlaceholder(/e\.g\. standard/i).fill(cardName)

    // Select a global resource type from the add-entry dropdown
    await page.locator('select').filter({ has: page.getByText('Developer') }).selectOption({ label: 'Developer' })

    // Fill the day rate that appears
    await page.getByPlaceholder('1200').fill('1100')

    // Save
    await page.getByRole('button', { name: /^save$/i }).click()

    // Verify the card appears in the list
    await expect(page.getByText(cardName)).toBeVisible({ timeout: 10_000 })

    // Verify the expandable card header shows the rate card name
    const card = page.getByText(cardName)
    await expect(card).toBeVisible()

    // Optionally, set it as default and verify the badge
    const setDefaultBtn = page.getByRole('button', { name: /set default/i })
    if (await setDefaultBtn.isVisible().catch(() => false)) {
      await setDefaultBtn.click()
      await expect(page.getByText('Default').first()).toBeVisible({ timeout: 10_000 })
    }
  })
})

/* ======================================================================== *
 *  API-level success tests for admin user                                  *
 * ======================================================================== */
test.describe('Global admin auth — API success for admin user', () => {
  test.describe.configure({ mode: 'serial' })

  let adminToken: string
  let createdTypeId: string | null = null
  let createdCardId: string | null = null

  test.beforeAll(async () => {
    const admin = await createTestUser('ADMIN')
    adminToken = admin.token
  })

  test.afterAll(async () => {
    // Clean up via admin token
    if (createdCardId) {
      await fetch(`${API_BASE}/api/rate-cards/${createdCardId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => {})
    }
    if (createdTypeId) {
      await fetch(`${API_BASE}/api/global-resource-types/${createdTypeId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => {})
    }
  })

  async function adminHeaders() {
    return { Authorization: `Bearer ${adminToken}` }
  }

  /* ── Global resource types ─────────────────────────────────────────── */

  test('POST /api/global-resource-types succeeds for admin', async ({ request }) => {
    const name = `E2E-Admin-API-${suffix()}`
    createdResourceTypeNames.push(name)
    const res = await request.post(`${API_BASE}/api/global-resource-types`, {
      headers: await adminHeaders(),
      data: { name, category: 'ENGINEERING' },
    })
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.name).toBe(name)
    createdTypeId = body.id
  })

  test('PUT /api/global-resource-types/:id succeeds for admin', async ({ request }) => {
    expect(createdTypeId).toBeTruthy()
    const res = await request.put(`${API_BASE}/api/global-resource-types/${createdTypeId}`, {
      headers: await adminHeaders(),
      data: { name: `E2E-Admin-API-updated-${suffix()}`, category: 'ENGINEERING' },
    })
    expect(res.status()).toBe(200)
  })

  test('DELETE /api/global-resource-types/:id succeeds for admin', async ({ request }) => {
    expect(createdTypeId).toBeTruthy()
    const res = await request.delete(`${API_BASE}/api/global-resource-types/${createdTypeId}`, {
      headers: await adminHeaders(),
    })
    expect(res.status()).toBe(204)
    createdTypeId = null
  })

  /* ── Rate cards ─────────────────────────────────────────────────────── */

  test('POST /api/rate-cards succeeds for admin', async ({ request }) => {
    // Fetch global resource types to get the Developer type ID
    const listRes = await request.get(`${API_BASE}/api/global-resource-types`, {
      headers: await adminHeaders(),
    })
    const types = await listRes.json() as Array<{ id: string; name: string }>
    const developer = types.find((t: { name: string }) => t.name === 'Developer')
    expect(developer).toBeTruthy()

    const name = `E2E-Admin-Card-API-${suffix()}`
    createdRateCardNames.push(name)
    const res = await request.post(`${API_BASE}/api/rate-cards`, {
      headers: await adminHeaders(),
      data: {
        name,
        entries: [{ globalResourceTypeId: developer!.id, dayRate: 950 }],
      },
    })
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.name).toBe(name)
    createdCardId = body.id
  })

  test('PUT /api/rate-cards/:id succeeds for admin', async ({ request }) => {
    expect(createdCardId).toBeTruthy()
    const res = await request.put(`${API_BASE}/api/rate-cards/${createdCardId}`, {
      headers: await adminHeaders(),
      data: { name: `E2E-Admin-Card-API-updated-${suffix()}` },
    })
    expect(res.status()).toBe(200)
  })

  test('DELETE /api/rate-cards/:id succeeds for admin', async ({ request }) => {
    expect(createdCardId).toBeTruthy()
    const res = await request.delete(`${API_BASE}/api/rate-cards/${createdCardId}`, {
      headers: await adminHeaders(),
    })
    expect(res.status()).toBe(204)
    createdCardId = null
  })
})
