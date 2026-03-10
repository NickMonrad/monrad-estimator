import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'

// LAB3 brand palette (hex literals used directly to avoid react-pdf StyleSheet issues)
// navy: #1d245b  blue: #2c60f6  green: #62c481  darkGray: #333333
// midGray: #666666  lightGray: #f5f5f5  borderGray: #e0e0e0

const C = {
  navy:       '#1d245b',
  blue:       '#2c60f6',
  green:      '#62c481',
  darkGray:   '#333333',
  midGray:    '#666666',
  lightGray:  '#f5f5f5',
  borderGray: '#e0e0e0',
  white:      '#ffffff',
}

const styles = StyleSheet.create({
  page: { padding: 52, fontFamily: 'Helvetica', fontSize: 10, color: '#333333', lineHeight: 1.6 },
  coverPage: { flexDirection: 'column', justifyContent: 'center', flex: 1 },
  coverTitle: { fontSize: 28, fontFamily: 'Helvetica-Bold', color: '#1d245b', marginBottom: 16 },
  coverSubtitle: { fontSize: 16, color: '#2c60f6', marginBottom: 8 },
  coverMeta: { fontSize: 10, color: '#666666', marginTop: 40 },
  // Left accent bar — avoids react-pdf border-bottom height calc bug on wrapping text
  sectionHeadingWrapper: {
    marginTop: 24,
    marginBottom: 14,
    paddingLeft: 10,
    paddingTop: 6,
    paddingBottom: 6,
    borderLeftWidth: 4,
    borderLeftColor: '#2c60f6',
  },
  sectionHeading: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: '#1d245b', lineHeight: 1.6 },
  sectionLabel: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#1d245b', marginBottom: 6, marginTop: 14 },
  sectionLabelMuted: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#666666', marginBottom: 6, marginTop: 14 },
  subheading: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: '#333333', marginBottom: 4, marginTop: 10 },
  bodyText: { fontSize: 10, color: '#333333', marginBottom: 4, lineHeight: 1.5 },
  table: { marginBottom: 12 },
  tableHeader: { flexDirection: 'row', backgroundColor: '#1d245b', paddingVertical: 6, paddingHorizontal: 8 },
  tableRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e0e0e0', paddingVertical: 5, paddingHorizontal: 8 },
  tableRowAlt: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e0e0e0', paddingVertical: 5, paddingHorizontal: 8, backgroundColor: '#f5f5f5' },
  tableRowTotal: { flexDirection: 'row', borderTopWidth: 2, borderTopColor: '#1d245b', paddingVertical: 6, paddingHorizontal: 8, backgroundColor: '#f5f5f5' },
  tableRowSubtotal: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#e0e0e0', paddingVertical: 5, paddingHorizontal: 8, backgroundColor: '#eeeeee' },
  th: { fontFamily: 'Helvetica-Bold', fontSize: 9, color: '#ffffff' },
  td: { fontSize: 9, color: '#333333' },
  tdBold: { fontSize: 9, color: '#333333', fontFamily: 'Helvetica-Bold' },
  col1: { flex: 3 },
  col2: { flex: 2 },
  col3: { flex: 1, textAlign: 'right' },
  col4: { flex: 1, textAlign: 'right' },
  col5: { flex: 1, textAlign: 'right' },
  pageNumber: { position: 'absolute', bottom: 28, right: 52, fontSize: 9, color: '#666666' },
  footer: { position: 'absolute', bottom: 28, left: 52, fontSize: 9, color: '#666666' },
  storyItem: { fontSize: 9, color: '#666666', marginLeft: 16, marginBottom: 2 },
  inactiveText: { color: '#aaaaaa' },
})

export interface ScopeDocumentProps {
  project: {
    name: string
    customer: string | null
    description: string | null
    startDate: string | null
  }
  sections: {
    cover: boolean
    scope: boolean
    effort: boolean
    timeline: boolean
    resourceProfile: boolean
    assumptions: boolean
  }
  effortData: any   // from GET /api/projects/:id/effort
  timelineData: any // from GET /api/projects/:id/timeline
  resourceProfileData: any // from GET /api/projects/:id/resource-profile
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
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  try {
    return new Date(dateStr).toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric' })
  } catch {
    return dateStr
  }
}

