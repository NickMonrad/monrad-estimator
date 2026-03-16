import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'

const styles = StyleSheet.create({
  page: { padding: 48, fontFamily: 'Helvetica', fontSize: 10, color: '#333333', lineHeight: 1.5 },
  // height: '100%' removed — causes yoga layout to overflow to extreme coordinates
  // (pdfkit.browser.js: "unsupported number: -1.6412...e+21") when combined with
  // justifyContent: 'center' inside a padded Page. Use explicit paddingTop instead.
  coverPage: { paddingTop: 160, flexDirection: 'column' },
  coverTitle: { fontSize: 28, fontFamily: 'Helvetica-Bold', color: '#1d245b', marginBottom: 12, lineHeight: 1.4 },
  coverSubtitle: { fontSize: 16, color: '#2c60f6', marginBottom: 8, lineHeight: 1.4 },
  coverMeta: { fontSize: 10, color: '#666666', marginTop: 40 },
  sectionHeading: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: '#1d245b', marginBottom: 12, marginTop: 20, lineHeight: 1.5 },
  sectionLabel: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: '#1d245b', marginBottom: 6, marginTop: 14 },
  sectionLabelMuted: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: '#666666', marginBottom: 6, marginTop: 14 },
  subheading: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#333333', marginBottom: 4, marginTop: 12 },
  bodyText: { fontSize: 10, color: '#333333', marginBottom: 4 },
  table: { marginBottom: 12 },
  tableHeader: { flexDirection: 'row', backgroundColor: '#1d245b', paddingVertical: 6, paddingHorizontal: 8 },
  tableRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e0e0e0', paddingVertical: 5, paddingHorizontal: 8 },
  tableRowAlt: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e0e0e0', paddingVertical: 5, paddingHorizontal: 8, backgroundColor: '#f5f5f5' },
  tableRowTotal: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#1d245b', paddingVertical: 6, paddingHorizontal: 8, backgroundColor: '#f5f5f5' },
  tableRowSubtotal: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#e0e0e0', paddingVertical: 5, paddingHorizontal: 8, backgroundColor: '#eeeeee' },
  th: { fontFamily: 'Helvetica-Bold', fontSize: 9, color: '#ffffff' },
  td: { fontSize: 9, color: '#333333' },
  tdBold: { fontSize: 9, color: '#333333', fontFamily: 'Helvetica-Bold' },
  col1: { flex: 3 },
  col2: { flex: 2 },
  col3: { flex: 1, textAlign: 'right' },
  col4: { flex: 1, textAlign: 'right' },
  col5: { flex: 1, textAlign: 'right' },
  scopeEpicBlock: { marginBottom: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#e0e0e0' },
  scopeFeatureCard: { marginTop: 8, padding: 10, borderWidth: 1, borderColor: '#e0e0e0' },
  scopeFeatureCardAlt: { backgroundColor: '#f5f5f5' },
  scopeFeatureTitle: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: '#333333', marginBottom: 2 },
  scopeMetaText: { fontSize: 9, color: '#666666', marginBottom: 4 },
  scopeDetailBlock: { marginTop: 6 },
  scopeDetailLabel: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#1d245b', marginBottom: 2 },
  scopeDetailText: { fontSize: 9, color: '#333333', lineHeight: 1.4 },
  scopeBullet: { fontSize: 9, color: '#333333', marginLeft: 10, marginBottom: 2, lineHeight: 1.4 },
  scopeEmptyState: { fontSize: 9, color: '#666666', marginTop: 6 },
  pageNumber: { position: 'absolute', bottom: 24, right: 48, fontSize: 9, color: '#666666' },
  footer: { position: 'absolute', bottom: 24, left: 48, fontSize: 9, color: '#666666' },
  storyItem: { fontSize: 9, color: '#666666', marginLeft: 16, marginBottom: 2 },
  inactiveText: { color: '#aaaaaa' },
})

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
  generatedBy: string
  documentLabel: string
}

