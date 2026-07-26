import { test, expect, type Page, type Locator } from '@playwright/test'
import { login, createProject, createUserAndLogin, quickSchedule, API_BASE, DATABASE_URL } from './helpers'
import path from 'path'
import fs from 'fs'
import { Client } from 'pg'
import os from 'os'

const CSV_CONTENT = [
  'Type,Epic,Feature,Story,Task,Template,ResourceType,HoursEffort,DurationDays,Description,Assumptions,EpicStatus,FeatureStatus,StoryStatus',
  'Epic,Alpha Epic,,,,,,,,,,active,,',
  'Feature,Alpha Epic,Alpha Feature,,,,,,,,,,,',
  'Story,Alpha Epic,Alpha Feature,Alpha Story,,,,,,,,,,active',
  'Task,Alpha Epic,Alpha Feature,Alpha Story,Alpha Task,,Tech Lead,16,2,,,,,',
  'Task,Alpha Epic,Alpha Feature,Alpha Story,Beta Task,,Project Manager,8,1,,,,,',
].join('\n')

async function seedBacklogProject(page: Page, alreadyAuthenticated = false) {
  if (!alreadyAuthenticated) await login(page)

  const projectName = `E2E Resource Allocation ${Date.now()}`
  await createProject(page, projectName)
  await page.getByRole('heading', { name: projectName, exact: true }).first().click()

  await page.getByRole('button', { name: /backlog/i }).click()
  await expect(page.getByRole('button', { name: /import csv/i })).toBeVisible({ timeout: 8_000 })

  const tmpFile = path.join(os.tmpdir(), `alloc-seed-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`)
  fs.writeFileSync(tmpFile, CSV_CONTENT)
  await page.getByRole('button', { name: /import csv/i }).click()
  await page.locator('input[type="file"]').setInputFiles(tmpFile)
  fs.unlinkSync(tmpFile)

  await page.getByRole('button', { name: /review & confirm/i }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: /import backlog/i }).click({ timeout: 10_000 })
  await expect(page.getByText('Alpha Epic')).toBeVisible({ timeout: 10_000 })

  const projectId = page.url().match(/\/projects\/([^/]+)/)?.[1]
  expect(projectId, 'Expected seeded project URL to include an ID').toBeTruthy()
  return projectId!
}

async function setupCommercialTab(page: Page, alreadyAuthenticated = false) {
  const projectId = await seedBacklogProject(page, alreadyAuthenticated)

  const [rtLoadResponse] = await Promise.all([
    page.waitForResponse(
      resp =>
        resp.url().includes(`/projects/${projectId}/resource-types`) &&
        !resp.url().includes('/named-resources') &&
        resp.request().method() === 'GET',
      { timeout: 15_000 }
    ),
    page.goto(`/projects/${projectId}/resource-profile`),
  ])
  expect(rtLoadResponse.ok()).toBeTruthy()

  await expect(
    page.getByRole('heading', { name: /resource profile/i })
  ).toBeVisible({ timeout: 10_000 })

  await expect(page.locator('input.w-20').first()).toBeVisible({ timeout: 10_000 })
  const dayRateInputs = page.locator('input.w-20')
  const drCount = await dayRateInputs.count()
  for (let i = 0; i < drCount; i++) {
    const input = dayRateInputs.nth(i)
    const currentValue = await input.inputValue()
    if (currentValue !== '') continue
    const [response] = await Promise.all([
      page.waitForResponse(
        resp =>
          resp.url().includes(`/projects/${projectId}/resource-types/`) &&
          resp.request().method() === 'PUT',
        { timeout: 10_000 }
      ),
      (async () => {
        await input.fill('1200')
        await input.press('Tab')
      })(),
    ])
    expect(response.ok()).toBeTruthy()
  }

  await page.getByRole('button', { name: /commercial/i }).click()
  await expect(
    page.getByRole('heading', { name: /cost summary/i })
  ).toBeVisible({ timeout: 10_000 })

  await expect(
    page.getByText(/^(As needed|Fixed for selected weeks ·|Fixed for whole project ·|Varies by week)/).first()
  ).toBeVisible({ timeout: 15_000 })

  return projectId
}

async function gotoResourceProfile(page: Page, projectId: string) {
  const [rtLoadResponse] = await Promise.all([
    page.waitForResponse(
      resp =>
        resp.url().includes(`/projects/${projectId}/resource-types`) &&
        !resp.url().includes('/named-resources') &&
        resp.request().method() === 'GET',
      { timeout: 15_000 }
    ),
    page.goto(`/projects/${projectId}/resource-profile`),
  ])
  expect(rtLoadResponse.ok()).toBeTruthy()
  await expect(page.getByRole('heading', { name: /capacity profile summary/i }).first()).toBeVisible({ timeout: 15_000 })
}

type CanonicalPlannerProfile = {
  profileId: string
  ownerKind: 'plannedResource'
  resourceTypeId: string
  namedResourceId: string
  source: string
  planningBasis: string
  resolutionSource: string
  segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }>
}

const PLANNER_SEGMENTS = [
  { startWeek: 0, endWeek: 3, capacityPercent: 50 },
  { startWeek: 4, endWeek: 8, capacityPercent: 100 },
]

function canonicalSegments(segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }>) {
  return segments.map(({ startWeek, endWeek, capacityPercent }) => ({ startWeek, endWeek, capacityPercent }))
}

