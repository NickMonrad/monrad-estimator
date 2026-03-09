import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'

const styles = StyleSheet.create({
  page: { padding: 48, fontFamily: 'Helvetica', fontSize: 10, color: '#1f2937', lineHeight: 1.5 },
  coverPage: { padding: 48, display: 'flex', flexDirection: 'column', justifyContent: 'center', height: '100%' },
  coverTitle: { fontSize: 28, fontFamily: 'Helvetica-Bold', color: '#dc2626', marginBottom: 12 },
  coverSubtitle: { fontSize: 16, color: '#6b7280', marginBottom: 8 },
  coverMeta: { fontSize: 10, color: '#9ca3af', marginTop: 40 },
  sectionHeading: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: '#dc2626', marginBottom: 10, marginTop: 20, paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: '#fee2e2' },
  subheading: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: '#374151', marginBottom: 4, marginTop: 12 },
  bodyText: { fontSize: 10, color: '#4b5563', marginBottom: 4 },
  table: { marginBottom: 12 },
  tableHeader: { flexDirection: 'row', backgroundColor: '#f9fafb', borderBottomWidth: 1, borderBottomColor: '#e5e7eb', paddingVertical: 6, paddingHorizontal: 8 },
  tableRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#f3f4f6', paddingVertical: 5, paddingHorizontal: 8 },
  tableRowAlt: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#f3f4f6', paddingVertical: 5, paddingHorizontal: 8, backgroundColor: '#fafafa' },
  tableRowTotal: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#e5e7eb', paddingVertical: 6, paddingHorizontal: 8, backgroundColor: '#f9fafb' },
  th: { fontFamily: 'Helvetica-Bold', fontSize: 9, color: '#6b7280' },
  td: { fontSize: 9, color: '#374151' },
  tdBold: { fontSize: 9, color: '#374151', fontFamily: 'Helvetica-Bold' },
  col1: { flex: 3 },
  col2: { flex: 2 },
  col3: { flex: 1, textAlign: 'right' },
  col4: { flex: 1, textAlign: 'right' },
  pageNumber: { position: 'absolute', bottom: 24, right: 48, fontSize: 9, color: '#9ca3af' },
  footer: { position: 'absolute', bottom: 24, left: 48, fontSize: 9, color: '#9ca3af' },
  storyItem: { fontSize: 9, color: '#6b7280', marginLeft: 16, marginBottom: 2 },
  inactiveText: { color: '#9ca3af' },
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
  }
  effortData: any   // from GET /api/projects/:id/effort
  timelineData: any // from GET /api/projects/:id/timeline
  resourceProfileData: any // from GET /api/projects/:id/resource-profile
  epics: Array<{
    id: string
    name: string
    isActive: boolean
    features: Array<{
      id: string
      name: string
      isActive: boolean
      assumptions?: string | null
      userStories?: Array<{
        id: string
        name: string
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
          <Text style={styles.sectionHeading}>Scope Summary</Text>

          {epics.map((epic) => (
            <View key={epic.id}>
              <Text style={[styles.subheading, !epic.isActive ? styles.inactiveText : {}]}>
                {epic.name}{!epic.isActive ? ' (inactive)' : ''}
              </Text>

              {/* Features table */}
              <View style={styles.table}>
                <View style={styles.tableHeader}>
                  <Text style={[styles.th, styles.col1]}>Feature</Text>
                  <Text style={[styles.th, styles.col2]}>Status</Text>
                </View>
                {epic.features.map((feature, fi) => (
                  <View key={feature.id}>
                    <View style={fi % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                      <Text style={[styles.td, styles.col1, !feature.isActive ? styles.inactiveText : {}]}>
                        {feature.name}
                      </Text>
                      <Text style={[styles.td, styles.col2, !feature.isActive ? styles.inactiveText : {}]}>
                        {feature.isActive ? 'Active' : 'Inactive'}
                      </Text>
                    </View>
                    {feature.userStories && feature.userStories.filter(s => s.isActive).map((story) => (
                      <View key={story.id} style={styles.tableRow}>
                        <Text style={[styles.storyItem, { flex: 5 }]}>• {story.name}</Text>
                      </View>
                    ))}
                    {feature.assumptions && (
                      <View style={styles.tableRow}>
                        <Text style={[styles.storyItem, { flex: 5, fontStyle: 'italic', color: '#9ca3af' }]}>
                          Assumptions: {feature.assumptions}
                        </Text>
                      </View>
                    )}
                  </View>
                ))}
              </View>
            </View>
          ))}

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
      {sections.effort && effortData && (
        <Page size="A4" style={styles.page}>
          <Text style={styles.sectionHeading}>Effort Breakdown</Text>

          <View style={styles.table}>
            <View style={styles.tableHeader}>
              <Text style={[styles.th, styles.col1]}>Resource Type</Text>
              <Text style={[styles.th, styles.col2]}>Category</Text>
              <Text style={[styles.th, styles.col3]}>Hours</Text>
              <Text style={[styles.th, styles.col4]}>Days</Text>
            </View>

            {(effortData.rows ?? effortData.byResourceType ?? []).map((row: any, i: number) => (
              <View key={i} style={i % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                <Text style={[styles.td, styles.col1]}>{row.resourceTypeName ?? row.name ?? '—'}</Text>
                <Text style={[styles.td, styles.col2]}>{row.category ?? '—'}</Text>
                <Text style={[styles.td, styles.col3]}>
                  {formatNum(row.totalHours ?? row.hours)}
                </Text>
                <Text style={[styles.td, styles.col4]}>
                  {formatNum(row.totalDays ?? row.days)}
                </Text>
              </View>
            ))}

            {/* Totals row */}
            {(effortData.totals ?? effortData.summary) && (
              <View style={styles.tableRowTotal}>
                <Text style={[styles.tdBold, styles.col1]}>Total</Text>
                <Text style={[styles.td, styles.col2]}></Text>
                <Text style={[styles.tdBold, styles.col3]}>
                  {formatNum((effortData.totals ?? effortData.summary)?.totalHours ?? (effortData.totals ?? effortData.summary)?.hours)}
                </Text>
                <Text style={[styles.tdBold, styles.col4]}>
                  {formatNum((effortData.totals ?? effortData.summary)?.totalDays ?? (effortData.totals ?? effortData.summary)?.days)}
                </Text>
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

      {/* ── Timeline Summary ── */}
      {sections.timeline && timelineData && (
        <Page size="A4" style={styles.page}>
          <Text style={styles.sectionHeading}>Timeline Summary</Text>

          {/* Summary row */}
          {timelineData.summary && (
            <View style={{ marginBottom: 16 }}>
              <Text style={styles.bodyText}>
                Projected Start: {formatDate(timelineData.summary.startDate)}
              </Text>
              <Text style={styles.bodyText}>
                Projected End: {formatDate(timelineData.summary.endDate)}
              </Text>
              <Text style={styles.bodyText}>
                Duration: {formatNum(timelineData.summary.durationWeeks)} weeks
              </Text>
            </View>
          )}

          <View style={styles.table}>
            <View style={styles.tableHeader}>
              <Text style={[styles.th, styles.col1]}>Feature</Text>
              <Text style={[styles.th, styles.col2]}>Epic</Text>
              <Text style={[styles.th, styles.col3]}>Start</Text>
              <Text style={[styles.th, styles.col4]}>End</Text>
            </View>
            {(timelineData.entries ?? timelineData.features ?? []).map((entry: any, i: number) => (
              <View key={i} style={i % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                <Text style={[styles.td, styles.col1]}>{entry.featureName ?? entry.name ?? '—'}</Text>
                <Text style={[styles.td, styles.col2]}>{entry.epicName ?? entry.epic ?? '—'}</Text>
                <Text style={[styles.td, styles.col3]}>
                  {entry.startDate ? formatDate(entry.startDate) : (entry.startWeek != null ? `Wk ${entry.startWeek}` : '—')}
                </Text>
                <Text style={[styles.td, styles.col4]}>
                  {entry.endDate ? formatDate(entry.endDate) : (entry.durationWeeks != null ? `${formatNum(entry.durationWeeks)} wks` : '—')}
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
            </View>

            {(resourceProfileData.rows ?? resourceProfileData.resourceTypes ?? []).map((row: any, i: number) => (
              <View key={i} style={i % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                <Text style={[styles.td, styles.col1]}>{row.name ?? row.resourceTypeName ?? '—'}</Text>
                <Text style={[styles.td, styles.col2]}>{row.category ?? '—'}</Text>
                <Text style={[styles.td, styles.col3]}>
                  {formatNum(row.totalHours ?? row.hours)}
                </Text>
                <Text style={[styles.td, styles.col4]}>
                  {formatNum(row.totalDays ?? row.taskDays ?? row.days)}
                </Text>
              </View>
            ))}

            {/* Overhead rows */}
            {(resourceProfileData.overheads ?? []).map((row: any, i: number) => (
              <View key={`oh-${i}`} style={i % 2 === 0 ? styles.tableRow : styles.tableRowAlt}>
                <Text style={[styles.td, styles.col1, { color: '#6b7280' }]}>
                  {row.name} (overhead)
                </Text>
                <Text style={[styles.td, styles.col2, { color: '#6b7280' }]}>{row.category ?? '—'}</Text>
                <Text style={[styles.td, styles.col3, { color: '#6b7280' }]}>
                  {formatNum(row.totalHours ?? row.hours)}
                </Text>
                <Text style={[styles.td, styles.col4, { color: '#6b7280' }]}>
                  {formatNum(row.totalDays ?? row.days)}
                </Text>
              </View>
            ))}

            {/* Grand total */}
            {(resourceProfileData.totals ?? resourceProfileData.summary) && (
              <View style={styles.tableRowTotal}>
                <Text style={[styles.tdBold, styles.col1]}>Total</Text>
                <Text style={[styles.td, styles.col2]}></Text>
                <Text style={[styles.tdBold, styles.col3]}>
                  {formatNum((resourceProfileData.totals ?? resourceProfileData.summary)?.totalHours ?? (resourceProfileData.totals ?? resourceProfileData.summary)?.hours)}
                </Text>
                <Text style={[styles.tdBold, styles.col4]}>
                  {formatNum((resourceProfileData.totals ?? resourceProfileData.summary)?.totalDays ?? (resourceProfileData.totals ?? resourceProfileData.summary)?.days)}
                </Text>
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
    </Document>
  )
}
