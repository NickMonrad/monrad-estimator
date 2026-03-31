export interface ScopeDocumentProps {
  project: {
    name: string
    customer: string | null
    description: string | null
    startDate: string | null
    endDate: string | null
  }
  sections: {
    cover: boolean
    scope: boolean
    effort: boolean
    timeline: boolean
    resourceProfile: boolean
    assumptions: boolean
    ganttChart?: boolean
  }
  effortData: any
  timelineData: any
  resourceProfileData: any
  epics: Array<{
    id: string
    name: string
    description?: string | null
    assumptions?: string | null
    isActive: boolean
    features: Array<{
      id: string
      name: string
      description?: string | null
      assumptions?: string | null
      isActive: boolean
      userStories?: Array<{
        id: string
        name: string
        description?: string | null
        assumptions?: string | null
        isActive: boolean
      }>
    }>
  }>
  generatedBy: string
  documentLabel: string
  tz?: string
}

function esc(s: string | null | undefined): string {
  if (!s) return ''
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  try {
    return new Date(dateStr).toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric' })
  } catch { return String(dateStr) }
}

function formatNum(val: number | null | undefined, decimals = 1): string {
  if (val == null) return '—'
  return Number(val).toFixed(decimals)
}

function hasContent(s: string | null | undefined): boolean {
  if (!s) return false
  const t = s.trim()
  if (!t || t === '<p></p>') return false
  return t.startsWith('<') ? t.replace(/<[^>]*>/g, '').trim().length > 0 : t.length > 0
}

// Render a field that may be plain text or TipTap HTML
function richField(content: string | null | undefined): string {
  if (!hasContent(content)) return ''
  const t = content!.trim()
  if (t.startsWith('<')) return t
  const escaped = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  return `<p>${escaped}</p>`
}

// ── Gantt chart SVG renderer ──────────────────────────────────────────────────

interface GanttEntry {
  featureId: string
  featureName: string
  epicId: string
  epicName: string
  epicOrder: number
  featureOrder: number
  startWeek: number
  durationWeeks: number
  timelineColour: string | null
}

interface TimelineData {
  startDate: string | null
  projectedEndDate: string | null
  entries: GanttEntry[]
  bufferWeeks: number
  onboardingWeeks: number
}

