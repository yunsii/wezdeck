// Pure helpers for repository external links (`repo.links`, powered by
// `vscode-links` on the host — same source as the terminal's `Ctrl+k l`).
// Kept free of React / Lingui so unit tests run directly.

export type RepoLinkType =
  'detected' | 'local' | 'remote-project' | 'remote-shared' | (string & {})

export type RepoLink = {
  type: RepoLinkType
  source: string
  url: string
  title: string
  description?: string
}

export type RepoLinksReply = {
  cli_available: boolean
  cwd?: string
  links: Array<RepoLink>
  diagnostics?: Array<string>
}

export const LINK_TYPE_ORDER = [
  'detected',
  'local',
  'remote-project',
  'remote-shared',
] as const

export type KnownLinkType = (typeof LINK_TYPE_ORDER)[number]

/** Only http(s) URLs with a host may open as external web links. */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim())
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      Boolean(parsed.host)
    )
  } catch {
    return false
  }
}

/**
 * Filter links by query across title, URL, source and type — mirrors
 * `native/picker/cmd_links.go` refilter. Drops unsafe URLs defensively.
 */
export function filterRepoLinks(
  links: Array<RepoLink>,
  query: string,
): Array<RepoLink> {
  const safe = links.filter((link) => isSafeExternalUrl(link.url))
  const q = query.trim().toLowerCase()
  if (!q) return safe
  return safe.filter((link) =>
    `${link.title} ${link.description ?? ''} ${link.url} ${link.source} ${link.type}`
      .toLowerCase()
      .includes(q),
  )
}

export type RepoLinkGroup = {
  type: KnownLinkType | 'other'
  items: Array<RepoLink>
}

const KNOWN_TYPES = new Set<string>(LINK_TYPE_ORDER)

/** Group links in display order: detected → local → remote-project → remote-shared → other. */
export function groupRepoLinks(links: Array<RepoLink>): Array<RepoLinkGroup> {
  const buckets = new Map<RepoLinkGroup['type'], Array<RepoLink>>()
  for (const link of links) {
    const bucket: RepoLinkGroup['type'] = KNOWN_TYPES.has(link.type)
      ? (link.type as KnownLinkType)
      : 'other'
    const list = buckets.get(bucket)
    if (list) list.push(link)
    else buckets.set(bucket, [link])
  }
  const order: Array<RepoLinkGroup['type']> = [...LINK_TYPE_ORDER, 'other']
  const groups: Array<RepoLinkGroup> = []
  for (const type of order) {
    const items = buckets.get(type)
    if (items?.length) groups.push({ type, items })
  }
  return groups
}

/** Compact display URL: drop scheme and trailing slash. */
export function compactUrl(raw: string): string {
  return raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}
