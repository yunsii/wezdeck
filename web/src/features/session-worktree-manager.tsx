import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Check, ChevronRight, Copy, Layers } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Led } from '#/components/deck/led'
import type { LedTone } from '#/components/deck/led'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { PopoverContent } from '#/components/ui/popover'
import { Sheet } from '#/components/ui/sheet'
import { trace } from '#/lib/client-trace'
import { hostRead } from '#/lib/runtime-client'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import type { Detail } from './console-sessions'
import { useWorktreeActions } from './session-worktree-actions'
import { WorktreeDetail } from './session-worktree-detail'

type Worktree = NonNullable<Detail['worktrees']>[number]

export type WorkstationSlot = {
  path: string
  name: string
  branch: string
  head?: string
  description?: string
  state: string
  reason?: string
  sessions?: string[]
}

export type WorkstationDirection = {
  name: string
  description?: string
  slots: WorkstationSlot[]
}

export type WorktreeRow = WorkstationSlot & {
  current: boolean
  primary: boolean
}

export type WorktreeGroup = {
  name: string
  description?: string
  rows: WorktreeRow[]
}

export function worktreeGroups(
  list: Worktree[],
  directions: WorkstationDirection[] | undefined,
  otherName: string,
): WorktreeGroup[] {
  const current = new Set(
    list.filter((item) => item.current).map((item) => item.path),
  )
  const known = new Set<string>()
  const groups: WorktreeGroup[] = (directions ?? []).map((direction) => ({
    name: direction.name,
    description: direction.description,
    rows: direction.slots.map((slot) => {
      known.add(slot.path)
      return { ...slot, current: current.has(slot.path), primary: false }
    }),
  }))
  const other = list.flatMap((item, index) =>
    known.has(item.path)
      ? []
      : [
          {
            path: item.path,
            name: item.path.split('/').at(-1) || item.path,
            branch: item.branch ?? '',
            state: '',
            current: Boolean(item.current),
            primary: index === 0,
          },
        ],
  )
  if (other.length) groups.push({ name: otherName, rows: other })
  return groups
}

export function filterWorktreeGroups(groups: WorktreeGroup[], query: string) {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return groups
  return groups
    .map((group) => ({
      ...group,
      rows: `${group.name} ${group.description ?? ''}`
        .toLocaleLowerCase()
        .includes(needle)
        ? group.rows
        : group.rows.filter((row) =>
            `${row.name} ${row.branch} ${row.path}`
              .toLocaleLowerCase()
              .includes(needle),
          ),
    }))
    .filter((group) => group.rows.length > 0)
}

function stateTone(state: string): LedTone {
  if (state === 'idle') return 'done'
  if (state === 'running') return 'running'
  if (state === 'waiting' || state === 'dirty' || state === 'undelivered')
    return 'waiting'
  if (state === 'detached') return 'error'
  return 'muted'
}

function useStateLabel() {
  const { t } = useLingui()
  return (state: string) =>
    ({
      idle: t`Reusable`,
      running: t`Running`,
      waiting: t`Waiting for you`,
      dirty: t`Local changes`,
      undelivered: t`Not delivered`,
      detached: t`Detached`,
      in_use: t`In use`,
    })[state] ?? state
}

function SessionCount({ count }: { count: number }) {
  const { t } = useLingui()
  return t`${count} sessions`
}

