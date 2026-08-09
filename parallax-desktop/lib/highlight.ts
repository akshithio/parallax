// Shared syntax highlighting.
//
// Lives here rather than inside MessageLog so the file viewer, tool-call cards,
// and anything else render code identically — same language resolution, same
// theme classes (styled globally as .hljs-* in styles/globals.css).
import hljs from 'highlight.js/lib/common'

// Map a file path/extension to a highlight.js language id.
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyw: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', kts: 'kotlin', swift: 'swift', c: 'c', h: 'c', hpp: 'cpp',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', cs: 'csharp', php: 'php', sh: 'bash',
  bash: 'bash', zsh: 'bash', fish: 'bash', json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', css: 'css',
  scss: 'scss', sass: 'scss', less: 'less', md: 'markdown', markdown: 'markdown',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', dockerfile: 'dockerfile',
  makefile: 'makefile', lua: 'lua', r: 'r', pl: 'perl', ex: 'elixir', exs: 'elixir',
  scala: 'scala', dart: 'dart', proto: 'protobuf', tf: 'hcl', diff: 'diff', patch: 'diff',
}

export function langForPath(path?: string | null): string | undefined {
  if (!path) return undefined
  const base = path.split('/').filter(Boolean).pop() || ''
  const lower = base.toLowerCase()
  if (lower === 'dockerfile') return 'dockerfile'
  if (lower === 'makefile') return 'makefile'
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  return EXT_LANG[ext]
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

/** Highlight a whole blob. Falls back to escaped plain text for unknown languages. */
export function highlightToHtml(code: string, lang?: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value
  } catch {
    /* fall through */
  }
  return escapeHtml(code)
}

/**
 * Highlight `code` and return ONE HTML string PER LINE, for views that put each
 * line in its own row (a gutter of line numbers, say).
 *
 * The whole file is highlighted in one pass first — highlighting line-by-line
 * would break every construct that spans lines (block comments, Python
 * docstrings, template literals). But hljs's output has `<span>`s that also span
 * lines, and splitting that HTML naively yields rows with unbalanced tags. So we
 * walk the output tracking which spans are open, and at each newline close them
 * all and reopen them on the next line.
 */
export function highlightLines(code: string, lang?: string): string[] {
  const html = highlightToHtml(code, lang)
  const lines: string[] = []
  const open: string[] = []
  let current = ''
  // hljs emits only span tags and escaped text, so this tokenizer is sufficient.
  const re = /(<span\b[^>]*>)|(<\/span>)|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m[1]) {
      open.push(m[1])
      current += m[1]
    } else if (m[2]) {
      open.pop()
      current += m[2]
    } else {
      const parts = m[3].split('\n')
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          current += '</span>'.repeat(open.length) // close for this row
          lines.push(current)
          current = open.join('') // reopen on the next row
        }
        current += parts[i]
      }
    }
  }
  lines.push(current)
  return lines
}