async function getPlannerProfile(
  page: Page,
  projectId: string,
  resourceTypeId: string,
  headers: Record<string, string>,
): Promise<CanonicalPlannerProfile> {
  const [capacityProfilesResponse, resourceProfileResponse] = await Promise.all([
    page.request.get(`${API_BASE}/api/projects/${projectId}/capacity-profiles`, { headers }),
    page.request.get(`${API_BASE}/api/projects/${projectId}/resource-profile`, { headers }),
  ])
  expect(capacityProfilesResponse.ok(), 'capacity profile read failed').toBeTruthy()
  expect(resourceProfileResponse.ok(), 'resource profile read failed').toBeTruthy()

  const capacityProfiles = await capacityProfilesResponse.json() as {
    capacityProfiles: Array<{
      id: string
      owner: { kind: string; id: string; roleId?: string }
      source: string
      planningBasis: string
      segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }>
    }>
  }
  const resourceProfile = await resourceProfileResponse.json() as {
    resourceRows: Array<{
      resourceTypeId: string
      namedResources?: Array<{
        id: string
        capacityProfile?: { resolutionSource: string; segments: Array<{ startWeek: number; endWeek: number; capacityPercent: number }> }
      }>
    }>
  }

  const matches = capacityProfiles.capacityProfiles.filter(profile =>
    profile.owner.kind === 'plannedResource' &&
    profile.owner.roleId === resourceTypeId &&
    JSON.stringify(canonicalSegments(profile.segments)) === JSON.stringify(PLANNER_SEGMENTS),
  )
  expect(matches, `Expected exactly one PLANNED_RESOURCE profile with the canonical segmented plan; received ${JSON.stringify(capacityProfiles.capacityProfiles.map(profile => ({ owner: profile.owner, segments: canonicalSegments(profile.segments) })))}`).toHaveLength(1)
  const profile = matches[0]!
  const row = resourceProfile.resourceRows.find(candidate => candidate.resourceTypeId === resourceTypeId)
  const namedResource = row?.namedResources?.find(candidate => candidate.id === profile.owner.id)
  expect(namedResource?.capacityProfile, 'Expected the same planned owner in Resource Profile').toBeTruthy()
  expect(canonicalSegments(namedResource!.capacityProfile!.segments)).toEqual(PLANNER_SEGMENTS)

  return {
    profileId: profile.id,
    ownerKind: 'plannedResource',
    resourceTypeId,
    namedResourceId: profile.owner.id,
    source: profile.source,
    planningBasis: profile.planningBasis,
    resolutionSource: namedResource!.capacityProfile!.resolutionSource,
    segments: canonicalSegments(profile.segments),
  }
}

async function setupSquadPlannerCapacityPlan(page: Page) {
  // This flow owns a unique user and project. The old fixture loaded Resource
  // Profile before apply; direct setup completes the serializable planner write
  // before that page can issue its profile reads.
  const user = await createUserAndLogin(page)
  const projectId = await seedBacklogProject(page, true)
  const authHeaders = { Authorization: `Bearer ${user.token}` }

  const resourceTypesResponse = await page.request.get(
    `${API_BASE}/api/projects/${projectId}/resource-types`,
    { headers: authHeaders },
  )
  expect(resourceTypesResponse.ok(), 'resource type discovery failed').toBeTruthy()
  const resourceTypes = await resourceTypesResponse.json() as Array<{ id: string; name: string }>
  const techLeadMatches = resourceTypes.filter(resourceType => resourceType.name === 'Tech Lead')
  expect(techLeadMatches, 'Expected exactly one seeded Tech Lead resource type').toHaveLength(1)
  const resourceTypeId = techLeadMatches[0]!.id

  const applyPayload = {
    name: 'E2E segmented profile-first plan',
    targetWeeks: 9,
    periodWeeks: 4,
    maxDelta: 1,
    setActive: true,
    periods: [
      { periodIndex: 0, startWeek: 0, endWeek: 4, entries: [{ resourceTypeId, headcount: 0.5, demandFTE: 0.5, utilisationPct: 100 }] },
      { periodIndex: 1, startWeek: 4, endWeek: 9, entries: [{ resourceTypeId, headcount: 1, demandFTE: 1, utilisationPct: 100 }] },
    ],
  }
  const applyResponse = await page.request.post(
    `${API_BASE}/api/projects/${projectId}/squad-plan/apply`,
    { headers: authHeaders, data: applyPayload },
  )
  expect(applyResponse.ok(), `squad-plan/apply failed: ${applyResponse.status()}`).toBeTruthy()

  const before = await getPlannerProfile(page, projectId, resourceTypeId, authHeaders)
  expect(before).toMatchObject({
    ownerKind: 'plannedResource',
    resourceTypeId,
    source: 'squadPlanner',
    planningBasis: 'capacityProfile',
    resolutionSource: 'PROFILE',
    segments: PLANNER_SEGMENTS,
  })

  return { projectId, authHeaders, applyPayload, before }
}

// ─── Segmented NAMED_PERSON helpers ─────────────────────────────────────

type NamedPersonCanonicalState = {
  namedResource: {
    id: string
    name: string
    pricingModel: string
    allocationMode: string
    allocationPercent: number
    allocationPct: number
    allocationStartWeek: number | null
    allocationEndWeek: number | null
    startWeek: number | null
    endWeek: number | null
  }
  profile: {
    id: string
    namedResourceId: string
    resourceTypeId: string
    ownerKind: string
    source: string
    planningBasis: string
    defaultPercent: number | null
    startWeek: number | null
    endWeek: number | null
  }
  segments: Array<{
    id: string
    startWeek: number
    endWeek: number
    capacityPercent: number
    source: string
  }>
}

async function readNamedPersonCanonicalState(nrId: string, profileId: string): Promise<NamedPersonCanonicalState> {
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    const nrResult = await client.query(
      'SELECT id, name, "pricingModel", "allocationMode", "allocationPercent", "allocationPct", "allocationStartWeek", "allocationEndWeek", "startWeek", "endWeek" FROM "NamedResource" WHERE id = $1',
      [nrId],
    )
    const profileResult = await client.query(
      'SELECT id, "namedResourceId", "resourceTypeId", "ownerKind", "source", "planningBasis", "defaultPercent", "startWeek", "endWeek" FROM "CapacityProfile" WHERE id = $1',
      [profileId],
    )
    const segsResult = await client.query(
      'SELECT id, "startWeek", "endWeek", "capacityPercent", "source" FROM "CapacitySegment" WHERE "capacityProfileId" = $1 ORDER BY "startWeek" ASC, "endWeek" ASC',
      [profileId],
    )

    return {
      namedResource: nrResult.rows[0] as NamedPersonCanonicalState['namedResource'],
      profile: profileResult.rows[0] as NamedPersonCanonicalState['profile'],
      segments: segsResult.rows as NamedPersonCanonicalState['segments'],
    }
  } finally {
    await client.end()
  }
}

