// Parse and safely rewrite `file://` links inside Markdown replies into
// in-app fragment markers (`#wd-file:...`) before rehype-sanitize / harden,
// so browsers never touch the native `file:` protocol while Web Console
// sessions can open host artifacts, plans, and source files via `session.file`.

export type HostFileTarget = {
  path: string
  lineStart?: number
  lineEnd?: number
}

const HASH_PREFIX = '#wd-file:'
const LINE_FRAG = /#L(\d+)(?:-L?(\d+))?$/

/** Parse a `file:///abs/path[#L10[-L20]]` href into a host file target. */
export function parseHostFileHref(href: string): HostFileTarget | null {
  const trimmed = href.trim()
  if (!trimmed.toLowerCase().startsWith('file://')) return null
  let rest = trimmed
  let lineStart: number | undefined
  let lineEnd: number | undefined
  const frag = LINE_FRAG.exec(rest)
  if (frag) {
    lineStart = Number(frag[1])
    if (frag[2]) lineEnd = Number(frag[2])
    rest = rest.slice(0, frag.index)
  }
  let url: URL
  try {
    url = new URL(rest)
  } catch {
    return null
  }
  if (url.protocol !== 'file:') return null
  if (url.hostname && url.hostname !== 'localhost') return null
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (!path || path.includes('\0') || path.length > 1024) return null
  return {
    path,
    ...(lineStart && lineStart > 0 ? { lineStart } : {}),
    ...(lineEnd && lineEnd > 0 ? { lineEnd } : {}),
  }
}

export function encodeHostFileHash(target: HostFileTarget): string {
  const params = new URLSearchParams({ p: target.path })
  if (target.lineStart && target.lineStart > 0) {
    params.set('s', String(target.lineStart))
  }
  if (target.lineEnd && target.lineEnd > 0) {
    params.set('e', String(target.lineEnd))
  }
  return `${HASH_PREFIX}${params.toString()}`
}

export function decodeHostFileHash(href?: string): HostFileTarget | null {
  if (!href || !href.startsWith(HASH_PREFIX)) return null
  const params = new URLSearchParams(href.slice(HASH_PREFIX.length))
  const path = params.get('p')
  if (!path) return null
  const s = Number(params.get('s'))
  const e = Number(params.get('e'))
  return {
    path,
    ...(Number.isFinite(s) && s > 0 ? { lineStart: s } : {}),
    ...(Number.isFinite(e) && e > 0 ? { lineEnd: e } : {}),
  }
}

export function formatLineRange(lineStart?: number, lineEnd?: number): string {
  if (!lineStart || lineStart <= 0) return ''
  if (lineEnd && lineEnd > lineStart) return `L${lineStart}–${lineEnd}`
  return `L${lineStart}`
}

type HastNode = {
  type?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: Array<HastNode>
}

function walkHast(node: HastNode) {
  if (
    node.type === 'element' &&
    node.tagName === 'a' &&
    typeof node.properties?.href === 'string'
  ) {
    const target = parseHostFileHref(node.properties.href)
    if (target) {
      node.properties.href = encodeHostFileHash(target)
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkHast(child)
  }
}

/**
 * Rehype plugin: rewrite valid `file://` hrefs to `#wd-file:...` before
 * sanitize + harden run, so `ChatMarkdown`'s `a` renderer can turn them into
 * clickable host-file buttons while keeping `javascript:` / `data:` blocked.
 */
export function rehypeHostFileLinks() {
  return (tree: HastNode) => {
    walkHast(tree)
  }
}

/** Extract H2 / H3 Markdown headings (skipping fenced code blocks) for TOC. */
export type MarkdownHeading = { level: 2 | 3; text: string; index: number }

export function extractMarkdownHeadings(
  markdown: string,
): Array<MarkdownHeading> {
  const headings: Array<MarkdownHeading> = []
  let inFence = false
  let index = 0
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim()
    if (/^(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{2,3})\s+(.+?)\s*#*$/.exec(line)
    if (!m) continue
    const level = m[1].length as 2 | 3
    // strip basic inline markdown syntax for clean TOC labels
    const text = m[2]
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*_~]/g, '')
      .trim()
    if (text) {
      headings.push({ level, text, index: index++ })
    }
  }
  return headings
}