function formatNum(val: number | null | undefined, decimals = 1): string {
  if (val == null) return '—'
  return Number(val).toFixed(decimals)
}

export default function ScopeDocument({
  project,
  sections,
  effortData,
  timelineData,
  resourceProfileData,
  epics,
}: ScopeDocumentProps) {
  const today = new Date().toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric' })

  const footerText = (pageNumber: number, totalPages: number) =>
    `${project.name} | Page ${pageNumber} of ${totalPages}`

  // ── Scope: split active vs inactive ──────────────────────────
  const inScopeEpics = epics.filter(e => e.isActive)
  const outOfScopeFullEpics = epics.filter(e => !e.isActive)
  const partiallyOutOfScope = inScopeEpics
    .map(e => ({ ...e, features: e.features.filter(f => !f.isActive) }))
    .filter(e => e.features.length > 0)

  return (
    <Document>
      {/* ── Cover Page ── */}
      {sections.cover && (
        <Page size="A4" style={styles.page}>
          <View style={styles.coverPage}>
            <Text style={styles.coverTitle}>{project.name}</Text>
            {project.customer && (
              <Text style={styles.coverSubtitle}>{project.customer}</Text>
            )}
            <Text style={styles.coverSubtitle}>Scope Document</Text>
            {project.description && (
              <Text style={{ ...styles.bodyText, marginTop: 16 }}>{project.description}</Text>
            )}
            <Text style={styles.coverMeta}>Prepared by Monrad Estimator</Text>
            <Text style={styles.coverMeta}>Generated: {today}</Text>
            {project.startDate && (
              <Text style={styles.coverMeta}>Projected Start: {formatDate(project.startDate)}</Text>
            )}
          </View>
          <Text
            style={styles.footer}
            fixed
            render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
              footerText(pageNumber, totalPages)
            }
          />
          <Text
            style={styles.pageNumber}
            fixed
            render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
              `${pageNumber} / ${totalPages}`
            }
          />
        </Page>
      )}

      {/* ── Scope Summary ── */}
      {sections.scope && epics.length > 0 && (
        <Page size="A4" style={styles.page}>
          <View style={styles.sectionHeadingWrapper}><Text style={styles.sectionHeading}>Scope Summary</Text></View>

          {/* ── In Scope ── */}
          <Text style={styles.sectionLabel}>In Scope</Text>
          {inScopeEpics.length === 0 && (
            <Text style={styles.bodyText}>No active epics.</Text>
          )}
          {inScopeEpics.map((epic) => {
            const activeFeatures = epic.features.filter(f => f.isActive)
            return (
              <View key={epic.id}>
                <Text style={styles.subheading}>{epic.name}</Text>
                {epic.description ? <Text style={styles.bodyText}>{epic.description}</Text> : null}
                {activeFeatures.length > 0 && (
                  <View style={styles.table}>
                    <View style={styles.tableHeader}>
                      <Text style={[styles.th, styles.col1]}>Feature</Text>
                      <Text style={[styles.th, styles.col2]}>Description</Text>
                      <Text style={[styles.th, styles.col3]}>Stories</Text>
                    </View>
                    {activeFeatures.map((feature, fi) => {
                      const activeStories = (feature.userStories ?? []).filter(s => s.isActive)
                      return (
                        <View key={feature.id}>
                          <View style={fi % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                            <Text style={[styles.td, styles.col1]}>{feature.name}</Text>
                            <Text style={[styles.td, styles.col2]}>{feature.description ?? '—'}</Text>
                            <Text style={[styles.td, styles.col3]}>{activeStories.length}</Text>
                          </View>
                          {feature.assumptions ? (
                            <View style={fi % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                              <Text style={[styles.storyItem, { flex: 6, color: C.midGray }]}>
                                Assumptions: {feature.assumptions}
                              </Text>
                            </View>
                          ) : null}
                          {activeStories.map(story => (
                            <View key={story.id} style={styles.tableRow}>
                              <Text style={[styles.storyItem, { flex: 6 }]}>• {story.name}</Text>
                            </View>
                          ))}
                        </View>
                      )
                    })}
                  </View>
                )}
              </View>
            )
          })}

          {/* ── Out of Scope ── */}
          {(outOfScopeFullEpics.length > 0 || partiallyOutOfScope.length > 0) && (
            <View>
              <Text style={styles.sectionLabelMuted}>Out of Scope</Text>

              {/* Fully inactive epics */}
              {outOfScopeFullEpics.map((epic) => (
                <View key={epic.id}>
                  <Text style={[styles.subheading, styles.inactiveText]}>{epic.name}</Text>
                  {epic.description ? (
                    <Text style={[styles.bodyText, styles.inactiveText]}>{epic.description}</Text>
                  ) : null}
                  {epic.features.length > 0 && (
                    <View style={styles.table}>
                      <View style={styles.tableHeader}>
                        <Text style={[styles.th, styles.col1]}>Feature</Text>
                        <Text style={[styles.th, styles.col2]}>Description</Text>
                        <Text style={[styles.th, styles.col3]}>Stories</Text>
                      </View>
                      {epic.features.map((feature, fi) => (
                        <View key={feature.id}>
                          <View style={fi % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                            <Text style={[styles.td, styles.col1, styles.inactiveText]}>{feature.name}</Text>
                            <Text style={[styles.td, styles.col2, styles.inactiveText]}>{feature.description ?? '—'}</Text>
                            <Text style={[styles.td, styles.col3, styles.inactiveText]}>{(feature.userStories ?? []).length}</Text>
                          </View>
                          {feature.assumptions ? (
                            <View style={fi % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                              <Text style={[styles.storyItem, { flex: 6, color: C.midGray }]}>
                                Assumptions: {feature.assumptions}
                              </Text>
                            </View>
                          ) : null}
                          {(feature.userStories ?? []).map(story => (
                            <View key={story.id} style={styles.tableRow}>
                              <Text style={[styles.storyItem, { flex: 6, color: C.midGray }]}>• {story.name}</Text>
                            </View>
                          ))}
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              ))}

              {/* Active epics that have inactive features */}
              {partiallyOutOfScope.map((epic) => (
                <View key={`partial-${epic.id}`}>
                  <Text style={[styles.subheading, styles.inactiveText]}>{epic.name} (inactive features)</Text>
                  {epic.description ? (
                    <Text style={[styles.bodyText, styles.inactiveText]}>{epic.description}</Text>
                  ) : null}
                  <View style={styles.table}>
                    <View style={styles.tableHeader}>
                      <Text style={[styles.th, styles.col1]}>Feature</Text>
                      <Text style={[styles.th, styles.col2]}>Description</Text>
                      <Text style={[styles.th, styles.col3]}>Stories</Text>
                    </View>
                    {epic.features.map((feature, fi) => (
                      <View key={feature.id}>
                        <View style={fi % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                          <Text style={[styles.td, styles.col1, styles.inactiveText]}>{feature.name}</Text>
                          <Text style={[styles.td, styles.col2, styles.inactiveText]}>{feature.description ?? '—'}</Text>
                          <Text style={[styles.td, styles.col3, styles.inactiveText]}>{(feature.userStories ?? []).length}</Text>
                        </View>
                        {feature.assumptions ? (
                          <View style={fi % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                            <Text style={[styles.storyItem, { flex: 6, color: C.midGray }]}>
                              Assumptions: {feature.assumptions}
                            </Text>
                          </View>
                        ) : null}
                        {(feature.userStories ?? []).map(story => (
                          <View key={story.id} style={styles.tableRow}>
                            <Text style={[styles.storyItem, { flex: 6, color: C.midGray }]}>• {story.name}</Text>
                          </View>
                        ))}
                      </View>
                    ))}
                  </View>
                </View>
              ))}
            </View>
          )}

          <Text
            style={styles.footer}
            fixed
            render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
              footerText(pageNumber, totalPages)
            }
          />
          <Text
            style={styles.pageNumber}
            fixed
            render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
              `${pageNumber} / ${totalPages}`
            }
          />
        </Page>
      )}

      {/* ── Effort Breakdown ── */}
      {sections.effort && effortData && (() => {
        // Build epic-first map from resourceProfileData.resourceRows
        const epicMap = new Map<string, {
          epicName: string
          totalHours: number
          totalDays: number
          features: Map<string, {
            featureName: string
            totalHours: number
            totalDays: number
            resources: { name: string; hours: number; days: number }[]
          }>
        }>()

        for (const row of (resourceProfileData?.resourceRows ?? [])) {
          for (const epic of (row.epics ?? [])) {
            if (!epicMap.has(epic.epicId)) {
              epicMap.set(epic.epicId, { epicName: epic.epicName, totalHours: 0, totalDays: 0, features: new Map() })
            }
            const epicEntry = epicMap.get(epic.epicId)!
            for (const feat of (epic.features ?? [])) {
              if (feat.hours <= 0) continue
              if (!epicEntry.features.has(feat.featureId)) {
                epicEntry.features.set(feat.featureId, { featureName: feat.featureName, totalHours: 0, totalDays: 0, resources: [] })
              }
              const featEntry = epicEntry.features.get(feat.featureId)!
              featEntry.resources.push({ name: row.name, hours: feat.hours, days: feat.days })
              featEntry.totalHours += feat.hours
              featEntry.totalDays += feat.days
            }
          }
        }
        // Recalculate epic totals from features
        for (const [, epicEntry] of epicMap) {
          let h = 0, d = 0
          for (const [, feat] of epicEntry.features) { h += feat.totalHours; d += feat.totalDays }
          epicEntry.totalHours = h
          epicEntry.totalDays = d
        }
        const epicRows = [...epicMap.values()].filter(e => e.totalHours > 0)

        const hasOverhead = (resourceProfileData?.overheadRows ?? []).length > 0

        return (
          <Page size="A4" style={styles.page}>
            <View style={styles.sectionHeadingWrapper}><Text style={styles.sectionHeading}>Effort Breakdown</Text></View>

            {/* Part 1 — Effort by Epic / Feature */}
            <View style={styles.table}>
              <View style={styles.tableHeader}>
                <Text style={[styles.th, styles.col1]}>Name</Text>
                <Text style={[styles.th, styles.col3]}>Hours</Text>
                <Text style={[styles.th, styles.col4]}>Days</Text>
              </View>

              {epicRows.length === 0 ? (
                <View style={styles.tableRow}>
                  <Text style={[styles.td, styles.col1]}>No effort data available.</Text>
                </View>
              ) : (
                epicRows.map((epic, ei) => (
                  <View key={ei}>
                    {/* Epic row */}
                    <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.borderGray, paddingVertical: 6, paddingHorizontal: 8, backgroundColor: C.lightGray }}>
                      <Text style={[styles.tdBold, styles.col1]}>{epic.epicName}</Text>
                      <Text style={[styles.tdBold, styles.col3]}>{formatNum(epic.totalHours)}</Text>
                      <Text style={[styles.tdBold, styles.col4]}>{formatNum(epic.totalDays)}</Text>
                    </View>
                    {/* Feature rows */}
                    {[...epic.features.values()].map((feat, fi) => (
                      <View key={fi}>
                        <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.borderGray, paddingVertical: 5, paddingLeft: 20, paddingRight: 8, backgroundColor: C.lightGray }}>
                          <Text style={[{ fontSize: 9, color: C.darkGray, fontFamily: 'Helvetica-Bold' }, styles.col1]}>{feat.featureName}</Text>
                          <Text style={[{ fontSize: 9, color: C.darkGray, fontFamily: 'Helvetica-Bold' }, styles.col3]}>{formatNum(feat.totalHours)}</Text>
                          <Text style={[{ fontSize: 9, color: C.darkGray, fontFamily: 'Helvetica-Bold' }, styles.col4]}>{formatNum(feat.totalDays)}</Text>
                        </View>
                        {/* Resource rows */}
                        {feat.resources.map((res, ri) => (
                          <View key={ri} style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.borderGray, paddingVertical: 4, paddingLeft: 36, paddingRight: 8 }}>
                            <Text style={[styles.td, styles.col1]}>{res.name}</Text>
                            <Text style={[styles.td, styles.col3]}>{formatNum(res.hours)}</Text>
                            <Text style={[styles.td, styles.col4]}>{formatNum(res.days)}</Text>
                          </View>
                        ))}
                      </View>
                    ))}
                  </View>
                ))
              )}

              {/* Grand total */}
              <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.borderGray, paddingVertical: 6, paddingHorizontal: 8, backgroundColor: C.lightGray }}>
                <Text style={[styles.tdBold, styles.col1]}>Total</Text>
                <Text style={[styles.tdBold, styles.col3]}>{formatNum(effortData.totalHours)}</Text>
                <Text style={[styles.tdBold, styles.col4]}>{formatNum(effortData.totalDays)}</Text>
              </View>
            </View>

            {/* Part 2 — Governance & Overhead */}
            {hasOverhead && (
              <View style={{ marginTop: 16 }}>
                <Text style={styles.sectionLabel}>Governance &amp; Overhead</Text>
                <View style={styles.table}>
                  <View style={styles.tableHeader}>
                    <Text style={[styles.th, styles.col1]}>Item</Text>
                    <Text style={[styles.th, styles.col2]}>Type</Text>
                    <Text style={[styles.th, styles.col3]}>Value</Text>
                    <Text style={[styles.th, styles.col4]}>Days</Text>
                  </View>
                  {(resourceProfileData.overheadRows as Array<{ name: string; type: string; value: number; computedDays: number; estimatedCost: number | null }>).map((oh, i) => (
                    <View key={i} style={i % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                      <Text style={[styles.td, styles.col1]}>{oh.name}</Text>
                      <Text style={[styles.td, styles.col2]}>{oh.type === 'PERCENTAGE' ? '% of effort' : oh.type}</Text>
                      <Text style={[styles.td, styles.col3]}>{oh.type === 'PERCENTAGE' ? `${oh.value}%` : formatNum(oh.value)}</Text>
                      <Text style={[styles.td, styles.col4]}>{formatNum(oh.computedDays)}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            <Text
              style={styles.footer}
              fixed
              render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
                footerText(pageNumber, totalPages)
              }
            />
            <Text
              style={styles.pageNumber}
              fixed
              render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
                `${pageNumber} / ${totalPages}`
              }
            />
          </Page>
        )
      })()}

      {/* ── Timeline Summary ── */}
      {sections.timeline && timelineData && (
        <Page size="A4" style={styles.page}>
          <View style={styles.sectionHeadingWrapper}><Text style={styles.sectionHeading}>Timeline Summary</Text></View>

          {/* Start / end dates from top-level fields */}
          <View style={{ marginBottom: 16 }}>
            <Text style={styles.bodyText}>
              Projected Start: {formatDate(timelineData.startDate)}
            </Text>
            <Text style={styles.bodyText}>
              Projected End: {formatDate(timelineData.projectedEndDate)}
            </Text>
          </View>

          <View style={styles.table}>
            <View style={styles.tableHeader}>
              <Text style={[styles.th, styles.col1]}>Feature</Text>
              <Text style={[styles.th, styles.col2]}>Epic</Text>
              <Text style={[styles.th, styles.col3]}>Start Date</Text>
              <Text style={[styles.th, styles.col4]}>End Date</Text>
              <Text style={[styles.th, styles.col5]}>Duration</Text>
            </View>
            {(timelineData.entries ?? []).map((entry: any, i: number) => (
              <View key={i} style={i % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                <Text style={[styles.td, styles.col1]}>{entry.featureName ?? '—'}</Text>
                <Text style={[styles.td, styles.col2]}>{entry.epicName ?? '—'}</Text>
                <Text style={[styles.td, styles.col3]}>
                  {entry.startDate ? formatDate(entry.startDate) : (entry.startWeek != null ? `Wk ${entry.startWeek}` : '—')}
                </Text>
                <Text style={[styles.td, styles.col4]}>
                  {entry.endDate ? formatDate(entry.endDate) : '—'}
                </Text>
                <Text style={[styles.td, styles.col5]}>
                  {entry.durationWeeks != null ? `${formatNum(entry.durationWeeks)} wks` : '—'}
                </Text>
              </View>
            ))}
          </View>

          <Text
            style={styles.footer}
            fixed
            render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
              footerText(pageNumber, totalPages)
            }
          />
          <Text
            style={styles.pageNumber}
            fixed
            render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
              `${pageNumber} / ${totalPages}`
            }
          />
        </Page>
      )}

      {/* ── Resource Profile ── */}
      {sections.resourceProfile && resourceProfileData && (
        <Page size="A4" style={styles.page}>
          <View style={styles.sectionHeadingWrapper}><Text style={styles.sectionHeading}>Resource Profile</Text></View>

          <View style={styles.table}>
            <View style={styles.tableHeader}>
              <Text style={[styles.th, styles.col1]}>Role</Text>
              <Text style={[styles.th, styles.col2]}>Category</Text>
              <Text style={[styles.th, styles.col3]}>Hours</Text>
              <Text style={[styles.th, styles.col4]}>Days</Text>
              {resourceProfileData.summary?.hasCost && (
                <Text style={[styles.th, styles.col5]}>Cost</Text>
              )}
            </View>

            {(resourceProfileData.resourceRows ?? []).map((row: any, i: number) => (
              <View key={i} style={i % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                <Text style={[styles.td, styles.col1]}>{row.name ?? '—'}</Text>
                <Text style={[styles.td, styles.col2]}>{row.category ?? '—'}</Text>
                <Text style={[styles.td, styles.col3]}>{formatNum(row.totalHours)}</Text>
                <Text style={[styles.td, styles.col4]}>{formatNum(row.totalDays)}</Text>
                {resourceProfileData.summary?.hasCost && (
                  <Text style={[styles.td, styles.col5]}>
                    {row.estimatedCost != null ? `$${formatNum(row.estimatedCost, 0)}` : '—'}
                  </Text>
                )}
              </View>
            ))}

            {/* Overhead rows */}
            {(resourceProfileData.overheadRows ?? []).map((row: any, i: number) => (
              <View key={`oh-${i}`} style={styles.tableRow}>
                <Text style={[styles.td, styles.col1, { color: C.midGray }]}>{row.name}</Text>
                <Text style={[styles.td, styles.col2, { color: C.midGray }]}>Overhead</Text>
                <Text style={[styles.td, styles.col3, { color: C.midGray }]}>—</Text>
                <Text style={[styles.td, styles.col4, { color: C.midGray }]}>{formatNum(row.computedDays)}</Text>
                {resourceProfileData.summary?.hasCost && (
                  <Text style={[styles.td, styles.col5, { color: C.midGray }]}>
                    {row.estimatedCost != null ? `$${formatNum(row.estimatedCost, 0)}` : '—'}
                  </Text>
                )}
              </View>
            ))}

            {/* Grand total */}
            {resourceProfileData.summary && (
              <View style={styles.tableRowTotal}>
                <Text style={[styles.tdBold, styles.col1]}>Total</Text>
                <Text style={[styles.td, styles.col2]}></Text>
                <Text style={[styles.tdBold, styles.col3]}>{formatNum(resourceProfileData.summary.totalHours)}</Text>
                <Text style={[styles.tdBold, styles.col4]}>{formatNum(resourceProfileData.summary.totalDays)}</Text>
                {resourceProfileData.summary?.hasCost && (
                  <Text style={[styles.tdBold, styles.col5]}>
                    {resourceProfileData.summary.totalCost != null
                      ? `$${formatNum(resourceProfileData.summary.totalCost, 0)}`
                      : '—'}
                  </Text>
                )}
              </View>
            )}
          </View>

          <Text
            style={styles.footer}
            fixed
            render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
              footerText(pageNumber, totalPages)
            }
          />
          <Text
            style={styles.pageNumber}
            fixed
            render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
              `${pageNumber} / ${totalPages}`
            }
          />
        </Page>
      )}

      {/* ── Assumptions ── */}
      {sections.assumptions && (() => {
        // Collect all assumptions with context labels
        const items: Array<{ label: string; text: string }> = []
        for (const epic of epics) {
          if (epic.assumptions) items.push({ label: epic.name, text: epic.assumptions })
          for (const feature of epic.features) {
            if (feature.assumptions) items.push({ label: `${epic.name} › ${feature.name}`, text: feature.assumptions })
            for (const story of feature.userStories ?? []) {
              if (story.assumptions) items.push({ label: `${feature.name} › ${story.name}`, text: story.assumptions })
            }
          }
        }
        if (items.length === 0) return null
        return (
          <Page size="A4" style={styles.page}>
            <View style={styles.sectionHeadingWrapper}><Text style={styles.sectionHeading}>Assumptions</Text></View>
            {items.map((item, i) => (
              <View key={i} style={{ marginBottom: 10 }}>
                <Text style={{ fontSize: 9, fontFamily: 'Helvetica-Bold', color: C.darkGray, marginBottom: 3 }}>
                  {item.label}
                </Text>
                <Text style={{ fontSize: 8, color: C.midGray, lineHeight: 1.5 }}>
                  {item.text}
                </Text>
              </View>
            ))}
          </Page>
        )
      })()}
    </Document>
  )
}
