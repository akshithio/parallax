// Normalize the model list for the picker. The list now comes straight from
// ChatGPT's own menu DOM (scraped by the extension), so it is ALREADY exactly what
// ChatGPT shows — we do not curate, relabel, or synthesize anything here. This
// just de-duplicates (by title) and passes through the fields, so it also cleans
// up any stale localStorage from older builds.

export interface ModelVariant {
  label: string
  slug: string
}

export interface ModelIntelligence {
  label: string
  hint?: string
}

export interface ModelOption {
  slug: string
  title: string
  sublabel?: string
  intelligences?: ModelIntelligence[]
  variants?: ModelVariant[]
}

export function normalizeCurrentModel(value: unknown): string {
  const title = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (!title || title.length > 80 || /^model$/i.test(title) || /\bmemory\b/i.test(title)) return ''
  return title
}

export function normalizeIntelligenceLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (!label || label.length > 48 || /\b(?:memory|project|work mode)\b/i.test(label)) return ''
  return label
}

export function normalizeIntelligences(list: unknown): ModelIntelligence[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: ModelIntelligence[] = []
  for (const item of list) {
    const label = normalizeIntelligenceLabel(item?.label)
    const key = label.toLowerCase()
    if (!label || seen.has(key)) continue
    seen.add(key)
    const hint = typeof item?.hint === 'string' ? item.hint.replace(/\s+/g, ' ').trim() : ''
    out.push({ label, ...(hint ? { hint } : {}) })
  }
  return out
}

export function normalizeModels(list: any[]): ModelOption[] {
  if (!Array.isArray(list) || list.length === 0) return []
  const seen = new Set<string>()
  const out: ModelOption[] = []
  for (const m of list) {
    const title = normalizeCurrentModel(m?.title)
    if (!title) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const slug = typeof m?.slug === 'string' && m.slug.trim() ? m.slug.trim() : title
    const opt: ModelOption = { slug, title }
    if (typeof m?.sublabel === 'string' && m.sublabel.trim()) opt.sublabel = m.sublabel.trim()
    const intelligences = normalizeIntelligences(m?.intelligences)
    if (intelligences.length) opt.intelligences = intelligences
    out.push(opt)
  }
  return out
}