type ScopeEpic = ScopeDocumentProps['epics'][number]
type ScopeFeature = ScopeEpic['features'][number]
type ScopeStory = NonNullable<ScopeFeature['userStories']>[number]

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
  generatedBy,
  documentLabel,
}: ScopeDocumentProps) {
  const today = new Date().toLocaleDateString('en-AU', { year: 'numeric', month: 'long', day: 'numeric' })
  const now = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })

  const footerText = (pageNumber: number, totalPages: number) =>
    `${project.name} | Page ${pageNumber} of ${totalPages}`

  // ── Scope: split active vs inactive ──────────────────────────
  const inScopeEpics = epics.filter(e => e.isActive)
  const outOfScopeFullEpics = epics.filter(e => !e.isActive)
  const partiallyOutOfScope = inScopeEpics
    .map(e => ({ ...e, features: e.features.filter(f => !f.isActive) }))
    .filter(e => e.features.length > 0)

  const renderScopeFeature = (
    feature: ScopeFeature,
    stories: ScopeStory[],
    muted = false,
    alternate = false,
  ) => (
    <View
      key={feature.id}
      style={[
        styles.scopeFeatureCard,
        alternate ? styles.scopeFeatureCardAlt : null,
      ]}
    >
      <Text style={[styles.scopeFeatureTitle, muted ? styles.inactiveText : null]}>{feature.name}</Text>
      <Text style={[styles.scopeMetaText, muted ? styles.inactiveText : null]}>
        {stories.length} {stories.length === 1 ? 'story' : 'stories'}
      </Text>

      {feature.description ? (
        <View style={styles.scopeDetailBlock}>
          <Text style={[styles.scopeDetailLabel, muted ? styles.inactiveText : null]}>Description</Text>
          <Text style={[styles.scopeDetailText, muted ? styles.inactiveText : null]}>{feature.description}</Text>
        </View>
      ) : null}

      {feature.assumptions ? (
        <View style={styles.scopeDetailBlock}>
          <Text style={[styles.scopeDetailLabel, muted ? styles.inactiveText : null]}>Assumptions</Text>
          <Text style={[styles.scopeDetailText, muted ? styles.inactiveText : null]}>{feature.assumptions}</Text>
        </View>
      ) : null}

      {stories.length > 0 ? (
        <View style={styles.scopeDetailBlock}>
          <Text style={[styles.scopeDetailLabel, muted ? styles.inactiveText : null]}>Stories</Text>
          {stories.map((story) => (
            <Text key={story.id} style={[styles.scopeBullet, muted ? styles.inactiveText : null]}>
              • {story.name}
            </Text>
          ))}
        </View>
      ) : (
        <Text style={[styles.scopeEmptyState, muted ? styles.inactiveText : null]}>No stories listed.</Text>
      )}
    </View>
  )

  const renderScopeEpic = (
    epic: ScopeEpic,
    features: ScopeFeature[],
    options?: { muted?: boolean; emptyLabel?: string; titleSuffix?: string },
  ) => {
    const muted = options?.muted ?? false

    return (
      <View key={epic.id} style={styles.scopeEpicBlock}>
        <Text style={[styles.subheading, muted ? styles.inactiveText : null]}>
          {epic.name}
          {options?.titleSuffix ? ` ${options.titleSuffix}` : ''}
        </Text>

        {epic.description ? (
          <View style={styles.scopeDetailBlock}>
            <Text style={[styles.scopeDetailLabel, muted ? styles.inactiveText : null]}>Epic Description</Text>
            <Text style={[styles.scopeDetailText, muted ? styles.inactiveText : null]}>{epic.description}</Text>
          </View>
        ) : null}

        {epic.assumptions ? (
          <View style={styles.scopeDetailBlock}>
            <Text style={[styles.scopeDetailLabel, muted ? styles.inactiveText : null]}>Epic Assumptions</Text>
            <Text style={[styles.scopeDetailText, muted ? styles.inactiveText : null]}>{epic.assumptions}</Text>
          </View>
        ) : null}

        {features.length > 0 ? (
          features.map((feature, index) =>
            renderScopeFeature(
              feature,
              muted ? (feature.userStories ?? []) : (feature.userStories ?? []).filter(story => story.isActive),
              muted,
              index % 2 === 1,
            ),
          )
        ) : (
          <Text style={[styles.scopeEmptyState, muted ? styles.inactiveText : null]}>
            {options?.emptyLabel ?? 'No features listed.'}
          </Text>
        )}
      </View>
    )
  }

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
            <Text style={styles.coverMeta}>Prepared by {generatedBy}</Text>
            <Text style={styles.coverMeta}>Generated: {today} at {now}</Text>
            <Text style={styles.coverMeta}>Document: {documentLabel}</Text>
            {project.startDate && (
              <Text style={styles.coverMeta}>Projected Start: {formatDate(project.startDate)}</Text>
            )}
            {project.endDate && (
              <Text style={styles.coverMeta}>Projected End: {formatDate(project.endDate)}</Text>
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
          <Text style={styles.sectionHeading}>Scope Summary</Text>

          {/* ── In Scope ── */}
          <Text style={styles.sectionLabel}>In Scope</Text>
          {inScopeEpics.length === 0 && (
            <Text style={styles.bodyText}>No active epics.</Text>
          )}
          {inScopeEpics.map((epic) => renderScopeEpic(epic, epic.features.filter(feature => feature.isActive)))}

          {/* ── Out of Scope ── */}
          {(outOfScopeFullEpics.length > 0 || partiallyOutOfScope.length > 0) && (
            <View>
              <Text style={styles.sectionLabelMuted}>Out of Scope</Text>

              {/* Fully inactive epics */}
              {outOfScopeFullEpics.map((epic) => renderScopeEpic(epic, epic.features, { muted: true }))}

              {/* Active epics that have inactive features */}
              {partiallyOutOfScope.map((epic) =>
                renderScopeEpic(epic, epic.features, { muted: true, titleSuffix: '(inactive features)' }),
              )}
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
            <Text style={styles.sectionHeading}>Effort Breakdown</Text>

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
                    <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e0e0e0', paddingVertical: 6, paddingHorizontal: 8, backgroundColor: '#f5f5f5' }}>
                      <Text style={[styles.tdBold, styles.col1]}>{epic.epicName}</Text>
                      <Text style={[styles.tdBold, styles.col3]}>{formatNum(epic.totalHours)}</Text>
                      <Text style={[styles.tdBold, styles.col4]}>{formatNum(epic.totalDays)}</Text>
                    </View>
                    {/* Feature rows */}
                    {[...epic.features.values()].map((feat, fi) => (
                      <View key={fi}>
                        <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e0e0e0', paddingVertical: 5, paddingLeft: 20, paddingRight: 8, backgroundColor: '#f5f5f5' }}>
                          <Text style={[{ fontSize: 9, color: '#333333', fontFamily: 'Helvetica-Bold' }, styles.col1]}>{feat.featureName}</Text>
                          <Text style={[{ fontSize: 9, color: '#333333', fontFamily: 'Helvetica-Bold' }, styles.col3]}>{formatNum(feat.totalHours)}</Text>
                          <Text style={[{ fontSize: 9, color: '#333333', fontFamily: 'Helvetica-Bold' }, styles.col4]}>{formatNum(feat.totalDays)}</Text>
                        </View>
                        {/* Resource rows */}
                        {feat.resources.map((res, ri) => (
                          <View key={ri} style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e0e0e0', paddingVertical: 4, paddingLeft: 36, paddingRight: 8 }}>
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
              <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#e0e0e0', paddingVertical: 6, paddingHorizontal: 8, backgroundColor: '#e0e0e0' }}>
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
          <Text style={styles.sectionHeading}>Timeline Summary</Text>

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
          <Text style={styles.sectionHeading}>Resource Profile</Text>

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
                <Text style={[styles.td, styles.col1, { color: '#666666' }]}>{row.name}</Text>
                <Text style={[styles.td, styles.col2, { color: '#666666' }]}>Overhead</Text>
                <Text style={[styles.td, styles.col3, { color: '#666666' }]}>—</Text>
                <Text style={[styles.td, styles.col4, { color: '#666666' }]}>{formatNum(row.computedDays)}</Text>
                {resourceProfileData.summary?.hasCost && (
                  <Text style={[styles.td, styles.col5, { color: '#666666' }]}>
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
          if (!epic.isActive) continue
          if (epic.assumptions) items.push({ label: epic.name, text: epic.assumptions })
          for (const feature of epic.features) {
            if (!feature.isActive) continue
            if (feature.assumptions) items.push({ label: `${epic.name} › ${feature.name}`, text: feature.assumptions })
            for (const story of feature.userStories ?? []) {
              if (!story.isActive) continue
              if (story.assumptions) items.push({ label: `${feature.name} › ${story.name}`, text: story.assumptions })
            }
          }
        }
        if (items.length === 0) return null
        return (
          <Page size="A4" style={styles.page}>
            <Text style={styles.sectionHeading}>Assumptions</Text>
            {items.map((item, i) => (
              <View key={i} style={{ marginBottom: 10 }}>
                <Text style={{ fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#333333', marginBottom: 3 }}>
                  {item.label}
                </Text>
                <Text style={{ fontSize: 8, color: '#666666', lineHeight: 1.5 }}>
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
