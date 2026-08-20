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
 * those blocks with a small balanced-tag scan; unsupported or ambiguous shapes
 * stay as one complete field so wording and formatting remain unchanged.
 */
const voidHtmlTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

interface OpenHtmlTag {
  name: string
  start: number
  isBlock: boolean
}

export function extractAssumptionEntries(value: string | null | undefined): string[] {
  if (!value || !hasText(value)) return []
  const trimmed = value.trim()
  if (!trimmed.startsWith('<')) return [trimmed]

  const tagPattern = /<!--[\s\S]*?-->|<\/?([a-z][\w:-]*)(?:\s[^<>]*?)?\/?>/gi
  const stack: OpenHtmlTag[] = []
  const blocks: string[] = []
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = tagPattern.exec(trimmed)) !== null) {
    const rawTag = match[0]
    const textBeforeTag = trimmed.slice(cursor, match.index)
    if (textBeforeTag.trim() && (stack.length === 0 || stack[stack.length - 1].name === 'ul' || stack[stack.length - 1].name === 'ol')) {
      return [trimmed]
    }
    cursor = match.index + rawTag.length

    if (!match[1]) continue
    const name = match[1].toLowerCase()
    const isClosing = rawTag.startsWith('</')
    const isSelfClosing = /\/\s*>$/.test(rawTag) || voidHtmlTags.has(name)

    if (isClosing) {
      const openTag = stack.pop()
      if (!openTag || openTag.name !== name) return [trimmed]
      if (openTag.isBlock) blocks.push(trimmed.slice(openTag.start, cursor))
      continue
    }

    if (stack.length === 0 && name !== 'p' && name !== 'ul' && name !== 'ol') return [trimmed]
    if ((name === 'ul' || name === 'ol') && stack.length > 0) return [trimmed]
    if (name === 'li' && stack.some(tag => tag.name === 'p' || tag.name === 'li')) return [trimmed]
    if (name === 'p' && stack.some(tag => tag.name === 'p')) return [trimmed]

    const isBlock = name === 'p' ? stack.length === 0 : name === 'li' && ['ul', 'ol'].includes(stack[stack.length - 1]?.name ?? '')
    if (name === 'li' && !isBlock) return [trimmed]
    if (!isSelfClosing) stack.push({ name, start: match.index, isBlock })
  }

  if (trimmed.slice(cursor).trim() || stack.length > 0 || blocks.length === 0) return [trimmed]
  return blocks.filter(hasText)
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