function WorktreeRows({
  groups,
  onCopy,
  onSelect,
  copied,
}: {
  groups: WorktreeGroup[]
  onCopy: (path: string) => void
  onSelect: (row: WorktreeRow) => void
  copied: string
}) {
  const { t } = useLingui()
  const stateLabel = useStateLabel()
  return (
    <div data-testid="status-worktree-list" className="grid">
      {groups.map((group) => (
        <section key={group.name} className="min-w-0">
          <div className="border-b border-brand-edge px-3 pt-3 pb-2 md:flex md:items-baseline md:gap-2 md:px-2 md:py-1.5">
            <h3
              className="truncate text-caption font-semibold text-brand-text"
              title={group.name}
            >
              {group.name}
            </h3>
            {group.description && group.description !== group.name ? (
              <p className="line-clamp-2 text-meta text-brand-muted md:truncate">
                {group.description}
              </p>
            ) : null}
          </div>
          <ul>
            {group.rows.map((row) => (
              <li
                key={row.path}
                className="relative flex min-w-0 items-center gap-2 border-b border-brand-edge/70 pl-3 pr-1 last:border-b-0 hover:bg-brand-soft md:pl-2"
              >
                <Button
                  variant="plain"
                  type="button"
                  aria-label={`${t`Manage worktree`}: ${row.name}`}
                  onClick={() => onSelect(row)}
                  className="absolute inset-y-0 left-0 right-12 rounded-lg focus-visible:ring-2 focus-visible:ring-brand-running md:right-9"
                />
                <div className="pointer-events-none min-w-0 flex-1 py-2.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      className="min-w-0 truncate text-body font-medium text-brand-text md:text-caption"
                      title={row.name}
                    >
                      {row.name}
                    </span>
                    {row.current ? (
                      <span className="shrink-0 text-meta text-brand-running">{t`Current`}</span>
                    ) : null}
                    {row.primary ? (
                      <span className="shrink-0 text-meta text-brand-label">{t`Main checkout`}</span>
                    ) : null}
                    {row.state ? (
                      <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-meta text-brand-muted">
                        <Led tone={stateTone(row.state)} size={11} />
                        {stateLabel(row.state)}
                      </span>
                    ) : null}
                  </div>
                  <p
                    className="truncate font-mono text-meta text-brand-muted"
                    title={row.branch}
                  >
                    {row.branch || t`Detached`}
                    {row.sessions?.length ? (
                      <>
                        <span aria-hidden> · </span>
                        <SessionCount count={row.sessions.length} />
                      </>
                    ) : null}
                  </p>
                  <p
                    className="truncate font-mono text-meta text-brand-label md:sr-only"
                    title={row.path}
                  >
                    {row.path}
                  </p>
                </div>
                <ChevronRight
                  size={15}
                  aria-hidden
                  className="pointer-events-none shrink-0 text-brand-label"
                />
                <Button
                  variant="plain"
                  type="button"
                  aria-label={t`Copy path`}
                  title={`${t`Copy path`}: ${row.path}`}
                  onClick={() => onCopy(row.path)}
                  className="relative z-10 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-brand-muted hover:bg-brand-soft md:size-8"
                >
                  {copied === row.path ? (
                    <Check size={16} aria-hidden />
                  ) : (
                    <Copy size={16} aria-hidden />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function useWorktreeCopy(wide: boolean) {
  const { t } = useLingui()
  const [copied, setCopied] = useState('')
  const copy = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path)
      setCopied(path)
      setTimeout(() => setCopied(''), 1_500)
      trace('worktree-view', {
        action: 'copy',
        mode: wide ? 'popover' : 'sheet',
      })
    } catch {
      setCopied('')
      toast.error(t`Could not copy path`)
      trace('worktree-view', {
        action: 'copy_error',
        mode: wide ? 'popover' : 'sheet',
      })
    }
  }
  return { copied, copy }
}

export function WorktreeManager({
  list,
  repoPath,
  sample,
}: {
  list: Worktree[]
  repoPath: string
  /** 交互调试: paired workstations matching its sample session */
  sample?: WorkstationDirection[]
}) {
  const { t } = useLingui()
  const wide = useIsWidePhoneFirst()
  const [open, setOpen] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [sampleDirections, setSampleDirections] = useState(sample)
  const [removedPaths, setRemovedPaths] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const { copied, copy } = useWorktreeCopy(wide)
  const openedAt = useRef(0)
  const reported = useRef(false)
  const linked = list.length - 1
  const workstations = useQuery({
    queryKey: ['remote', 'workstations', repoPath],
    enabled: open && Boolean(repoPath) && !sample,
    staleTime: 10_000,
    queryFn: async () =>
      (await hostRead('workstations', { repo: repoPath })) as {
        directions: WorkstationDirection[]
      },
  })
  const directions = sample ? sampleDirections : workstations.data?.directions
  const pending = !sample && workstations.isPending
  const error = !sample && workstations.isError ? workstations.error : null
  const groups = worktreeGroups(
    list.filter((item) => !removedPaths.includes(item.path)),
    directions,
    t`Other worktrees`,
  )
  const shown = filterWorktreeGroups(groups, query)
  const selectedGroup = groups.find((group) =>
    group.rows.some((row) => row.path === selectedPath),
  )
  const selected = selectedGroup?.rows.find((row) => row.path === selectedPath)
  const stateLabel = useStateLabel()
  const changeOpen = (next: boolean) => {
    setOpen(next)
    setSelectedPath(null)
    if (next) {
      setQuery('')
      openedAt.current = performance.now()
      reported.current = false
    }
    trace('worktree-view', {
      action: next ? 'open' : 'close',
      mode: wide ? 'popover' : 'sheet',
      count: linked,
    })
  }
  useEffect(() => {
    if (!open || pending || reported.current) return
    reported.current = true
    trace('worktree-view', {
      action: error ? 'error' : 'loaded',
      mode: wide ? 'popover' : 'sheet',
      count: directions?.length ?? 0,
      ms: Math.round(performance.now() - openedAt.current),
    })
  }, [open, wide, pending, error, directions])
  const { writable, saveDescription, openSession, newSession, manage } =
    useWorktreeActions({
      repoPath,
      selected,
      selectedGroup,
      sample,
      setSampleDirections,
      onRemove: (path) => {
        setRemovedPaths((current) => [...current, path])
        setSelectedPath(null)
      },
      close: () => changeOpen(false),
    })
  const content = selected ? (
    <WorktreeDetail
      key={selected.path}
      row={selected}
      status={stateLabel(selected.state)}
      writable={writable}
      wide={wide}
      copied={copied === selected.path}
      onCopy={() => void copy(selected.path)}
      onSave={saveDescription}
      onOpenSession={selected.sessions?.length ? openSession : undefined}
      onNewSession={
        selected.sessions?.length && writable ? newSession : undefined
      }
      onManage={manage}
    />
  ) : (
    <div className="min-w-0 px-4 md:px-2">
      {groups.reduce((count, group) => count + group.rows.length, 0) > 5 ? (
        <Input
          variant={wide ? 'default' : 'field'}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t`Search worktrees`}
          placeholder={t`Search worktrees`}
          className="mb-2"
        />
      ) : null}
      {pending ? (
        <p
          role="status"
          className="py-1 text-meta text-brand-label"
        >{t`Loading…`}</p>
      ) : null}
      {error ? (
        <p role="alert" className="py-1 text-meta text-brand-error">
          {String(error)}
        </p>
      ) : null}
      {shown.length ? (
        <WorktreeRows
          groups={shown}
          onCopy={(path) => void copy(path)}
          onSelect={(row) => {
            setSelectedPath(row.path)
            trace('worktree-view', { action: 'select' })
          }}
          copied={copied}
        />
      ) : (
        <p className="py-8 text-center text-caption text-brand-muted">
          {query ? t`Nothing matches` : t`No linked worktrees`}
        </p>
      )}
    </div>
  )
  const label = t`${linked} linked worktrees`
  if (!wide)
    return (
      <>
        <Button
          variant="plain"
          type="button"
          data-tone="neutral"
          data-testid="status-worktrees"
          aria-label={label}
          title={label}
          onClick={() => changeOpen(true)}
          className="session-tag cursor-pointer text-meta"
        >
          <Layers size={11} aria-hidden className="shrink-0" />
          {t`Worktrees`} {linked}
        </Button>
        <Sheet
          open={open}
          onOpenChange={(next) => {
            if (!next && selected) setSelectedPath(null)
            else changeOpen(next)
          }}
          title={selected?.name || t`Worktrees`}
          onBack={selected ? () => setSelectedPath(null) : undefined}
          testId="worktree-manager"
        >
          {content}
        </Sheet>
      </>
    )
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={changeOpen}>
      <PopoverPrimitive.Trigger
        data-tone="neutral"
        data-testid="status-worktrees"
        aria-label={label}
        title={label}
        className="session-tag cursor-pointer text-meta outline-none focus-visible:ring-2 focus-visible:ring-brand-running"
      >
        <Layers size={11} aria-hidden className="shrink-0" />
        {t`Worktrees`} {linked}
      </PopoverPrimitive.Trigger>
      <PopoverContent
        side="top"
        sideOffset={6}
        data-testid="worktree-manager"
        className="max-h-[min(28rem,70dvh)] w-[min(27rem,calc(100vw-2rem))] overflow-y-auto p-2"
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 bg-brand-surface px-3 py-2 text-caption font-semibold">
          {selected ? (
            <Button
              variant="plain"
              type="button"
              aria-label={t`Back`}
              onClick={() => setSelectedPath(null)}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-brand-muted"
            >
              <ArrowLeft size={17} aria-hidden />
            </Button>
          ) : null}
          <span className="min-w-0 truncate">
            {selected?.name || t`Worktrees`}
          </span>
        </div>
        {content}
      </PopoverContent>
    </PopoverPrimitive.Root>
  )
}
