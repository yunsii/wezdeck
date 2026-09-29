import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Toggle } from '#/components/ui/toggle'
import { ToggleGroup } from '#/components/ui/toggle-group'
import { getWorktreeStatus, postRuntimeAction } from '#/lib/runtime-client'
import type {
  AgentSession,
  VscodeWindow,
  WorkspaceCatalog,
} from '#/lib/runtime-contract'
import { runtimeQuery, useRuntimeData } from './console-data'
import { Reading } from './inspector'

type Worktree = {
  path: string
  name: string
  branch: string
  kind: string
}

type CatalogRow = {
  id: string
  workspace: string
  cwd: string
  name: string
  worktrees: Worktree[]
  /** Live attention entries for this repo (may be multiple worktree panes). */
  liveSessions: AgentSession[]
  /** Preferred detail/jump target: live first, else most recent archive. */
  session?: AgentSession
  recent: boolean
}

export function ConsoleDevelopmentPage() {
  const { t } = useLingui()
  const runtime = useRuntimeData()
  const sessions = runtimeQuery(runtime.sessions)
  const vscode = runtimeQuery(runtime.vscode)
  const workspaces = runtimeQuery(runtime.workspaces)
  const entries = sessions.data ? Object.values(sessions.data.entries) : []
  const recent = (sessions.data?.recent ?? [])
    .filter(
      (item) => !entries.some((entry) => entry.session_id === item.session_id),
    )
    .slice(0, 4)
  const windows = vscode.data?.windows ?? []
  const catalog = workspaces.data?.workspaces ?? []
  const rows = catalogRows(catalog, entries, recent)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const remembered = useRememberedSelection()
  const [workspaceName, setWorkspaceName] = useState(remembered.workspace)
  const [repoName, setRepoName] = useState(remembered.repo)
  const [worktreePath, setWorktreePath] = useState(remembered.worktree)

  async function focusSession(entry: AgentSession, isRecent: boolean) {
    if (!entry.session_id) return
    setBusy(true)
    setFeedback('')
    try {
      const result = await postRuntimeAction('sessions', 'focus', {
        session_id: entry.session_id,
        recent: isRecent,
        ...(isRecent && entry.archived_ts
          ? { archived_ts: entry.archived_ts }
          : {}),
      })
      if (!result.ok)
        throw new Error(result.error?.message || t`Session jump failed`)
      setFeedback(t`Jump requested`)
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : t`Session jump failed`,
      )
    } finally {
      setBusy(false)
    }
  }

  async function openDirectory(cwd: string) {
    const requested = cwd
    setBusy(true)
    setFeedback('')
    try {
      const response = await postRuntimeAction('vscode', 'focus_or_open', {
        requested_dir: requested,
        distro: 'Ubuntu',
      })
      if (!response.ok)
        throw new Error(response.error?.message || t`Runtime action failed`)
      setFeedback(t`Window focused`)
      void vscode.refetch()
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : t`Runtime action failed`,
      )
    } finally {
      setBusy(false)
    }
  }

  async function vscodeAction(action: 'focus' | 'close', hwnd: number) {
    if (
      action === 'close' &&
      !window.confirm(
        t`Close this VS Code window? Unsaved work may ask for confirmation.`,
      )
    )
      return
    setBusy(true)
    setFeedback('')
    try {
      const response = await postRuntimeAction('vscode', action, {
        hwnd,
        ...(action === 'close' ? { confirm: true } : {}),
      })
      if (!response.ok)
        throw new Error(response.error?.message || t`Runtime action failed`)
      setFeedback(action === 'close' ? t`Close requested` : t`Window focused`)
      void vscode.refetch()
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : t`Runtime action failed`,
      )
    } finally {
      setBusy(false)
    }
  }

  const groups = catalog.map((workspace) => ({
    name: workspace.name,
    items: rows.filter((row) => row.workspace === workspace.name),
  }))
  const activeWorkspace = groups.some((group) => group.name === workspaceName)
    ? workspaceName
    : groups[0]?.name || ''
  const activeGroup = groups.find((group) => group.name === activeWorkspace)
  const activeRepo =
    activeGroup?.items.find((item) => item.name === repoName) ||
    activeGroup?.items[0]
  const trees = activeRepo?.worktrees ?? []
  const activeTree =
    trees.find((tree) => tree.path === worktreePath) ?? trees[0]
  const remember = (workspace: string, repo: string, worktree: string) => {
    writeRememberedSelection({ workspace, repo, worktree })
  }

  const catalogMessage = workspaces.isPending
    ? t`Loading…`
    : workspaces.isError || workspaces.data.available === false
      ? t`This Runtime does not provide the workspace catalog.`
      : catalog.length === 0
        ? t`No workspaces in the local catalog.`
        : ''

  return (
    <div className="grid content-start gap-4">
      {catalogMessage ? (
        <p className="text-sm text-brand-muted" role="status">
          {catalogMessage}
        </p>
      ) : null}
      {groups.length > 0 ? (
        <ToggleGroup
          aria-label={t`Workspaces`}
          value={[activeWorkspace]}
          onValueChange={(values) => {
            const next = values[0]
            if (!next || next === activeWorkspace) return
            const group = groups.find((item) => item.name === next)
            const repo = group?.items[0]
            const tree = repo?.worktrees[0]
            setWorkspaceName(next)
            setRepoName(repo?.name ?? '')
            setWorktreePath(tree?.path ?? '')
            if (repo && tree) remember(next, repo.name, tree.path)
          }}
          className="border-b border-brand-border"
        >
          {groups.map((group) => (
            <Toggle
              key={group.name}
              value={group.name}
              className="rounded-none px-3 text-sm"
            >
              {group.name}
              <span className="font-mono text-xs opacity-70">
                {group.items.length}
              </span>
            </Toggle>
          ))}
        </ToggleGroup>
      ) : null}
      {!activeGroup || activeGroup.items.length === 0 ? (
        <p className="text-sm text-brand-label" role="status">
          {t`No repositories in this workspace.`}
        </p>
      ) : (
        <LevelTabs
          label={t`Repositories`}
          value={activeRepo?.name ?? ''}
          items={activeGroup.items.map((item) => ({
            value: item.name,
            label: item.name,
            // Same as landing Example: only current live attention status.
            tone: repoTone(item),
          }))}
          onChange={(next) => {
            const repo = activeGroup.items.find((item) => item.name === next)
            const tree = repo?.worktrees[0]
            setRepoName(next)
            setWorktreePath(tree?.path ?? '')
            if (repo && tree) remember(activeWorkspace, next, tree.path)
          }}
        />
      )}
      {activeRepo ? (
        trees.length === 0 ? (
          <p className="text-sm text-brand-label" role="status">
            {t`No worktrees in this repository.`}
          </p>
        ) : (
          <LevelTabs
            label={t`Worktrees`}
            value={activeTree.path}
            items={trees.map((tree) => ({
              value: tree.path,
              label: tree.name,
              tone: worktreeTone(activeRepo, tree),
            }))}
            onChange={(next) => {
              setWorktreePath(next)
              remember(activeWorkspace, activeRepo.name, next)
            }}
          />
        )
      ) : null}
      <WorktreeStatus
        row={activeRepo}
        tree={activeTree}
        busy={busy}
        windows={windows}
        onFocus={() => {
          if (activeRepo?.session)
            void focusSession(activeRepo.session, activeRepo.recent)
        }}
        onOpen={() => void openDirectory(activeTree.path)}
        onClose={(hwnd) => void vscodeAction('close', hwnd)}
      />
      {feedback ? (
        <p className="text-sm text-brand-muted" role="status">
          {feedback}
        </p>
      ) : null}
    </div>
  )
}

