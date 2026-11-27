// Pure matching & token-replacement logic for composer input suggestions:
//   1. `#` ticket mention completion (open repo tickets, explicit trigger)
//   2. History message suggestions from host-persisted `sent.list` (automatic
//      when typing >= 2 non-command chars, default inactive so Enter still sends)
import type { CollabTicket } from '#/lib/runtime-contract'
import type { SentRecord } from './sent-history-data'

export type SentSuggestion = {
  id: string
  text: string
  attachments: Array<string>
  repoLabel?: string
  createdAt: number
  inSession: boolean
}

export type TicketSuggestion = {
  id: string
  title: string
  to?: string | null
  status?: string | null
  attachmentsCount: number
}

/**
 * Active `#` mention token at the caret (start of text or after whitespace).
 * Supports Chinese, Latin, digits, and ticket id punctuation (`req-2026...`).
 */
export function ticketMentionQuery(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  if (caret <= 0) return null
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('#')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null
  const query = before.slice(at + 1)
  if (/\s/.test(query)) return null
  return { start: at, query }
}

/** Match open repo tickets against `#<query>`: id prefix > title prefix > substring. */
export function matchTicketSuggestions(
  tickets: Array<CollabTicket>,
  query: string,
  limit = 6,
): Array<TicketSuggestion> {
  const q = query.trim().toLowerCase()
  const mapped: Array<TicketSuggestion> = tickets.map((t) => ({
    id: t.id,
    title: t.title || t.id,
    to: t.to,
    status: t.status,
    attachmentsCount: t.attachments_count ?? 0,
  }))
  if (!q) return mapped.slice(0, limit)
  const rank = (item: TicketSuggestion) => {
    const id = item.id.toLowerCase()
    const title = item.title.toLowerCase()
    if (id.startsWith(q)) return 0
    if (title.startsWith(q)) return 1
    if (id.includes(q)) return 2
    if (title.includes(q)) return 3
    return -1
  }
  return mapped
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .filter((row) => row.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((row) => row.item)
}

/** Replace the `#query` token [start, caret) with `insert` + trailing space. */
export function applyTicketCompletion(
  text: string,
  start: number,
  caret: number,
  insert: string,
): { text: string; caret: number } {
  const after = text.slice(caret).replace(/^[^\s#]*/, '')
  const space = after.startsWith(' ') || after.startsWith('\n') ? '' : ' '
  const next = text.slice(0, start) + insert + space + after
  return { text: next, caret: start + insert.length + (space ? 1 : 0) }
}

/**
 * Match recent host-sent messages against free-text input.
 * Skips short inputs (<2 chars), slash/codex commands, and exact duplicates.
 * Ranks: current session > repo/other, prefix > substring, newest first.
 */
export function matchSentSuggestions(
  records: Array<SentRecord>,
  rawInput: string,
  currentSession: string,
  limit = 5,
): Array<SentSuggestion> {
  const trimmed = rawInput.trim()
  if (trimmed.length < 2) return []
  if (trimmed.startsWith('/') || trimmed.startsWith('$')) return []
  const needle = trimmed.toLowerCase()

  const deduped = new Map<
    string,
    { item: SentSuggestion; rank: number; inSessionRank: number }
  >()
  for (const rec of records) {
    if (rec.status === 'dismissed') continue
    const text = rec.text.trim()
    if (!text) continue
    const lower = text.toLowerCase()
    if (lower === needle) continue
    let matchRank = -1
    if (lower.startsWith(needle)) matchRank = 0
    else if (lower.includes(needle)) matchRank = 1
    if (matchRank < 0) continue

    const inSession = Boolean(
      currentSession && rec.session_id === currentSession,
    )
    const inSessionRank = inSession ? 0 : 1
    const candidate: SentSuggestion = {
      id: rec.id,
      text: rec.text,
      attachments: rec.attachments ?? [],
      repoLabel: rec.repo_label,
      createdAt: rec.created_at,
      inSession,
    }
    const existing = deduped.get(lower)
    if (
      !existing ||
      inSessionRank < existing.inSessionRank ||
      (inSessionRank === existing.inSessionRank &&
        candidate.createdAt > existing.item.createdAt)
    ) {
      deduped.set(lower, { item: candidate, rank: matchRank, inSessionRank })
    }
  }

  return [...deduped.values()]
    .sort(
      (a, b) =>
        a.inSessionRank - b.inSessionRank ||
        a.rank - b.rank ||
        b.item.createdAt - a.item.createdAt,
    )
    .slice(0, limit)
    .map((entry) => entry.item)
}