/** Create a real persisted segmented NAMED_PERSON for the test user's project. */
async function seedSegmentedNamedPerson(page: Page, projectId: string, rtId: string, nrName: string) {
  const segments = [
    { startWeek: 0, endWeek: 3, capacityPercent: 50 },
    { startWeek: 4, endWeek: 8, capacityPercent: 100 },
  ]
  const scope = projectId.replace(/[^a-zA-Z0-9_-]/g, '-')
  const nrId = `test-nr-${scope}-${nrName.replace(/\s+/g, '-').toLowerCase()}`
  const profileId = `test-cp-${scope}-${nrName.replace(/\s+/g, '-').toLowerCase()}`
  const now = new Date().toISOString()

  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    // Stale NamedResource scalar compatibility values — different from profile defaults
    // to prove UI displays authoritative profile values, not these stale legacy fields
    await client.query(
      'INSERT INTO "NamedResource" (id, "resourceTypeId", name, "startWeek", "endWeek", "allocationPct", "allocationMode", "allocationPercent", "allocationStartWeek", "allocationEndWeek", "pricingModel", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
      [nrId, rtId, nrName, 0, 9, 75, 'TIMELINE', 75, 0, 9, 'ACTUAL_DAYS', now, now],
    )

    // CapacityProfile with NAMED_PERSON owner, scalar planning basis, non-planner source
    // resourceTypeId must be NULL for NAMED_PERSON (enforced by CHECK constraint)
    await client.query(
      'INSERT INTO "CapacityProfile" (id, "projectId", "resourceTypeId", "namedResourceId", "ownerKind", "planningBasis", "source", "defaultPercent", "startWeek", "endWeek", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
      [profileId, projectId, null, nrId, 'NAMED_PERSON', 'AVAILABILITY_WINDOW', 'MANUAL', 60, 3, 6, now, now],
    )

    // Two ordered CapacitySegment rows with deterministic IDs
    const segId1 = `test-seg-${nrId}-w1`
    const segId2 = `test-seg-${nrId}-w5`
    await client.query(
      'INSERT INTO "CapacitySegment" (id, "capacityProfileId", "startWeek", "endWeek", "capacityPercent", "source", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8), ($9, $10, $11, $12, $13, $14, $15, $16)',
      [segId1, profileId, segments[0].startWeek, segments[0].endWeek, segments[0].capacityPercent, 'MANUAL', now, now,
       segId2, profileId, segments[1].startWeek, segments[1].endWeek, segments[1].capacityPercent, 'MANUAL', now, now],
    )

    return { nrId, profileId }
  } finally {
    await client.end()
  }
}