const selectionKey = 'wezdeck.console.development.selection'

function useRememberedSelection() {
  const empty = { workspace: '', repo: '', worktree: '' }
  if (typeof window === 'undefined') return empty
  try {
    const value = JSON.parse(window.localStorage.getItem(selectionKey) || '')
    if (value && typeof value === 'object') {
      return {
        workspace: String(value.workspace || ''),
        repo: String(value.repo || ''),
        worktree: String(value.worktree || ''),
      }
    }
  } catch {
    return empty
  }
  return empty
}

function writeRememberedSelection(value: {
  workspace: string
  repo: string
  worktree: string
}) {
  window.localStorage.setItem(selectionKey, JSON.stringify(value))
}

type TabTone = 'running' | 'waiting' | 'done'

function LevelTabs({
  label,
  value,
  items,
  onChange,
}: {
  label: string
  value: string
  items: Array<{ value: string; label: string; tone?: TabTone }>
  onChange: (value: string) => void
}) {
  if (items.length === 0) return null
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(values) => {
        const next = values[0]
        if (next && next !== value) onChange(next)
      }}
      className="flex-wrap border-b border-brand-border"
    >
      {items.map((item) => (
        <Toggle
          key={item.value}
          value={item.value}
          variant={item.tone ?? 'default'}
          className="rounded-none px-3 text-sm"
        >
          {item.label}
        </Toggle>
      ))}
    </ToggleGroup>
  )
}

/** Live attention only — never recent/last_status (landing Example rule). */
function liveTone(status: string | undefined): TabTone | undefined {
  const raw = (status || '').toLowerCase()
  if (raw === 'waiting' || raw === 'running' || raw === 'done') return raw
  return undefined
}

function pickTone(tones: Array<TabTone | undefined>): TabTone | undefined {
  const present = tones.filter((tone): tone is TabTone => Boolean(tone))
  if (present.includes('waiting')) return 'waiting'
  if (present.includes('running')) return 'running'
  if (present.includes('done')) return 'done'
  return undefined
}

function repoTone(row: CatalogRow): TabTone | undefined {
  return pickTone(row.liveSessions.map((session) => liveTone(session.status)))
}

function worktreeMatchesSession(tree: Worktree, session: AgentSession) {
  const branch = session.git_branch || ''
  const windowName = session.tmux_window_name || ''
  if (branch && tree.branch && branch === tree.branch) return true
  if (windowName && tree.name && windowName === tree.name) return true
  // Branch slugs often use '/' while worktree names use '-'.
  if (branch && tree.name && branch.replaceAll('/', '-') === tree.name)
    return true
  if (windowName && tree.branch && windowName.replaceAll('-', '/') === tree.branch)
    return true
  return false
}

