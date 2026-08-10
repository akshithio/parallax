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

export function normalizeModels(list: any[]): ModelOption[] {
  if (!Array.isArray(list) || list.length === 0) return []
  const seen = new Set<string>()
  const out: ModelOption[] = []
  for (const m of list) {
    const title = typeof m?.title === 'string' ? m.title.trim() : ''
    if (!title) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const slug = typeof m?.slug === 'string' && m.slug.trim() ? m.slug.trim() : title
    const opt: ModelOption = { slug, title }
    if (typeof m?.sublabel === 'string' && m.sublabel.trim()) opt.sublabel = m.sublabel.trim()
    if (Array.isArray(m?.intelligences) && m.intelligences.length) {
      opt.intelligences = m.intelligences
        .filter((i: any) => i && typeof i.label === 'string' && i.label.trim())
        .map((i: any) => ({ label: i.label.trim(), ...(i.hint ? { hint: String(i.hint).trim() } : {}) }))
    }
    out.push(opt)
  }
  return out
}
