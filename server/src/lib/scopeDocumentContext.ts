export interface ScopeDocumentAssumption {
  label: string
  text: string
}

export interface ScopeDocumentDependency {
  description: string
}

export interface ScopeDocumentRisk {
  description: string
  mitigation: string | null
}

export interface ScopeDocumentContext {
  assumptions: ScopeDocumentAssumption[]
  dependencies: ScopeDocumentDependency[]
  risks: ScopeDocumentRisk[]
}

interface AssumptionSource {
  label: string
  value: string | null | undefined
}

function stripRichText(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
}

function comparisonKey(value: string): string {
  return stripRichText(value)
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
}

function extractTopLevelEntries(value: string): string[] {
  const blocks: string[] = []
  const blockPattern = /<(p|ul|ol)\b[^>]*>[\s\S]*?<\/\1>/gi
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = blockPattern.exec(value)) !== null) {
    if (value.slice(cursor, match.index).trim()) return [value]
    const block = match[0]
    if (match[1].toLowerCase() === 'p') {
      blocks.push(block)
    } else {
      const items = [...block.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/gi)]
      const listBody = block.replace(/^<(?:ul|ol)\b[^>]*>|<\/(?:ul|ol)>$/gi, '')
      if (!items.length || items.map(item => item[0]).join('').replace(/\s+/g, '') !== listBody.replace(/\s+/g, '')) {
        return [value]
      }
      blocks.push(...items.map(item => item[0]))
    }
    cursor = match.index + block.length
  }

  if (!blocks.length || value.slice(cursor).trim()) return [value]
  return blocks
}

export function deduplicateAssumptions(sources: AssumptionSource[]): ScopeDocumentAssumption[] {
  const seen = new Set<string>()
  const assumptions: ScopeDocumentAssumption[] = []

  for (const source of sources) {
    if (typeof source.value !== 'string' || !source.value.trim()) continue
    for (const text of extractTopLevelEntries(source.value.trim())) {
      if (!stripRichText(text)) continue
      const key = comparisonKey(text)
      if (!key || seen.has(key)) continue
      seen.add(key)
      assumptions.push({ label: source.label, text })
    }
  }

  return assumptions
}

interface ScopeEpic {
  name: string
  assumptions?: string | null
  isActive: boolean
  features: Array<{
    name: string
    assumptions?: string | null
    isActive: boolean
    userStories?: Array<{
      name: string
      assumptions?: string | null
      isActive: boolean
    }>
  }>
}

interface ProjectDependency {
  description: string
}

interface ProjectRisk {
  description: string
  mitigation: string | null
}

export function buildScopeDocumentContext(
  epics: ScopeEpic[],
  dependencies: ProjectDependency[],
  risks: ProjectRisk[],
): ScopeDocumentContext {
  const sources: AssumptionSource[] = []
  for (const epic of epics) {
    if (!epic.isActive) continue
    sources.push({ label: epic.name, value: epic.assumptions })
    for (const feature of epic.features) {
      if (!feature.isActive) continue
      sources.push({ label: `${epic.name} › ${feature.name}`, value: feature.assumptions })
      for (const story of feature.userStories ?? []) {
        if (!story.isActive) continue
        sources.push({ label: `${feature.name} › ${story.name}`, value: story.assumptions })
      }
    }
  }

  return {
    assumptions: deduplicateAssumptions(sources),
    dependencies: dependencies
      .filter(dependency => typeof dependency.description === 'string' && dependency.description.trim())
      .map(dependency => ({ description: dependency.description })),
    risks: risks
      .filter(risk => typeof risk.description === 'string' && risk.description.trim())
      .map(risk => ({ description: risk.description, mitigation: risk.mitigation ?? null })),
  }
}
