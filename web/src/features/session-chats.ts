// IM left rail: one chat row per workstation (worktree path). Sessions stay
// the detail route; opening a chat resolves which session to show. Pure +
// unit-tested — session-list.tsx only renders.
import { needsYou } from './console-sessions'
import {
  inRunning,
  isWorkstation,
  repoName,
  visitOf,
  workstationLabel,
  worktreeKey,
} from './session-order'
import type { SessionCard } from './session-card'

export type SessionChat = {
  /** worktree path (primary checkout: repo_root / cwd) */
  key: string
  title: string
  /** git branch description when the row is a workstation */
  purpose: string
  editable: boolean
  repoKey: string
  repoLabel: string
  /** sessions in this worktree (pane order kept for switcher) */
  sessions: Array<SessionCard>
  /** the session the row preview / open target uses */
  focus: SessionCard
  unread: number
  visit: number
  /** focus activity time — sorts non-unread rows */
  activity: number
}

export type ChatRepoGroup = {
  key: string
  label: string
  visit: number
  chats: Array<SessionChat>
}

const chatTitle = (row: SessionCard, wtKey: string) => {
  const base = (row.worktree || row.cwd).split('/').filter(Boolean).at(-1) ?? ''
  if (!row.worktree || row.worktree === row.repo_root) {
    return repoName(row) || base || wtKey
  }
  return workstationLabel(base) || wtKey
}

/** which session a chat opens: waiting → running → newest activity */
export function resolveChatFocus(
  sessions: Array<SessionCard>,
  phone: Record<string, number> = {},
  now = Date.now(),
): SessionCard | undefined {
  if (!sessions.length) return undefined
  const byVisit = (a: SessionCard, b: SessionCard) =>
    visitOf(b, phone) - visitOf(a, phone) || b.ts - a.ts
  const waiting = sessions.filter(needsYou).sort(byVisit)
  if (waiting[0]) return waiting[0]
  const running = sessions.filter((row) => inRunning(row, now)).sort(byVisit)
  if (running[0]) return running[0]
  return [...sessions].sort((a, b) => b.ts - a.ts || byVisit(a, b))[0]
}

/**
 * Aggregate flat sessions into repo → chat rows. Unread chats float to the
 * top of each repo; the rest follow focus activity time. Visit still breaks
 * ties so a quiet phone visit can pin a chat without agent output.
 */
export function buildChatGroups(
  rows: Array<SessionCard>,
  phone: Record<string, number> = {},
  now = Date.now(),
): Array<ChatRepoGroup> {
  const repos = new Map<
    string,
    {
      label: string
      visit: number
      trees: Map<string, Array<SessionCard>>
    }
  >()
  for (const row of rows) {
    const repoKey = row.repo_root || row.repo || row.cwd || row.id
    const repoLabel =
      repoName(row) ||
      row.repo_root?.split('/').filter(Boolean).at(-1) ||
      row.cwd.split('/').filter(Boolean).at(-1) ||
      row.id.slice(0, 8)
    const wtKey = worktreeKey(row)
    let repo = repos.get(repoKey)
    if (!repo) {
      repo = { label: repoLabel, visit: 0, trees: new Map() }
      repos.set(repoKey, repo)
    }
    let list = repo.trees.get(wtKey)
    if (!list) {
      list = []
      repo.trees.set(wtKey, list)
    }
    list.push(row)
    repo.visit = Math.max(repo.visit, visitOf(row, phone))
  }

  const paneIndex = (row: SessionCard) =>
    row.pane_index ?? (row.tmux_pane ? 0 : Infinity)

  const groups: Array<ChatRepoGroup> = []
  for (const [repoKey, repo] of repos) {
    const chats: Array<SessionChat> = []
    for (const [wtKey, sessions] of repo.trees) {
      const ordered = [...sessions].sort(
        (a, b) => paneIndex(a) - paneIndex(b) || a.id.localeCompare(b.id),
      )
      const focus = resolveChatFocus(ordered, phone, now)
      if (!focus) continue
      const unread = ordered.filter(needsYou).length
      // prefer frozen `visited` from useFrozenVisits so a click does not
      // lift the chat (visitOf would max with a fresh phone visit)
      const visit = Math.max(
        ...ordered.map((row) => row.visited ?? visitOf(row, phone)),
      )
      chats.push({
        key: wtKey,
        title: chatTitle(focus, wtKey),
        purpose:
          ordered.find((row) => row.worktree_description)
            ?.worktree_description ?? '',
        editable: isWorkstation(focus),
        repoKey,
        repoLabel: repo.label,
        sessions: ordered,
        focus,
        unread,
        visit,
        activity: focus.ts,
      })
    }
    chats.sort((a, b) => {
      const au = a.unread > 0 ? 1 : 0
      const bu = b.unread > 0 ? 1 : 0
      if (au !== bu) return bu - au
      return (
        b.activity - a.activity ||
        b.visit - a.visit ||
        a.title.localeCompare(b.title)
      )
    })
    groups.push({
      key: repoKey,
      label: repo.label,
      // repo section order: frozen visits only
      visit: Math.max(0, ...chats.map((c) => c.visit)),
      chats,
    })
  }
  return groups.sort(
    (a, b) => b.visit - a.visit || a.label.localeCompare(b.label),
  )
}

/** flat chat order as the list paints them (j / k, default pick) */
export function flattenChats(groups: Array<ChatRepoGroup>): Array<SessionChat> {
  return groups.flatMap((repo) => repo.chats)
}

/** tab badge: how many chats wait on you */
export function unreadChatCount(rows: Array<SessionCard>): number {
  const keys = new Set<string>()
  for (const row of rows) {
    if (needsYou(row)) keys.add(worktreeKey(row))
  }
  return keys.size
}