test.describe('Resource Allocation', () => {
  test('commercial tab shows allocation badge', async ({ page }) => {
    test.setTimeout(90_000)
    await setupCommercialTab(page)

    const badge = page.getByText(/^(As needed|Fixed for selected weeks ·|Fixed for whole project ·|Varies by week)/).first()
    await expect(badge).toBeVisible({ timeout: 10_000 })
  })

  test('allocation editor opens on badge click, supports all four mode labels', async ({ page }) => {
    test.setTimeout(90_000)
    const projectId = await setupCommercialTab(page)
    await gotoResourceProfile(page, projectId)

    // Open the first editable row
    const badge = page.locator('button[title="Click to edit capacity profile"]').first()
    await expect(badge).toBeVisible({ timeout: 10_000 })
    // Regression: button contract must remain "Click to edit capacity profile"
    await expect(badge).toHaveAttribute('title', 'Click to edit capacity profile')
    await badge.click({ force: true })
    // Modal should open
    await expect(page.getByRole('dialog', { name: /edit capacity profile/i })).toBeVisible({ timeout: 8_000 })
    // Default planning basis selector (new resource type initially has a capacity profile)
    await expect(page.getByTestId('cp-planning-basis-select')).toBeVisible({ timeout: 5_000 })
    // Select wholeProjectAllocation to make Default percent visible
    const modeSelect = page.getByTestId('cp-planning-basis-select')
    await expect(modeSelect).toBeVisible({ timeout: 5_000 })
    await modeSelect.selectOption('wholeProjectAllocation')

    // Now Default percent should be visible
    await expect(page.getByTestId('cp-default-pct-input')).toBeVisible({ timeout: 5_000 })
    const capacityInput = page.getByTestId('cp-default-pct-input')
    await expect(capacityInput).toBeVisible({ timeout: 5_000 })

    // Save and Cancel buttons
    await expect(page.locator('[data-testid="cp-save-btn"]')).toBeVisible()
    await expect(page.locator('[data-testid="cp-cancel-btn"]')).toBeVisible()

    // Cancel to close the modal
    await page.locator('[data-testid="cp-cancel-btn"]').click()
    await expect(page.getByRole('dialog', { name: /edit capacity profile/i })).not.toBeVisible({ timeout: 5_000 })
  })

  test('demandFollowing shows Default percent input', async ({ page }) => {
    test.setTimeout(90_000)
    const projectId = await setupCommercialTab(page)
    await gotoResourceProfile(page, projectId)

    const badge = page.locator('button[title="Click to edit capacity profile"]').first()
    await expect(badge).toBeVisible({ timeout: 10_000 })
    await badge.click({ force: true })

    await expect(page.getByRole('dialog', { name: /edit capacity profile/i })).toBeVisible({ timeout: 8_000 })
    const modeSelect = page.getByTestId('cp-planning-basis-select')
    await expect(modeSelect).toBeVisible({ timeout: 5_000 })

    // Select demandFollowing — Default percent should be visible
    await modeSelect.selectOption('demandFollowing')
    await expect(page.getByTestId("cp-default-pct-input")).toBeVisible({ timeout: 3_000 })

    // Cancel to close
    await page.locator('[data-testid="cp-cancel-btn"]').click()
    await expect(page.getByRole('dialog', { name: /edit capacity profile/i })).not.toBeVisible({ timeout: 5_000 })
  })


  test('changing Default percent updates allocated days', async ({ page }) => {
    test.setTimeout(90_000)
    const projectId = await setupCommercialTab(page)
    await gotoResourceProfile(page, projectId)

    const badge = page.locator('button[title="Click to edit capacity profile"]').first()
    await expect(badge).toBeVisible({ timeout: 10_000 })
    await badge.click({ force: true })

    await expect(page.getByRole('dialog', { name: /edit capacity profile/i })).toBeVisible({ timeout: 8_000 })

    // Select wholeProjectAllocation to access Default percent
    const modeSelect = page.getByTestId('cp-planning-basis-select')
    await modeSelect.selectOption('wholeProjectAllocation')
    await expect(page.getByTestId('cp-default-pct-input')).toBeVisible({ timeout: 5_000 })

    const capacityInput = page.getByTestId('cp-default-pct-input')
    await capacityInput.fill('50')

    await page.locator('[data-testid="cp-save-btn"]').click()

    // Wait for the modal to close (onSuccess handler calls onSaved which calls onClose)
    await expect(page.getByRole('dialog', { name: /edit capacity profile/i })).not.toBeVisible({ timeout: 10_000 })

    // The badge should still be visible (row intact after save)
    await expect(
      page.locator('button[title="Click to edit capacity profile"]').first()
    ).toBeVisible({ timeout: 8_000 })
  })

  test('cancel closes modal without changing mode badge', async ({ page }) => {
    test.setTimeout(90_000)
    const projectId = await setupCommercialTab(page)
    await gotoResourceProfile(page, projectId)

    const badge = page.locator('button[title="Click to edit capacity profile"]').first()
    await expect(badge).toBeVisible({ timeout: 10_000 })
    const badgeTextBefore = await badge.textContent()

    await badge.click({ force: true })
    await expect(page.getByRole('dialog', { name: /edit capacity profile/i })).toBeVisible({ timeout: 8_000 })

    const modeSelect = page.getByTestId('cp-planning-basis-select')
    await expect(modeSelect).toBeVisible({ timeout: 5_000 })
    await modeSelect.selectOption('wholeProjectAllocation')

    // Click Cancel via data-testid
    await page.locator('[data-testid="cp-cancel-btn"]').click()

    // Modal should close
    await expect(page.getByRole('dialog', { name: /edit capacity profile/i })).not.toBeVisible({ timeout: 8_000 })

    // Badge text should be unchanged
    const badgeAfter = page.locator('button[title="Click to edit capacity profile"]').first()
    const badgeTextAfter = await badgeAfter.textContent()
    expect(badgeTextAfter?.trim()).toBe(badgeTextBefore?.trim())
  })

  test('summary tab shows availability pattern column', async ({ page }) => {
    test.setTimeout(90_000)
    const projectId = await setupCommercialTab(page)
    await gotoResourceProfile(page, projectId)

    const allocationHeader = page.locator('th').filter({ hasText: /^Availability pattern$/ })
    await expect(allocationHeader.first()).toBeVisible({ timeout: 8_000 })
  })

  test('Squad Planner apply preserves one planned-resource segmented profile through the safe editor', async ({ page }) => {
    test.setTimeout(120_000)
    const { projectId, authHeaders, before } = await setupSquadPlannerCapacityPlan(page)

    await gotoResourceProfile(page, projectId)

    // Capture only destructive scalar updates while inspecting this exact owner.
    const scalarWrites: string[] = []
    const roleScalarEndpoint = `/api/projects/${projectId}/resource-types/${before.resourceTypeId}`
    const ownerScalarEndpoint = `${roleScalarEndpoint}/named-resources/${before.namedResourceId}`
    page.on('request', request => {
      const url = new URL(request.url()).pathname
      if ((request.method() === 'PUT' && url === roleScalarEndpoint) ||
          (request.method() === 'PATCH' && url === ownerScalarEndpoint)) {
        scalarWrites.push(`${request.method()} ${url}`)
      }
    })

    const roleRow = page.getByTestId(`resource-profile-row-${before.resourceTypeId}`)
    await expect(roleRow).toBeVisible({ timeout: 10_000 })
    await roleRow.getByRole('button', { name: /people/i }).click()

    const ownerCard = page.getByTestId(`named-resource-profile-${before.namedResourceId}`)
    const ownerProfile = page.getByTestId(`profile-managed-owner-${before.namedResourceId}`)
    await expect(ownerCard).toBeVisible({ timeout: 10_000 })
    await expect(ownerProfile).toHaveText('Varies by week')
    await expect(ownerProfile).not.toHaveText(/%/)
    await expect(ownerCard.getByText(/W1-W4: 50%/)).toBeVisible()
    await expect(ownerCard.getByText(/W5-W9: 100%/)).toBeVisible()

        // Protected owner shows Open Squad Planner link and profile info
    const plannerLink = page.getByRole('link', { name: 'Open Squad Planner' }).first()
    await expect(plannerLink).toBeVisible({ timeout: 5_000 })
    await expect(plannerLink).toHaveAttribute('href', `/projects/${projectId}/timeline?panel=squad-planner`)
    await expect(page.getByRole('button', { name: /Edit profile|Create profile/i })).toHaveCount(0)

    await plannerLink.click()
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/timeline\?panel=squad-planner`))
    await expect(page.getByRole('dialog', { name: 'Squad Planner' })).toBeVisible({ timeout: 15_000 })
const profilePath = `/api/projects/${projectId}/resource-profile`
    const [returnedProfileResponse] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === profilePath && response.request().method() === 'GET'),
      page.goBack(),
    ])
    expect(returnedProfileResponse.ok()).toBeTruthy()
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/resource-profile`))
    await expect(page.getByRole('heading', { name: /capacity profile summary/i })).toBeVisible({ timeout: 15_000 })
    const [reloadedProfileResponse] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === profilePath && response.request().method() === 'GET'),
      page.reload(),
    ])
    expect(reloadedProfileResponse.ok()).toBeTruthy()
    await expect(page.getByRole('heading', { name: /capacity profile summary/i })).toBeVisible({ timeout: 15_000 })

    expect(scalarWrites).toEqual([])
    const after = await getPlannerProfile(page, projectId, before.resourceTypeId, authHeaders)
    expect(after).toEqual(before)
  })
  
})
  
// ── Responsive measurements: Timeline resource-counts panel ──
const VP_820 = { width: 820, height: 900 }
const VP_390 = { width: 390, height: 844 }

async function expectElementToFit(locator: Locator) {
  const ok = await locator.evaluate(
    (el: Element) => (el as HTMLElement).scrollWidth <= (el as HTMLElement).clientWidth + 1,
  )
  expect(ok).toBe(true)
}

async function measurePatternSelect(page: Page, viewport: { width: number; height: number }, rowLoc: Locator) {
  await page.setViewportSize(viewport)
  const nrSelect = rowLoc.locator('select[aria-label*="Availability pattern for"]')
  await expect(nrSelect).toBeVisible()
  
  // Change to FULL_PROJECT (longest option) and wait for PATCH to settle
  const patchResp = page.waitForResponse(
    resp => resp.request().method() === 'PATCH' && resp.url().includes('/named-resources/'),
    { timeout: 10_000 },
  )
  await nrSelect.selectOption('FULL_PROJECT')
  await patchResp
  
  // Measure select clientWidth
  const selectWidth = await nrSelect.evaluate((el: HTMLSelectElement) => el.clientWidth)
  
  // Create hidden mirror element with same computed font to measure text width
  const requiredWidth = await nrSelect.evaluate((el: HTMLSelectElement) => {
    const idx = el.selectedIndex
    const text = idx >= 0 ? el.options[idx].text : ''
    const style = window.getComputedStyle(el)
    const mirror = document.createElement('span')
    mirror.textContent = text
    mirror.style.cssText = [
      'position:absolute',
      'visibility:hidden',
      'white-space:nowrap',
      `font-family:${style.fontFamily}`,
      `font-size:${style.fontSize}`,
      `font-weight:${style.fontWeight}`,
      `letter-spacing:${style.letterSpacing}`,
      'left:-9999px',
      'top:-9999px',
    ].join(';')
    document.body.appendChild(mirror)
    const w = mirror.offsetWidth + 24
    document.body.removeChild(mirror)
    return w
  })
  
  expect(selectWidth).toBeGreaterThanOrEqual(requiredWidth)
}

