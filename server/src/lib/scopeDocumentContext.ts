export interface ScopeDocumentStory {
  id: string
  name: string
  assumptions?: string | null
  isActive: boolean
  order?: number
}

export interface ScopeDocumentFeature {
  id: string
  name: string
  assumptions?: string | null
  isActive: boolean
  order?: number
  userStories?: ScopeDocumentStory[]
}

export interface ScopeDocumentEpic {
  id: string
  name: string
  assumptions?: string | null
  isActive: boolean
  order?: number
  features: ScopeDocumentFeature[]
}

export interface ScopeDocumentDependency {
  id: string
  description: string
  order: number
}

export interface ScopeDocumentRisk {
  id: string
  description: string
  mitigation?: string | null
  order: number
}

export interface ScopeDocumentAssumption {
  label: string
  text: string
}

export interface ScopeDocumentContext {
  assumptions: ScopeDocumentAssumption[]
  dependencies: ScopeDocumentDependency[]
  risks: ScopeDocumentRisk[]
}

function ordered<T extends { id: string; order?: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id))
}

function stripRichText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

function hasText(value: string): boolean {
  return stripRichText(value).trim().length > 0
}

/**
 * TipTap stores top-level paragraphs and list items as HTML blocks. Extract
 * those blocks without adding a general HTML parser; unsupported shapes stay
 * as one complete field so wording and formatting remain unchanged.
 */
export function extractAssumptionEntries(value: string | null | undefined): string[] {
  if (!value || !hasText(value)) return []
  const trimmed = value.trim()
  if (!trimmed.startsWith('<')) return [trimmed]

  const blockPattern = /<(p|li)\b[^>]*>/gi
  const lower = trimmed.toLowerCase()
  const blocks: string[] = []
  let match: RegExpExecArray | null
  while ((match = blockPattern.exec(trimmed)) !== null) {
    const tag = match[1].toLowerCase()
    const closing = `</${tag}>`
    const closingIndex = lower.indexOf(closing, blockPattern.lastIndex)
    if (closingIndex < 0) continue
    const end = closingIndex + closing.length
    const block = trimmed.slice(match.index, end)
    if (hasText(block)) blocks.push(block)
    blockPattern.lastIndex = end
  }

  return blocks.length > 0 ? blocks : [trimmed]
}

export function assumptionComparisonKey(value: string): string {
  return stripRichText(value).normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function deduplicateAssumptions(entries: ScopeDocumentAssumption[]): ScopeDocumentAssumption[] {
  const seen = new Set<string>()
  return entries.filter(entry => {
    const key = assumptionComparisonKey(entry.text)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function buildScopeDocumentContext(
  epics: ScopeDocumentEpic[],
  dependencies: ScopeDocumentDependency[],
  risks: ScopeDocumentRisk[],
): ScopeDocumentContext {
  const assumptions: ScopeDocumentAssumption[] = []

  for (const epic of ordered(epics)) {
    if (!epic.isActive) continue
    for (const text of extractAssumptionEntries(epic.assumptions)) {
      assumptions.push({ label: epic.name, text })
    }

    for (const feature of ordered(epic.features)) {
      if (!feature.isActive) continue
      for (const text of extractAssumptionEntries(feature.assumptions)) {
        assumptions.push({ label: `${epic.name} › ${feature.name}`, text })
      }

      for (const story of ordered(feature.userStories ?? [])) {
        if (!story.isActive) continue
        for (const text of extractAssumptionEntries(story.assumptions)) {
          assumptions.push({ label: `${feature.name} › ${story.name}`, text })
        }
      }
    }
  }

  return {
    assumptions: deduplicateAssumptions(assumptions),
    dependencies: ordered(dependencies),
    risks: ordered(risks),
  }
}
