import { COMPLEXITY_LABELS, type Complexity, type FeatureTemplate } from '../../lib/featureTemplates'

/**
 * The template picker and the XS–XL complexity picker, shared by every flow
 * that applies a template (existing-Feature apply, and #295's creation flow).
 */

export function TemplateSelect({ id, templates, value, onChange, disabled }: {
  id?: string
  templates: FeatureTemplate[]
  value: string
  onChange: (templateId: string) => void
  disabled?: boolean
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
      className="w-full border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-lab3-blue"
    >
      <option value="">Select a template…</option>
      {templates.map(tpl => (
        <option key={tpl.id} value={tpl.id}>
          {tpl.name}{tpl.category ? ` (${tpl.category})` : ''}
        </option>
      ))}
    </select>
  )
}

export function ComplexityPicker({ value, onChange, disabled }: {
  value: Complexity
  onChange: (complexity: Complexity) => void
  disabled?: boolean
}) {
  return (
    <div className="flex gap-2">
      {(Object.keys(COMPLEXITY_LABELS) as Complexity[]).map(c => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          disabled={disabled}
          aria-pressed={value === c}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
            value === c
              ? 'bg-lab3-navy text-white'
              : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
          }`}
        >
          {COMPLEXITY_LABELS[c]}
        </button>
      ))}
    </div>
  )
}