function renderGanttSvg(td: TimelineData): string {
  const ROW_H = 28
  const LABEL_W = 200
  const COL_W = 28
  const HEADER_H = 40
  const EPIC_HEADER_H = 24
  const PAD = 2

  const entries = td.entries ?? []
  if (entries.length === 0) return ''

  // Compute total weeks
  const maxEnd = Math.max(...entries.map(e => e.startWeek + e.durationWeeks))
  const totalWeeks = Math.max(4, Math.ceil(maxEnd) + 1)

  // Group by epic (sorted by epicOrder, features by featureOrder)
  const epicMap = new Map<string, { epicName: string; epicOrder: number; features: GanttEntry[] }>()
  for (const e of entries) {
    if (!epicMap.has(e.epicId)) epicMap.set(e.epicId, { epicName: e.epicName, epicOrder: e.epicOrder, features: [] })
    epicMap.get(e.epicId)!.features.push(e)
  }
  const epicsArr = [...epicMap.values()].sort((a, b) => a.epicOrder - b.epicOrder)
  for (const ep of epicsArr) ep.features.sort((a, b) => a.featureOrder - b.featureOrder)

  // Compute dimensions
  const totalRows = epicsArr.reduce((acc, ep) => acc + 1 + ep.features.length, 0)
  const svgW = LABEL_W + totalWeeks * COL_W
  const svgH = HEADER_H + totalRows * ROW_H

  // Date helpers
  function weekToDate(week: number): Date | null {
    if (!td.startDate) return null
    const d = new Date(td.startDate)
    d.setDate(d.getDate() + week * 7)
    return d
  }

  function monthLabel(d: Date): string {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${months[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`
  }

  // Build SVG parts
  const parts: string[] = []

  // Background
  parts.push(`<rect width="${svgW}" height="${svgH}" fill="white"/>`)

  // Week grid lines (behind everything)
  for (let w = 0; w <= totalWeeks; w++) {
    const x = LABEL_W + w * COL_W
    parts.push(`<line x1="${x}" y1="${HEADER_H}" x2="${x}" y2="${svgH}" stroke="#e5e7eb" stroke-width="1"/>`)
  }

  // Header row background
  parts.push(`<rect x="0" y="0" width="${svgW}" height="${HEADER_H}" fill="#f3f4f6"/>`)

  // Week/month labels in header
  if (td.startDate) {
    let lastMonth = -1
    for (let w = 0; w < totalWeeks; w++) {
      const d = weekToDate(w)
      if (!d) break
      const month = d.getMonth()
      if (month !== lastMonth) {
        lastMonth = month
        const x = LABEL_W + w * COL_W + 3
        parts.push(`<text x="${x}" y="${HEADER_H - 14}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="10" fill="#6b7280">${monthLabel(d)}</text>`)
        // tick mark at month boundary
        const lineX = LABEL_W + w * COL_W
        parts.push(`<line x1="${lineX}" y1="${HEADER_H - 8}" x2="${lineX}" y2="${HEADER_H}" stroke="#d1d5db" stroke-width="1"/>`)
      }
    }
  } else {
    for (let w = 0; w < totalWeeks; w += 2) {
      const x = LABEL_W + w * COL_W + 3
      parts.push(`<text x="${x}" y="${HEADER_H - 14}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="10" fill="#6b7280">Wk ${w + 1}</text>`)
    }
  }

  // Week numbers row (bottom of header)
  for (let w = 0; w < totalWeeks; w++) {
    const x = LABEL_W + w * COL_W
    parts.push(`<text x="${x + COL_W / 2}" y="${HEADER_H - 3}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="8" fill="#9ca3af" text-anchor="middle">${w + 1}</text>`)
  }

  // Render epic groups and feature rows
  let currentY = HEADER_H

  for (const ep of epicsArr) {
    // Epic header row
    parts.push(`<rect x="0" y="${currentY}" width="${svgW}" height="${EPIC_HEADER_H}" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1"/>`)
    parts.push(`<text x="8" y="${currentY + EPIC_HEADER_H / 2 + 4}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="11" font-weight="600" fill="#374151">${esc(ep.epicName)}</text>`)
    currentY += EPIC_HEADER_H

    // Feature rows
    ep.features.forEach((feat, fi) => {
      const rowBg = fi % 2 === 0 ? 'white' : '#fafafa'
      parts.push(`<rect x="0" y="${currentY}" width="${svgW}" height="${ROW_H}" fill="${rowBg}"/>`)

      // Feature name label (truncate to ~28 chars)
      const displayName = feat.featureName.length > 28 ? feat.featureName.slice(0, 27) + '…' : feat.featureName
      parts.push(`<text x="8" y="${currentY + ROW_H / 2 + 4}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="10" fill="#4b5563">${esc(displayName)}</text>`)

      // Bar
      const barX = LABEL_W + feat.startWeek * COL_W + PAD
      const barY = currentY + PAD
      const barW = Math.max(0, feat.durationWeeks * COL_W - PAD * 2)
      const barH = ROW_H - PAD * 2
      const colour = feat.timelineColour ?? '#3b82f6'
      parts.push(`<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="3" fill="${esc(colour)}" opacity="0.85"/>`)

      currentY += ROW_H
    })
  }

  // Left column separator line (drawn last so it sits on top)
  parts.push(`<line x1="${LABEL_W}" y1="0" x2="${LABEL_W}" y2="${svgH}" stroke="#d1d5db" stroke-width="1"/>`)

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}">${parts.join('')}</svg>`
  return `<div style="overflow-x:auto; margin: 0 0 16px 0">${svg}</div>`
}

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10pt; color: #333; line-height: 1.5; }
.cover-page { padding-top: 120px; min-height: 75vh; }
.cover-title { font-size: 26pt; font-weight: bold; color: #1d245b; margin-bottom: 10px; line-height: 1.4; }
.cover-subtitle { font-size: 14pt; color: #2c60f6; margin-bottom: 8px; line-height: 1.4; }
.cover-desc { font-size: 10pt; color: #333; margin-top: 16px; line-height: 1.5; }
.cover-meta { font-size: 9pt; color: #666; margin-top: 6px; }
.page-section { page-break-before: always; padding-top: 4px; }
.section-heading { font-size: 14pt; font-weight: bold; color: #1d245b; margin-bottom: 10px; margin-top: 6px; border-bottom: 2px solid #1d245b; padding-bottom: 4px; }
.section-label { font-size: 11pt; font-weight: bold; color: #1d245b; margin-bottom: 6px; margin-top: 14px; }
.section-label-muted { font-size: 11pt; font-weight: bold; color: #888; margin-bottom: 6px; margin-top: 14px; }
.subheading { font-size: 10.5pt; font-weight: bold; color: #333; margin-bottom: 4px; margin-top: 10px; }
.body-text { font-size: 10pt; color: #333; margin-bottom: 4px; }
table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 9pt; }
th { background: #1d245b; color: #fff; font-weight: bold; padding: 6px 8px; text-align: left; }
th.r { text-align: right; }
td { color: #333; padding: 5px 8px; border-bottom: 1px solid #e0e0e0; vertical-align: top; }
td.r { text-align: right; }
tr.alt td { background: #f5f5f5; }
tr.epic-row td { background: #ebebeb; font-weight: bold; }
tr.feat-row td { background: #f5f5f5; font-weight: bold; padding-left: 20px; }
tr.feat-row td:not(:first-child) { padding-left: 8px; }
tr.res-row td:first-child { padding-left: 36px; }
tr.total-row td { background: #e0e0e0; font-weight: bold; border-top: 2px solid #ccc; }
tr.overhead-row td { color: #666; }
.scope-epic { margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #e0e0e0; page-break-inside: avoid; }
.scope-feat { margin-top: 8px; padding: 10px; border: 1px solid #e0e0e0; page-break-inside: avoid; }
.scope-feat.alt { background: #f5f5f5; }
.feat-title { font-size: 10pt; font-weight: bold; margin-bottom: 2px; }
.meta-text { font-size: 9pt; color: #666; margin-bottom: 4px; }
.detail-block { margin-top: 6px; }
.detail-label { font-size: 9pt; font-weight: bold; color: #1d245b; margin-bottom: 2px; }
.detail-text { font-size: 9pt; color: #333; line-height: 1.4; }
.bullet { font-size: 9pt; color: #333; margin-left: 10px; margin-bottom: 2px; }
.empty-state { font-size: 9pt; color: #888; margin-top: 6px; }
.muted .feat-title, .muted .meta-text, .muted .detail-label,
.muted .detail-text, .muted .bullet, .muted .empty-state,
.muted .subheading { color: #bbb !important; }
.rich p { margin-bottom: 4px; }
.rich ul { padding-left: 1.2em; margin-bottom: 4px; }
.rich ol { padding-left: 1.2em; margin-bottom: 4px; }
.rich strong { font-weight: bold; }
.rich em { font-style: italic; }
.rich li { margin-bottom: 2px; }
.overview-content { font-size: 10pt; color: #333; line-height: 1.5; margin-bottom: 20px; }
.overview-content p { margin-bottom: 6px; }
.overview-content ul { padding-left: 1.2em; margin-bottom: 6px; }
.overview-content ol { padding-left: 1.2em; margin-bottom: 6px; }
.overview-content strong { font-weight: bold; }
.overview-content em { font-style: italic; }
.assumption-item { margin-bottom: 10px; page-break-inside: avoid; }
.assumption-label { font-size: 9pt; font-weight: bold; color: #333; margin-bottom: 3px; }
.assumption-text { font-size: 8pt; color: #666; line-height: 1.5; }
.assumption-text p { margin-bottom: 3px; }
.assumption-text ul { padding-left: 1.2em; }
@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page-section { page-break-before: always; }
}
`

export function renderScopeDocumentHtml(props: ScopeDocumentProps): string {
  const { project, sections, effortData, timelineData, resourceProfileData, epics, generatedBy, documentLabel, tz } = props

  const now = new Date()
  const tzOpts: Intl.DateTimeFormatOptions = tz ? { timeZone: tz } : {}
  const today = now.toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric', ...tzOpts })
  const nowTime = now.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false, ...tzOpts })

  const inScopeEpics = epics.filter(e => e.isActive)
  const outOfScopeEpics = epics.filter(e => !e.isActive)
  const partiallyOut = inScopeEpics
    .map(e => ({ ...e, features: e.features.filter(f => !f.isActive) }))
    .filter(e => e.features.length > 0)

  // ── Effort map ────────────────────────────────────────────────
  type EpicE = { epicName: string; totalHours: number; totalDays: number; features: Map<string, FeatE> }
  type FeatE = { featureName: string; totalHours: number; totalDays: number; resources: { name: string; hours: number; days: number }[] }
  const epicMap = new Map<string, EpicE>()
  for (const row of (resourceProfileData?.resourceRows ?? [])) {
    for (const epic of (row.epics ?? [])) {
      if (!epicMap.has(epic.epicId)) epicMap.set(epic.epicId, { epicName: epic.epicName, totalHours: 0, totalDays: 0, features: new Map() })
      const ee = epicMap.get(epic.epicId)!
      for (const feat of (epic.features ?? [])) {
        if (feat.hours <= 0) continue
        if (!ee.features.has(feat.featureId)) ee.features.set(feat.featureId, { featureName: feat.featureName, totalHours: 0, totalDays: 0, resources: [] })
        const fe = ee.features.get(feat.featureId)!
        fe.resources.push({ name: row.name, hours: feat.hours, days: feat.days })
        fe.totalHours += feat.hours; fe.totalDays += feat.days
      }
    }
  }
  for (const [, ee] of epicMap) {
    let h = 0, d = 0
    for (const [, fe] of ee.features) { h += fe.totalHours; d += fe.totalDays }
    ee.totalHours = h; ee.totalDays = d
  }
  const epicRows = [...epicMap.values()].filter(e => e.totalHours > 0)
  const hasOverhead = (resourceProfileData?.overheadRows ?? []).length > 0

  // ── Assumptions ───────────────────────────────────────────────
  const assumptions: { label: string; text: string }[] = []
  for (const epic of epics) {
    if (!epic.isActive) continue
    if (hasContent(epic.assumptions)) assumptions.push({ label: epic.name, text: epic.assumptions! })
    for (const feat of epic.features) {
      if (!feat.isActive) continue
      if (hasContent(feat.assumptions)) assumptions.push({ label: `${epic.name} › ${feat.name}`, text: feat.assumptions! })
      for (const story of feat.userStories ?? []) {
        if (!story.isActive) continue
        if (hasContent(story.assumptions)) assumptions.push({ label: `${feat.name} › ${story.name}`, text: story.assumptions! })
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────
  type Epic = ScopeDocumentProps['epics'][0]
  type Feature = Epic['features'][0]

  function featureCard(feat: Feature, muted: boolean, alt: boolean): string {
    const stories = muted ? (feat.userStories ?? []) : (feat.userStories ?? []).filter(s => s.isActive)
    const mc = muted ? ' muted' : ''
    return `
    <div class="scope-feat${alt ? ' alt' : ''}${mc}">
      <div class="feat-title">${esc(feat.name)}</div>
      <div class="meta-text">${stories.length} ${stories.length === 1 ? 'story' : 'stories'}</div>
      ${hasContent(feat.description) ? `<div class="detail-block"><div class="detail-label">Description</div><div class="detail-text rich">${richField(feat.description)}</div></div>` : ''}
      ${hasContent(feat.assumptions) ? `<div class="detail-block"><div class="detail-label">Assumptions</div><div class="detail-text rich">${richField(feat.assumptions)}</div></div>` : ''}
      ${stories.length > 0
        ? `<div class="detail-block"><div class="detail-label">Stories</div>${stories.map(s => `<div class="bullet">• ${esc(s.name)}</div>`).join('')}</div>`
        : `<div class="empty-state">No stories listed.</div>`}
    </div>`
  }

  function epicBlock(epic: Epic, feats: Feature[], muted = false, suffix = ''): string {
    const mc = muted ? ' muted' : ''
    return `
    <div class="scope-epic${mc}">
      <div class="subheading">${esc(epic.name)}${suffix ? ' ' + suffix : ''}</div>
      ${hasContent(epic.description) ? `<div class="detail-block"><div class="detail-label">Epic Description</div><div class="detail-text rich">${richField(epic.description)}</div></div>` : ''}
      ${hasContent(epic.assumptions) ? `<div class="detail-block"><div class="detail-label">Epic Assumptions</div><div class="detail-text rich">${richField(epic.assumptions)}</div></div>` : ''}
      ${feats.length > 0 ? feats.map((f, i) => featureCard(f, muted, i % 2 === 1)).join('') : `<div class="empty-state">No features listed.</div>`}
    </div>`
  }

  // ── Sections ──────────────────────────────────────────────────
  const coverHtml = sections.cover ? `
  <div class="cover-page">
    <div class="cover-title">${esc(project.name)}</div>
    ${project.customer ? `<div class="cover-subtitle">${esc(project.customer)}</div>` : ''}
    <div class="cover-subtitle">Scope Document</div>
    <div style="margin-top:40px">
      <div class="cover-meta">Prepared by ${esc(generatedBy)}</div>
      <div class="cover-meta">Generated: ${today} at ${nowTime}</div>
      <div class="cover-meta">Document: ${esc(documentLabel)}</div>
      ${project.startDate ? `<div class="cover-meta">Projected Start: ${formatDate(project.startDate)}</div>` : ''}
      ${project.endDate ? `<div class="cover-meta">Projected End: ${formatDate(project.endDate)}</div>` : ''}
    </div>
  </div>` : ''

  const overviewHtml = hasContent(project.description) ? `
  <div class="page-section">
    <div class="section-heading">Overview</div>
    <div class="overview-content rich">${richField(project.description)}</div>
  </div>` : ''

  const scopeHtml = sections.scope && epics.length > 0 ? `
  <div class="page-section">
    <div class="section-heading">Scope Summary</div>
    <div class="section-label">In Scope</div>
    ${inScopeEpics.length === 0 ? '<div class="body-text">No active epics.</div>' : inScopeEpics.map(e => epicBlock(e, e.features.filter(f => f.isActive))).join('')}
    ${outOfScopeEpics.length > 0 || partiallyOut.length > 0 ? `
      <div class="section-label-muted">Out of Scope</div>
      ${outOfScopeEpics.map(e => epicBlock(e, e.features, true)).join('')}
      ${partiallyOut.map(e => epicBlock(e, e.features, true, '(inactive features)')).join('')}
    ` : ''}
  </div>` : ''

  const effortHtml = sections.effort && effortData ? `
  <div class="page-section">
    <div class="section-heading">Effort Breakdown</div>
    <table>
      <thead><tr><th>Name</th><th class="r" style="width:80px">Hours</th><th class="r" style="width:80px">Days</th></tr></thead>
      <tbody>
        ${epicRows.length === 0 ? '<tr><td colspan="3">No effort data available.</td></tr>' : epicRows.map(ee => `
          <tr class="epic-row"><td>${esc(ee.epicName)}</td><td class="r">${formatNum(ee.totalHours)}</td><td class="r">${formatNum(ee.totalDays)}</td></tr>
          ${[...ee.features.values()].map(fe => `
            <tr class="feat-row"><td>${esc(fe.featureName)}</td><td class="r">${formatNum(fe.totalHours)}</td><td class="r">${formatNum(fe.totalDays)}</td></tr>
            ${fe.resources.map(r => `<tr class="res-row"><td>${esc(r.name)}</td><td class="r">${formatNum(r.hours)}</td><td class="r">${formatNum(r.days)}</td></tr>`).join('')}
          `).join('')}
        `).join('')}
        <tr class="total-row"><td>Total</td><td class="r">${formatNum(effortData.totalHours)}</td><td class="r">${formatNum(effortData.totalDays)}</td></tr>
      </tbody>
    </table>
    ${hasOverhead ? `
      <div class="section-label">Governance &amp; Overhead</div>
      <table>
        <thead><tr><th>Item</th><th style="width:120px">Type</th><th class="r" style="width:80px">Value</th><th class="r" style="width:80px">Days</th></tr></thead>
        <tbody>
          ${(resourceProfileData.overheadRows as any[]).map((oh: any, i: number) => `
            <tr class="${i % 2 === 1 ? 'alt' : ''}">
              <td>${esc(oh.name)}</td>
              <td>${oh.type === 'PERCENTAGE' ? '% of effort' : esc(oh.type)}</td>
              <td class="r">${oh.type === 'PERCENTAGE' ? `${oh.value}%` : formatNum(oh.value)}</td>
              <td class="r">${formatNum(oh.computedDays)}</td>
            </tr>`).join('')}
        </tbody>
      </table>` : ''}
  </div>` : ''

  const timelineHtml = sections.timeline && timelineData ? `
  <div class="page-section">
    <div class="section-heading">Timeline Summary</div>
    <div style="margin-bottom:16px">
      <div class="body-text">Projected Start: ${formatDate(timelineData.startDate)}</div>
      <div class="body-text">Projected End: ${formatDate(timelineData.projectedEndDate)}</div>
    </div>
    <table>
      <thead><tr><th>Feature</th><th>Epic</th><th style="width:100px">Start Date</th><th style="width:100px">End Date</th><th style="width:80px">Duration</th></tr></thead>
      <tbody>
        ${(timelineData.entries ?? []).map((entry: any, i: number) => `
          <tr class="${i % 2 === 1 ? 'alt' : ''}">
            <td>${esc(entry.featureName) || '—'}</td>
            <td>${esc(entry.epicName) || '—'}</td>
            <td>${entry.startDate ? formatDate(entry.startDate) : (entry.startWeek != null ? `Wk ${entry.startWeek}` : '—')}</td>
            <td>${entry.endDate ? formatDate(entry.endDate) : '—'}</td>
            <td>${entry.durationWeeks != null ? `${formatNum(entry.durationWeeks)} wks` : '—'}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>` : ''

  const hasCost = (resourceProfileData?.summary?.hasCost) ?? false
  const resourceHtml = sections.resourceProfile && resourceProfileData ? `
  <div class="page-section">
    <div class="section-heading">Resource Profile</div>
    <table>
      <thead><tr><th>Role</th><th style="width:120px">Category</th><th class="r" style="width:80px">Hours</th><th class="r" style="width:80px">Days</th>${hasCost ? '<th class="r" style="width:90px">Cost</th>' : ''}</tr></thead>
      <tbody>
        ${(resourceProfileData.resourceRows ?? []).map((row: any, i: number) => `
          <tr class="${i % 2 === 1 ? 'alt' : ''}">
            <td>${esc(row.name) || '—'}</td><td>${esc(row.category) || '—'}</td>
            <td class="r">${formatNum(row.totalHours)}</td><td class="r">${formatNum(row.totalDays)}</td>
            ${hasCost ? `<td class="r">${row.estimatedCost != null ? `$${formatNum(row.estimatedCost, 0)}` : '—'}</td>` : ''}
          </tr>`).join('')}
        ${(resourceProfileData.overheadRows ?? []).map((row: any) => `
          <tr class="overhead-row">
            <td>${esc(row.name)}</td><td>Overhead</td><td class="r">—</td><td class="r">${formatNum(row.computedDays)}</td>
            ${hasCost ? `<td class="r">${row.estimatedCost != null ? `$${formatNum(row.estimatedCost, 0)}` : '—'}</td>` : ''}
          </tr>`).join('')}
        ${resourceProfileData.summary ? `
          <tr class="total-row">
            <td>Total</td><td></td>
            <td class="r">${formatNum(resourceProfileData.summary.totalHours)}</td>
            <td class="r">${formatNum(resourceProfileData.summary.totalDays)}</td>
            ${hasCost ? `<td class="r">${resourceProfileData.summary.totalCost != null ? `$${formatNum(resourceProfileData.summary.totalCost, 0)}` : '—'}</td>` : ''}
          </tr>` : ''}
      </tbody>
    </table>
  </div>` : ''

  const assumptionsHtml = sections.assumptions && assumptions.length > 0 ? `
  <div class="page-section">
    <div class="section-heading">Assumptions</div>
    ${assumptions.map(item => `
      <div class="assumption-item">
        <div class="assumption-label">${esc(item.label)}</div>
        <div class="assumption-text rich">${richField(item.text)}</div>
      </div>`).join('')}
  </div>` : ''

  // ── Gantt chart section ───────────────────────────────────────
  let ganttHtml = ''
  if (sections.ganttChart && (timelineData as TimelineData | null)?.entries?.length) {
    const td = timelineData as TimelineData
    const maxEnd = Math.max(...td.entries.map((e: GanttEntry) => e.startWeek + e.durationWeeks))
    const totalWeeks = Math.max(4, Math.ceil(maxEnd) + 1)
    const startDateLabel = td.startDate
      ? ` starting ${formatDate(td.startDate)}`
      : ''
    ganttHtml = `
  <div class="page-section">
    <div class="section-heading">Project Timeline</div>
    <p style="font-size:12px;color:#6b7280;margin-bottom:12px;">
      Gantt chart showing feature scheduling across ${totalWeeks} weeks${startDateLabel}.
    </p>
    ${renderGanttSvg(td)}
  </div>`
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(project.name)} — Scope Document</title>
  <style>${CSS}</style>
</head>
<body>
${coverHtml}
${overviewHtml}
${scopeHtml}
${effortHtml}
${ganttHtml}
${timelineHtml}
${resourceHtml}
${assumptionsHtml}
</body>
</html>`
}