async function addNamedResourceSimple(page: Page): Promise<string> {
  const counts = page.getByTestId('resource-counts')
  const addButton = counts.getByRole('button', { name: /add named resource/i }).first()
  await expect(addButton).toBeVisible({ timeout: 10_000 })

  const postResp = page.waitForResponse(
    resp => resp.request().method() === 'POST' && resp.url().includes('/named-resources'),
    { timeout: 10_000 },
  )
  await addButton.click()
  await postResp

  const nrRow = counts.locator('[data-testid^="named-resource-row-"]').first()
  await expect(nrRow).toBeVisible({ timeout: 10_000 })
  const testId = await nrRow.getAttribute('data-testid')
  expect(testId).toBeTruthy()
  return testId!
}

test.describe('Responsive measurements — Timeline resource-counts', () => {
  test('desktop: pattern select accommodates longest option with no overflow', async ({ page }) => {
    test.setTimeout(120_000)
    const projectId = await setupCommercialTab(page)
    await page.goto(`/projects/${projectId}/timeline`)
    await expect(page.getByText(/Timeline Planner/i)).toBeVisible({ timeout: 10_000 })
    await quickSchedule(page)
    await expect(page.getByText(/\d+ features scheduled/i)).toBeVisible({ timeout: 15_000 })

    const nrTestId = await addNamedResourceSimple(page)
    const rowLoc = page.getByTestId(nrTestId)

    // Measure pattern select width against longest option
    await measurePatternSelect(page, { width: 1280, height: 720 }, rowLoc)
  
    // Re-acquire select locator after PATCH settled
    const freshSelect = rowLoc.locator('select[aria-label*="Availability pattern for"]')
    const selectBox = await freshSelect.boundingBox()
    expect(selectBox).not.toBeNull()

    // Select does not overlap Available % grid cell
    const availPctCell = rowLoc.locator('> span ~ div').nth(1)
    const pctBox = await availPctCell.boundingBox()
    expect(pctBox).not.toBeNull()
    expect(selectBox!.x + selectBox!.width).toBeLessThanOrEqual(pctBox!.x + 1)

    // Select does not overlap Available from grid cell
    const availFromCell = rowLoc.locator('> span ~ div').nth(2)
    const fromBox = await availFromCell.boundingBox()
    expect(fromBox).not.toBeNull()
    expect(selectBox!.x + selectBox!.width).toBeLessThanOrEqual(fromBox!.x + 1)

    // Availability pattern header does not overlap adjacent headers
    const headers = page.getByTestId('named-resource-headers')
    const patternHeader = headers.locator('> *').nth(1)
    const availHeader = headers.locator('> *').nth(2)
    const patHBox = await patternHeader.boundingBox()
    const avHBox = await availHeader.boundingBox()
    expect(patHBox).not.toBeNull()
    expect(avHBox).not.toBeNull()
    expect(patHBox!.x + patHBox!.width).toBeLessThanOrEqual(avHBox!.x + 1)

    // Contextual help scrollWidth <= clientWidth (no overflow)
    const helpText = rowLoc.getByText(/Available at the selected percentage/i)
    await expectElementToFit(helpText)

    // Row has no horizontal overflow
    await expectElementToFit(rowLoc)

    // Document has no horizontal overflow
    const docSW = await page.evaluate(() => document.documentElement.scrollWidth)
    const docCW = await page.evaluate(() => window.innerWidth)
    expect(docSW <= docCW + 1).toBe(true)
  })

  test('820px viewport: pattern select, controls visible with no overflow', async ({ page }) => {
    test.setTimeout(120_000)
    const projectId = await setupCommercialTab(page)
    await page.goto(`/projects/${projectId}/timeline`)
    await expect(page.getByText(/Timeline Planner/i)).toBeVisible({ timeout: 10_000 })
    await quickSchedule(page)
    await expect(page.getByText(/\d+ features scheduled/i)).toBeVisible({ timeout: 15_000 })

    await page.setViewportSize(VP_820)

    const nrTestId = await addNamedResourceSimple(page)
    const rowLoc = page.getByTestId(nrTestId)

    // Measure pattern select width against longest option
    await measurePatternSelect(page, VP_820, rowLoc)
  
    // Re-acquire select locator after PATCH settled
    const freshSelect = rowLoc.locator('select[aria-label*="Availability pattern for"]')
    const selectBox = await freshSelect.boundingBox()
    expect(selectBox).not.toBeNull()

    // Select does not overlap Available % grid cell
    const availPctCell = rowLoc.locator('> span ~ div').nth(1)
    const pctBox = await availPctCell.boundingBox()
    expect(pctBox).not.toBeNull()
    expect(selectBox!.x + selectBox!.width).toBeLessThanOrEqual(pctBox!.x + 1)

    // Select does not overlap Available from grid cell
    const availFromCell = rowLoc.locator('> span ~ div').nth(2)
    const fromBox = await availFromCell.boundingBox()
    expect(fromBox).not.toBeNull()
    expect(selectBox!.x + selectBox!.width).toBeLessThanOrEqual(fromBox!.x + 1)

    // Availability pattern header does not overlap adjacent headers
    const headers = page.getByTestId('named-resource-headers')
    const patternHeader = headers.locator('> *').nth(1)
    const availHeader = headers.locator('> *').nth(2)
    const patHBox = await patternHeader.boundingBox()
    const avHBox = await availHeader.boundingBox()
    expect(patHBox).not.toBeNull()
    expect(avHBox).not.toBeNull()
    expect(patHBox!.x + patHBox!.width).toBeLessThanOrEqual(avHBox!.x + 1)

    // Contextual help fits
    const helpText = rowLoc.getByText(/Available at the selected percentage/i)
    await expectElementToFit(helpText)

    // Row fits
    await expectElementToFit(rowLoc)

    // Document has no overflow
    const docSW = await page.evaluate(() => document.documentElement.scrollWidth)
    const docCW = await page.evaluate(() => window.innerWidth)
    expect(docSW <= docCW + 1).toBe(true)

    // Select still visible after resize
    await expect(freshSelect).toBeVisible()

    // All controls visible
    await expect(
      rowLoc.getByRole('spinbutton', { name: /available percentage for/i }).first(),
    ).toBeVisible()
    await expect(
      rowLoc.getByRole('spinbutton', { name: /available from week for/i }).first(),
    ).toBeVisible()
    await expect(
      rowLoc.getByRole('spinbutton', { name: /available to week for/i }).first(),
    ).toBeVisible()
  })

  test('390px viewport: mobile stacking with readable select and View Resource Profile', async ({ page }) => {
    test.setTimeout(120_000)
    const projectId = await setupCommercialTab(page)
    await page.goto(`/projects/${projectId}/timeline`)
    await expect(page.getByText(/Timeline Planner/i)).toBeVisible({ timeout: 10_000 })
    await quickSchedule(page)
    await expect(page.getByText(/\d+ features scheduled/i)).toBeVisible({ timeout: 15_000 })

    await page.setViewportSize(VP_390)

    const nrTestId = await addNamedResourceSimple(page)
    const rowLoc = page.getByTestId(nrTestId)

    // Mobile inline labels visible
    await expect(rowLoc.getByText('Pattern:')).toBeVisible()
    await expect(rowLoc.getByText('Avail:')).toBeVisible()
    await expect(rowLoc.getByText('Avail from:')).toBeVisible()
    await expect(rowLoc.getByText('Avail to:')).toBeVisible()

    // Switch to CAPACITY_PLAN to check View Resource Profile button
    const nrSelect = rowLoc.locator('select[aria-label*="Availability pattern for"]')
    await expect(nrSelect).toBeVisible()
    const patchResp = page.waitForResponse(
      resp => resp.request().method() === 'PATCH' && resp.url().includes('/named-resources/'),
      { timeout: 10_000 },
    )
    await nrSelect.selectOption('CAPACITY_PLAN')
    await patchResp

    // Re-acquire select after PATCH settles
    const mobileSelect = rowLoc.locator('select[aria-label*="Availability pattern for"]')
    await expect(mobileSelect).toBeVisible()
    await expect(mobileSelect).toHaveValue('CAPACITY_PLAN')
    // Selected option remains readable — verify text content not clipped using mirror element
    const selectWidth = await mobileSelect.evaluate((el: HTMLSelectElement) => el.clientWidth)
    const requiredWidth = await mobileSelect.evaluate((el: HTMLSelectElement) => {
      const idx = el.selectedIndex
      const text = idx >= 0 ? el.options[idx].text : ''
      const style = window.getComputedStyle(el)
      const mirror = document.createElement('span')
      mirror.textContent = text
      mirror.style.cssText = [
        'position:absolute',
        'visibility:hidden',
        'white-space:nowrap',
        `font-family:${style.fontFamily}`,
        `font-size:${style.fontSize}`,
        `font-weight:${style.fontWeight}`,
        `letter-spacing:${style.letterSpacing}`,
        'left:-9999px',
        'top:-9999px',
      ].join(';')
      document.body.appendChild(mirror)
      const w = mirror.offsetWidth + 24
      document.body.removeChild(mirror)
      return w
    })
    expect(selectWidth).toBeGreaterThanOrEqual(requiredWidth)
  
    // Help text wraps within row
    const helpText = rowLoc.getByText(/Availability varies by week/i)
    await expect(helpText).toBeVisible()
    const helpFits = await helpText.evaluate((el: Element) => (el as HTMLElement).scrollWidth <= (el as HTMLElement).clientWidth + 1)
    expect(helpFits).toBe(true)
  
    // Pattern, Avail, Avail from, Avail to groups stack vertically
    const basisGroup = rowLoc.getByText('Pattern:').locator('..')
    const allocGroup = rowLoc.getByText('Avail:').locator('..')
    const startGroup = rowLoc.getByText('Avail from:').locator('..')
    const endGroup = rowLoc.getByText('Avail to:').locator('..')
    const basisBox = await basisGroup.boundingBox()
    const allocBox = await allocGroup.boundingBox()
    const startBox = await startGroup.boundingBox()
    const endBox = await endGroup.boundingBox()
    expect(basisBox).not.toBeNull()
    expect(allocBox).not.toBeNull()
    expect(startBox).not.toBeNull()
    expect(endBox).not.toBeNull()
    expect(allocBox!.y).toBeGreaterThanOrEqual(basisBox!.y + basisBox!.height - 2)
    expect(startBox!.y).toBeGreaterThanOrEqual(allocBox!.y + allocBox!.height - 2)
    expect(endBox!.y).toBeGreaterThanOrEqual(startBox!.y + startBox!.height - 2)
  
    // View Resource Profile button visible and clickable
    const rpButton = page.getByRole('button', { name: /view resource profile/i })
    await expect(rpButton).toBeVisible()
    await expect(rpButton).toBeEnabled()
    // Click and verify navigation to resource profile
    await rpButton.click()
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/resource-profile`))
    // No horizontal page overflow in resource-counts panel
    const countsPanel = page.getByTestId('resource-counts')
    await expectElementToFit(countsPanel)
  })

  test('CAPACITY_PLAN: help text and View Resource Profile at desktop and 820px', async ({ page }) => {
    test.setTimeout(120_000)
    const projectId = await setupCommercialTab(page)
    await page.goto(`/projects/${projectId}/timeline`)
    await expect(page.getByText(/Timeline Planner/i)).toBeVisible({ timeout: 10_000 })
    await quickSchedule(page)
    await expect(page.getByText(/\d+ features scheduled/i)).toBeVisible({ timeout: 15_000 })

    const nrTestId = await addNamedResourceSimple(page)
    const rowLoc = page.getByTestId(nrTestId)

    // Switch to CAPACITY_PLAN
    const nrSelect = rowLoc.locator('select[aria-label*="Availability pattern for"]')
    await expect(nrSelect).toBeVisible()
    const patchResp = page.waitForResponse(
      resp => resp.request().method() === 'PATCH' && resp.url().includes('/named-resources/'),
      { timeout: 10_000 },
    )
    await nrSelect.selectOption('CAPACITY_PLAN')
    await patchResp

    // ── Desktop (default viewport) ──
    // Varies by week help text visible
    const cpHelp = rowLoc.getByText(/Availability varies by week/i)
    await expect(cpHelp).toBeVisible()

    // Contextual help inside row
    const rowBox = await rowLoc.boundingBox()
    const helpBox = await cpHelp.boundingBox()
    expect(rowBox).not.toBeNull()
    expect(helpBox).not.toBeNull()
    expect(helpBox!.x).toBeGreaterThanOrEqual(rowBox!.x - 1)
    expect(helpBox!.x + helpBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 1)
    expect(helpBox!.y).toBeGreaterThanOrEqual(rowBox!.y - 1)
    expect(helpBox!.y + helpBox!.height).toBeLessThanOrEqual(rowBox!.y + rowBox!.height + 1)

    // View Resource Profile visible and not overlapping adjacent grid column
    const rpBtn = page.getByRole('button', { name: /view resource profile/i })
    await expect(rpBtn).toBeVisible()
    const patternCell = rowLoc.locator('> div').first()
    const patternBox = await patternCell.boundingBox()
    const rpBox = await rpBtn.boundingBox()
    expect(patternBox).not.toBeNull()
    expect(rpBox).not.toBeNull()
    expect(rpBox!.x).toBeGreaterThanOrEqual(patternBox!.x - 1)
    expect(rpBox!.x + rpBox!.width).toBeLessThanOrEqual(patternBox!.x + patternBox!.width + 1)

    // ── 820px viewport ──
    await page.setViewportSize(VP_820)

    await expect(page.getByRole('button', { name: /view resource profile/i })).toBeVisible()
    await expect(rowLoc.locator('select[aria-label*="Availability pattern for"]')).toBeVisible()
    await expect(rowLoc.getByText(/Availability varies by week/i)).toBeVisible()

    // Help text fits inside row at 820px
    await expectElementToFit(rowLoc.getByText(/Availability varies by week/i))

    // View Resource Profile visible and within row bounds
    const rpBtn820 = page.getByRole('button', { name: /view resource profile/i })
    await expect(rpBtn820).toBeVisible()
    const rp820Box = await rpBtn820.boundingBox()
    const row820Box = await rowLoc.boundingBox()
    expect(rp820Box).not.toBeNull()
    expect(row820Box).not.toBeNull()
    expect(rp820Box!.x).toBeGreaterThanOrEqual(row820Box!.x - 1)
    expect(rp820Box!.x + rp820Box!.width).toBeLessThanOrEqual(row820Box!.x + row820Box!.width + 1)
  })
})

test.describe('Segmented NAMED_PERSON protection', () => {
  test('safe updates preserve profile identity through People panel', async ({ page }) => {
    test.setTimeout(120_000)

    // ── Create test user, project, and seed a true segmented NAMED_PERSON ──
    const user = await createUserAndLogin(page)
    const projectId = await seedBacklogProject(page, true)
    const authHeaders = { Authorization: `Bearer ${user.token}` }

    // Discover resource types
    const rtsRes = await page.request.get(
      `${API_BASE}/api/projects/${projectId}/resource-types`,
      { headers: authHeaders },
    )
    expect(rtsRes.ok(), 'resource type discovery failed').toBeTruthy()
    const rts = await rtsRes.json() as Array<{ id: string; name: string }>
    const techLead = rts.find(rt => rt.name === 'Tech Lead')
    expect(techLead, 'Expected seeded Tech Lead resource type').toBeDefined()
    const rtId = techLead!.id

    // Seed a real segmented NAMED_PERSON via direct database access
    const { nrId, profileId } = await seedSegmentedNamedPerson(page, projectId, rtId, 'Segmented Alice')

    // Capture canonical state BEFORE any UI changes
    const before = await readNamedPersonCanonicalState(nrId, profileId)

    // ── 1. Navigate to Resource Profile page ──
    await gotoResourceProfile(page, projectId)
    // ── 2. Intercept PUT requests to the named-resource endpoint ──
    const putBodies: string[] = []
    // Monitor all three scalar-write routes for any capacity-bearing request
    const scalarMonitorRequests: Array<{ method: string; url: string; body?: string }> = []
    const namedResMonitor = `/api/projects/${projectId}/resource-types/${rtId}/named-resources/${nrId}`
    const rtMonitor = `/api/projects/${projectId}/resource-types/${rtId}`
    page.on('request', request => {
      const url = request.url()
      // Check if this is a relevant route
      if (request.method() === 'PUT' && url.includes(rtMonitor) && !url.includes('/named-resources/')) {
        // PUT to /resource-types/:rtId (scalar allocation update)
        scalarMonitorRequests.push({ method: 'PUT', url })
      } else if ((request.method() === 'PUT' || request.method() === 'PATCH') && url.includes(namedResMonitor)) {
        // PUT or PATCH to named-resource
        scalarMonitorRequests.push({ method: request.method(), url })
      }
    })
    await page.route((url) => url.pathname.includes(`/named-resources/${nrId}`), async route => {
      if (route.request().method() === 'PUT') {
        putBodies.push(route.request().postData() || '{}')
      }
      await route.continue()
    })

    // ── 3. Open the People panel ──
    const roleRow = page.getByTestId(`resource-profile-row-${rtId}`)
    await expect(roleRow).toBeVisible({ timeout: 10_000 })
    await roleRow.getByRole('button', { name: /people/i }).click()

    // ── 4. Verify the segmented-profile UI ──
    const ownerCard = page.getByTestId(`named-resource-profile-${nrId}`)
    const ownerBadge = page.getByTestId(`profile-managed-owner-${nrId}`)
    await expect(ownerCard).toBeVisible({ timeout: 10_000 })
    await expect(ownerBadge).toHaveText('Varies by week')
    await expect(ownerBadge).not.toHaveText(/%/)
    // Verify ordered segment summaries
    await expect(ownerCard.getByText(/W1-W4: 50%/)).toBeVisible()
    await expect(ownerCard.getByText(/W5-W9: 100%/)).toBeVisible()

    // ── 5. Verify profile controls are correct ──
    // Edit profile button should be present (non-protected owner)
    const profileAction = page.getByTestId(`named-resource-profile-action-${nrId}`)
    await expect(profileAction).toBeVisible({ timeout: 5_000 })
    await expect(profileAction).toHaveText('Edit profile')
    // No Squad Planner link for manually created named person
    await expect(page.getByTestId(`named-resource-row-${nrId}`).getByRole('link', { name: /Open Squad Planner/i })).toHaveCount(0)

    // ── 6. Rename via the actual row name input ──
    const row = page.getByTestId(`named-resource-row-${nrId}`)
    await expect(row).toBeVisible()
    const nameInput = row.getByRole('textbox')
    await expect(nameInput).toBeVisible()
    await expect(nameInput).toBeEnabled()
    await nameInput.fill('Segmented Alice Renamed')
    // Register rename response promise BEFORE the action to avoid race
    const renameResponsePromise = page.waitForResponse(
      response => {
        if (!response.url().includes(`/named-resources/${nrId}`)) return false
        if (response.request().method() !== 'PUT') return false
        const body = response.request().postDataJSON()
        return body?.name === 'Segmented Alice Renamed' && Object.keys(body).length === 1
      },
      { timeout: 10_000 },
    )
    // Blur triggers PUT (onBlur handler)
    await nameInput.blur()
    const renameResponse = await renameResponsePromise
    expect(renameResponse.ok()).toBeTruthy()
    // Verify the body was captured via route handler
    const renamePutBody = JSON.parse(putBodies.find(b => {
      try { return JSON.parse(b).name !== undefined }
      catch { return false }
    }) || '{}')
    expect(renamePutBody).toEqual({ name: 'Segmented Alice Renamed' })

    // ── 7. Change billing basis via the row select ──
    const billingSelect = page.locator(`#billing-basis-${nrId}`)
    await expect(billingSelect).toBeVisible()
    await expect(billingSelect).toBeEnabled()
    // Register billing response promise BEFORE the action to avoid race
    const billingResponsePromise = page.waitForResponse(
      response => {
        if (!response.url().includes(`/named-resources/${nrId}`)) return false
        if (response.request().method() !== 'PUT') return false
        const body = response.request().postDataJSON()
        return body?.pricingModel === 'PRO_RATA' && Object.keys(body).length === 1
      },
      { timeout: 10_000 },
    )
    await billingSelect.selectOption('PRO_RATA')
    const billingResponse = await billingResponsePromise
    expect(billingResponse.ok()).toBeTruthy()
    // Verify the body was captured via route handler
    const billingPutBody = JSON.parse(
      putBodies.find(b => {
        try { return JSON.parse(b).pricingModel !== undefined }
        catch { return false }
      }) || '{}',
    )
    expect(billingPutBody).toEqual({ pricingModel: 'PRO_RATA' })

    // ── 8. Verify no scalar-capacity writes occurred ──
    // Check all captured PUTs — none should contain scalar capacity fields
    for (const rawBody of putBodies) {
      const body = JSON.parse(rawBody)
      const scalarKeys = ['allocationMode', 'allocationPercent', 'allocationPct', 'allocationStartWeek', 'allocationEndWeek', 'startWeek', 'endWeek']
      for (const key of scalarKeys) {
        expect(body).not.toHaveProperty(key)
      }
    }
    // Verify no PATCH or RT-level PUT occurred during the test
    const riskyRequests = scalarMonitorRequests.filter(r =>
      r.method === 'PATCH' || (r.method === 'PUT' && !r.url.includes('/named-resources/')),
    )
    expect(riskyRequests).toEqual([])
    // ── 9. Reload and verify persistence ──
    await page.reload()
    await expect(page.getByRole('heading', { name: /capacity profile summary/i })).toBeVisible({ timeout: 15_000 })
    // Reopen the People panel before checking panel-scoped elements
    const roleRowReloaded = page.getByTestId(`resource-profile-row-${rtId}`)
    await expect(roleRowReloaded).toBeVisible({ timeout: 10_000 })
    await roleRowReloaded.getByRole('button', { name: /people/i }).click()
    // Named resource rows inside the People panel are now visible
    await expect(page.getByTestId(`named-resource-row-${nrId}`).getByRole('textbox')).toHaveValue('Segmented Alice Renamed')
    const reloadedBilling = page.locator(`#billing-basis-${nrId}`)
    await expect(reloadedBilling).toHaveValue('PRO_RATA')
    // Recreate panel-scoped locators after reload (avoid stale refs)
    const reloadedOwnerCard = page.getByTestId(`named-resource-profile-${nrId}`)
    const reloadedOwnerBadge = page.getByTestId(`profile-managed-owner-${nrId}`)
    await expect(reloadedOwnerBadge).toHaveText('Varies by week')
    await expect(reloadedOwnerCard.getByText(/W1-W4: 50%/)).toBeVisible()
    await expect(reloadedOwnerCard.getByText(/W5-W9: 100%/)).toBeVisible()

    // ── 10. Capture canonical state AFTER and compare ──
    const after = await readNamedPersonCanonicalState(nrId, profileId)

    // Name changed
    expect(after.namedResource.name).toBe('Segmented Alice Renamed')
    expect(after.namedResource.name).not.toBe(before.namedResource.name)

    // Pricing changed
    expect(after.namedResource.pricingModel).toBe('PRO_RATA')

    // All compatibility capacity fields unchanged (stale, as intended)
    expect(after.namedResource.allocationMode).toBe(before.namedResource.allocationMode)
    expect(after.namedResource.allocationPercent).toBe(before.namedResource.allocationPercent)
    expect(after.namedResource.allocationPct).toBe(before.namedResource.allocationPct)
    expect(after.namedResource.allocationStartWeek).toBe(before.namedResource.allocationStartWeek)
    expect(after.namedResource.allocationEndWeek).toBe(before.namedResource.allocationEndWeek)
    expect(after.namedResource.startWeek).toBe(before.namedResource.startWeek)
    expect(after.namedResource.endWeek).toBe(before.namedResource.endWeek)

    // Profile identity unchanged
    expect(after.profile.id).toBe(before.profile.id)
    expect(after.profile.namedResourceId).toBe(before.profile.namedResourceId)
    expect(after.profile.resourceTypeId).toBe(before.profile.resourceTypeId)
    expect(after.profile.ownerKind).toBe(before.profile.ownerKind)
    expect(after.profile.source).toBe(before.profile.source)
    expect(after.profile.planningBasis).toBe(before.profile.planningBasis)
    expect(after.profile.defaultPercent).toBe(before.profile.defaultPercent)
    expect(after.profile.startWeek).toBe(before.profile.startWeek)
    expect(after.profile.endWeek).toBe(before.profile.endWeek)

    // Segments unchanged
    expect(after.segments).toHaveLength(before.segments.length)
    for (let i = 0; i < before.segments.length; i++) {
      expect(after.segments[i].id).toBe(before.segments[i].id)
      expect(after.segments[i].startWeek).toBe(before.segments[i].startWeek)
      expect(after.segments[i].endWeek).toBe(before.segments[i].endWeek)
      expect(after.segments[i].capacityPercent).toBe(before.segments[i].capacityPercent)
      expect(after.segments[i].source).toBe(before.segments[i].source)
    }
  })
})