function worktreeTone(row: CatalogRow, tree: Worktree): TabTone | undefined {
  const matched = row.liveSessions.filter((session) =>
    worktreeMatchesSession(tree, session),
  )
  if (matched.length > 0) {
    return pickTone(matched.map((session) => liveTone(session.status)))
  }
  // One worktree in the repo ⇒ the live pane belongs to it.
  if (row.worktrees.length === 1) {
    return pickTone(row.liveSessions.map((session) => liveTone(session.status)))
  }
  return undefined
}

function WorktreeStatus({
  row,
  tree,
  busy,
  windows,
  onFocus,
  onOpen,
  onClose,
}: {
  row: CatalogRow | undefined
  tree: Worktree | undefined
  busy: boolean
  windows: VscodeWindow[]
  onFocus: () => void
  onOpen: () => void
  onClose: (hwnd: number) => void
}) {
  const { t } = useLingui()
  if (!row || !tree) {
    return (
      <p className="text-sm text-brand-muted" role="status">
        {t`Select a worktree to see its agent status.`}
      </p>
    )
  }
  const session = row.session
  const statusQuery = useQuery({
    queryKey: ['runtime', 'worktree-status', tree.path],
    queryFn: () => getWorktreeStatus(tree.path),
    enabled: typeof window !== 'undefined',
    refetchInterval: 30_000,
  })
  const status = statusQuery.data
  const closeHwnd =
    windowFor(windows, tree.name) ?? windowFor(windows, row.name)
  return (
    <div className="border border-brand-border p-4">
      <Reading
        kicker={`${row.workspace} / ${row.name} / ${tree.name} / ${tree.branch || tree.name}`}
        title={session?.agent_name || t`No active agent sessions`}
        body={
          session?.last_user_prompt ||
          session?.reason ||
          t`One tmux session per repository family. Linked worktrees are windows inside that session.`
        }
        facts={[
          {
            label: t`Status`,
            value: session?.status || session?.last_status || t`Unavailable`,
          },
          { label: t`Git`, value: status?.git_changes || t`Unavailable` },
          { label: t`Node`, value: status?.node_version || t`Unavailable` },
          { label: t`Directory`, value: tree.path },
          {
            label: t`Tmux session`,
            value: session?.tmux_session || t`Unavailable`,
          },
          {
            label: t`Tmux window`,
            value: session?.tmux_window_name || t`Unavailable`,
          },
        ]}
      >
        <RowActions
          busy={busy}
          canFocus={Boolean(session?.session_id)}
          canClose={closeHwnd !== undefined}
          onFocus={onFocus}
          onOpen={onOpen}
          onClose={() => {
            if (closeHwnd !== undefined) onClose(closeHwnd)
          }}
        />
      </Reading>
    </div>
  )
}

function RowActions({
  busy,
  canFocus,
  canClose,
  onFocus,
  onOpen,
  onClose,
}: {
  busy: boolean
  canFocus: boolean
  canClose: boolean
  onFocus: () => void
  onOpen: () => void
  onClose: () => void
}) {
  const { t } = useLingui()
  return (
    <span className="flex gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !canFocus}
        onClick={onFocus}
      >
        {t`Jump to pane`}
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={onOpen}>
        {t`Open VS Code`}
      </Button>
      <Button
        size="sm"
        variant="warning"
        disabled={busy || !canClose}
        onClick={onClose}
      >
        {t`Close VS Code window`}
      </Button>
    </span>
  )
}

function catalogRows(
  catalog: WorkspaceCatalog['workspaces'],
  entries: AgentSession[],
  recent: AgentSession[],
): CatalogRow[] {
  return catalog.flatMap((workspace) =>
    workspace.items.map((item) => {
      const liveSessions = entries.filter((entry) => sessionMatches(entry, item))
      const live = liveSessions[0]
      const archived = recent.find((entry) => sessionMatches(entry, item))
      const worktrees =
        item.worktrees.length > 0
          ? item.worktrees
          : [
              {
                path: item.cwd,
                name: item.name,
                branch: '',
                kind: 'primary',
              },
            ]
      return {
        id: workspace.name + ':' + item.cwd,
        workspace: workspace.name,
        cwd: item.cwd,
        name: item.name,
        worktrees,
        liveSessions,
        session: live ?? archived,
        recent: !live && Boolean(archived),
      }
    }),
  )
}

function sessionMatches(
  entry: AgentSession,
  item: { cwd: string; name: string },
) {
  const repo = entry.repo || deriveRepo(entry.tmux_session)
  return repo === item.name
}

function windowFor(windows: VscodeWindow[], name: string) {
  const match = windows.find((window) =>
    (window.title || window.Title || '').includes(name),
  )
  return match?.hwnd ?? match?.Hwnd
}

function deriveRepo(session: string | undefined) {
  const match = session?.match(/^wezterm_[^_]+_(.+)_[0-9a-f]{10}$/i)
  return match?.[1] ?? ''
}
