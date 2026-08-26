/**
 * replan-profile-repair.spec.ts — Targeted E2E regression for issue #474:
 * making NEEDS_REPLAN Resource Profile recovery actionable for named people.
 *
 *  1. Create a project and seed a backlog referencing THREE preserved
 *     role-only ResourceTypes (CSV import creates role-only roles with
 *     LEGACY_MAPPER ROLE profiles).
 *  2. Reset planning → every profile is discarded; the project NEEDS_REPLAN.
 *  3. Resource Profile visibly marks the missing persisted ROLE profiles
 *     ("Needs capacity profile") instead of presenting the effective
 *     As-needed draft as canonical state.
 *  4. The user chooses the explicit bulk **Use role counts as As needed**
 *     action → exactly one canonical ROLE profile per eligible role.
 *  5. Named people are shown with recovery actions, including the expanded
 *     empty People panel without a false attention indicator.
 *  6. The **Complete replan** action returns the project to CURRENT.
 *  7. Update Timeline succeeds again.
 */

import { test, expect, type Page } from '@playwright/test'
import { login, createProject, quickSchedule } from './helpers'
import path from 'path'
import fs from 'fs'
import os from 'os'

const CSV_CONTENT = [
  'Type,Epic,Feature,Story,Task,Template,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus',
  'Epic,Platform Build,,,,,,,,,,,,',
  'Feature,Platform Build,Core API,,,,,,,,,,,',
  'Story,Platform Build,Core API,API Design,,,,,,,,,,',
  'Task,Platform Build,Core API,API Design,Design endpoints,,Tech Lead,24,3,,,,,',
  'Task,Platform Build,Core API,API Design,Requirements gathering,,Business Analyst,16,2,,,,,',
  'Task,Platform Build,Core API,API Design,Design UX flows,,UX Designer,12,2,,,,,',
].join('\n')

async function seedBacklogViaCsv(page: Page) {
  await page.getByRole('button', { name: /backlog/i }).click()
  await expect(page.getByRole('button', { name: /import csv/i })).toBeVisible({ timeout: 8_000 })

  const tmpFile = path.join(os.tmpdir(), `replan-repair-seed-${Date.now()}.csv`)
  fs.writeFileSync(tmpFile, CSV_CONTENT)
  await page.getByRole('button', { name: /import csv/i }).click()
  await page.locator('input[type="file"]').setInputFiles(tmpFile)
  fs.unlinkSync(tmpFile)

  await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
  await expect(page.getByText('Platform Build')).toBeVisible({ timeout: 10_000 })
}

async function seedNamedPeopleAndRepairRoleProfiles(page: Page, projectId: string) {
  const token = await page.evaluate(() => localStorage.getItem('token'))
  expect(token).toBeTruthy()
  const headers = { Authorization: `Bearer ${token}` }
  const resourceTypesResponse = await page.request.get(`/api/projects/${projectId}/resource-types`, { headers })
  expect(resourceTypesResponse.ok()).toBeTruthy()
  const resourceTypes = await resourceTypesResponse.json() as Array<{ id: string; name: string }>
  const byName = new Map(resourceTypes.map(resourceType => [resourceType.name, resourceType]))

  for (const [roleName, personName] of [
    ['Tech Lead', 'Alice Platform'],
    ['Business Analyst', 'Bob Analysis'],
  ] as const) {
    const resourceType = byName.get(roleName)
    expect(resourceType, `resource type ${roleName}`).toBeDefined()
    const response = await page.request.post(
      `/api/projects/${projectId}/resource-types/${resourceType!.id}/named-resources`,
      { headers, data: { name: personName } },
    )
    expect(response.ok()).toBeTruthy()
  }

  return { headers, resourceTypes }
}

async function seedValidRoleProfiles(page: Page, projectId: string, headers: Record<string, string>, resourceTypes: Array<{ id: string; name: string }>) {
  for (const resourceType of resourceTypes) {
    const response = await page.request.put(
      `/api/projects/${projectId}/capacity-profiles/ROLE/${resourceType.id}`,
      {
        headers,
        data: { planningBasis: 'DEMAND_FOLLOWING', defaultPercent: 100 },
      },
    )
    expect(response.ok(), `role profile ${resourceType.name}`).toBeTruthy()
  }
}

test.describe('NEEDS_REPLAN Resource Profile repair (issue #474)', () => {
  test('named people are actionable, bulk recovery persists, and completion restores CURRENT', async ({ page }) => {
    const projectName = `E2E Replan Repair ${Date.now()}`
    await login(page)
    await createProject(page, projectName)

    // Open the project and seed a backlog referencing three role-only roles.
    await page.getByRole('heading', { name: projectName, exact: true }).first().click()
    await page.getByRole('button', { name: /backlog/i }).waitFor({ timeout: 8_000 })
    await seedBacklogViaCsv(page)
    const projectId = page.url().match(/\/projects\/([^/]+)/)?.[1]!
    expect(projectId).toBeTruthy()
    const fixture = await seedNamedPeopleAndRepairRoleProfiles(page, projectId)

    // ── Reset planning with explicit confirmation ─────────────────────────
    await page.goto(`/projects/${projectId}/resource-profile`)
    await expect(page.getByRole('heading', { name: /resource profile/i })).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: /reset planning…/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: 'Reset planning', exact: true }).click()
    await expect(page.getByTestId('reset-feedback')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('planning-needs-attention')).toBeVisible()
    // The fixture starts with valid role profiles; only named-person recovery
    // is exercised through the browser below.
    await seedValidRoleProfiles(page, projectId, fixture.headers, fixture.resourceTypes)
    await page.reload()
    await expect(page.getByTestId('replan-recovery-summary')).toBeVisible({ timeout: 10_000 })

    // ── Named blockers are identified by person and parent role ───────────
    await expect(page.getByText('Alice Platform')).toBeVisible()
    await expect(page.getByText('Role: Tech Lead')).toBeVisible()
    await expect(page.getByText('Bob Analysis')).toBeVisible()
    await expect(page.getByText('Role: Business Analyst')).toBeVisible()
    const emptyRoleRow = page.locator('tr[data-testid^="resource-profile-row-"]', { hasText: 'UX Designer' })
    await expect(emptyRoleRow).toBeVisible()
    await emptyRoleRow.getByRole('button', { name: 'People ↗', exact: true }).click()
    await expect(page.getByText(/No named resources - using aggregate count \(\d+\)/)).toBeVisible()
    await expect(emptyRoleRow.getByTestId(/people-indicator-/)).toHaveCount(0)

    // ── Explicit named-person bulk user choice ────────────────────────────
    await page.getByRole('button', { name: 'Use As needed for eligible named people' }).click()
    await expect(page.getByTestId('bulk-named-as-needed-feedback')).toContainText(
      'Created As needed availability for 2 named resources.',
      { timeout: 10_000 },
    )
    await expect(page.getByTestId('named-replan-blockers')).not.toBeVisible({ timeout: 10_000 })

    // Reload proves the two canonical named profiles persisted.
    await page.reload()
    await expect(page.getByTestId('replan-recovery-summary')).toContainText('All named resources have availability configured')

    // ── Complete replan → CURRENT ─────────────────────────────────────────
    await page.getByTestId('replan-project-button').click()
    await expect(page.getByTestId('planning-needs-attention')).not.toBeVisible({ timeout: 10_000 })

    // ── Timeline scheduling works again ────────────────────────────────────
    await page.goto(`/projects/${projectId}/timeline`)
    await expect(page.getByRole('heading', { name: /timeline planner/i })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('planning-needs-attention')).not.toBeVisible()
    await quickSchedule(page)
    await expect(page.getByTestId('schedule-error')).not.toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Core API').first()).toBeVisible({ timeout: 10_000 })
  })
})
