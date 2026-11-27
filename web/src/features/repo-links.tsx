// Repository external links sheet (`repo.links`, powered by `vscode-links` on
// the host — same link list as the desk's `Ctrl+k l` picker).
// Opened from the session list's repo headers, 会话信息, or key `l` on a
// session page. Supports search, ↑/↓ + Enter keyboard open, click / middle-
// click native `<a target="_blank">`, copy URL, and manual refresh.
import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  Copy,
  ExternalLink,
  FolderGit2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Sheet } from '#/components/ui/sheet'
import { Skeleton, SkeletonGroup } from '#/components/ui/skeleton'
import { copyText } from '#/lib/clipboard'
import { trace } from '#/lib/client-trace'
import { hostRead } from '#/lib/runtime-client'
import { cn } from '#/lib/utils'
import { jumpPending } from './console-jump-keys'
import { compactUrl, filterRepoLinks, groupRepoLinks } from './repo-links-model'
import type {
  RepoLink,
  RepoLinkGroup,
  RepoLinksReply,
} from './repo-links-model'

export type RepoLinksTarget = {
  label: string
  repo?: string
  cwd?: string
}

function repoLinksQueryKey(repo?: string, cwd?: string) {
  return ['remote', 'repo-links', repo ?? '', cwd ?? ''] as const
}

function useGroupLabels(): Record<RepoLinkGroup['type'], string> {
  const { t } = useLingui()
  return {
    detected: t`Repository`,
    local: t`Project config`,
    'remote-project': t`Remote project`,
    'remote-shared': t`Shared`,
    other: t`Other`,
  }
}

function RepoLinkRow({
  link,
  active,
  onHover,
}: {
  link: RepoLink
  active: boolean
  onHover: () => void
}) {
  const { t } = useLingui()
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void copyText(link.url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1_200)
      const shown =
        link.url.length > 44 ? `${link.url.slice(0, 43)}…` : link.url
      toast(t`Copied: ${shown}`)
    })
  }
  return (
    <li
      data-testid="repo-link-item"
      data-active={active ? '' : undefined}
      onMouseEnter={onHover}
      className={cn(
        'flex min-w-0 items-center gap-1 rounded-xl bg-brand-surface pr-1.5 transition-colors',
        active && 'bg-brand-soft',
      )}
    >
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="repo-link-row"
        data-link-type={link.type}
        onClick={() =>
          trace('repo-link-open', {
            type: link.type,
            source: link.source,
            via: 'click',
          })
        }
        className="grid min-h-12 min-w-0 flex-1 content-center gap-0.5 rounded-xl px-3.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-body font-medium text-brand-text">
            {link.title}
          </span>
          <ExternalLink
            size={13}
            aria-hidden
            className="shrink-0 text-brand-label"
          />
        </span>
        {link.description ? (
          <span className="line-clamp-1 text-caption text-brand-muted">
            {link.description}
          </span>
        ) : null}
        <span className="truncate font-mono text-meta text-brand-label">
          {compactUrl(link.url)}
        </span>
      </a>
      <Button
        variant="plain"
        size="none"
        type="button"
        data-testid="repo-link-copy"
        aria-label={t`Copy link`}
        title={t`Copy link`}
        onClick={copy}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-brand-muted hover:text-brand-text"
      >
        {copied ? (
          <Check size={15} className="text-brand-done" aria-hidden />
        ) : (
          <Copy size={15} aria-hidden />
        )}
      </Button>
    </li>
  )
}

function RepoLinksSkeleton() {
  const { t } = useLingui()
  return (
    <div
      role="status"
      aria-label={t`Loading…`}
      data-testid="repo-links-skeleton"
    >
      <SkeletonGroup className="grid gap-2">
        <Skeleton className="h-3 w-20" />
        {[0, 1, 2, 3].map((row) => (
          <div
            key={row}
            className="grid min-h-12 content-center gap-1.5 rounded-xl bg-brand-surface px-3.5 py-2"
          >
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-2.5 w-3/5" />
          </div>
        ))}
      </SkeletonGroup>
    </div>
  )
}

export function RepoLinksSheet({
  open,
  onOpenChange,
  target,
  sample,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: RepoLinksTarget | null
  /** 交互调试: show this instead of reading the host */
  sample?: RepoLinksReply
}) {
  const { t } = useLingui()
  const labels = useGroupLabels()
  const client = useQueryClient()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const repo = target?.repo
  const cwd = target?.cwd
  const queryKey = repoLinksQueryKey(repo, cwd)
  const read = useQuery({
    queryKey,
    enabled: open && !sample && Boolean(repo || cwd),
    staleTime: 60_000,
    retry: 1,
    queryFn: async () =>
      (await hostRead('repo.links', {
        ...(repo ? { repo } : {}),
        ...(cwd ? { cwd } : {}),
      })) as RepoLinksReply,
  })

  const reply = sample ?? read.data
  const error = sample ? null : read.isError ? read.error : null
  const links = reply?.links ?? []
  const diagnostics = reply?.diagnostics ?? []

  const filtered = useMemo(() => filterRepoLinks(links, query), [links, query])
  const groups = useMemo(() => groupRepoLinks(filtered), [filtered])
  const flatOrdered = useMemo(
    () => groups.flatMap((group) => group.items),
    [groups],
  )

  useEffect(() => {
    setActive(0)
  }, [query, open, repo, cwd])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const refresh = async () => {
    if (sample || refreshing || (!repo && !cwd)) return
    setRefreshing(true)
    try {
      const next = (await hostRead('repo.links', {
        ...(repo ? { repo } : {}),
        ...(cwd ? { cwd } : {}),
        refresh: true,
      })) as RepoLinksReply
      client.setQueryData(queryKey, next)
    } catch (err) {
      toast(err instanceof Error ? err.message : t`Failed to refresh links`)
    } finally {
      setRefreshing(false)
    }
  }

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && query) {
      event.preventDefault()
      event.stopPropagation()
      setQuery('')
      return
    }
    if (!flatOrdered.length) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => (i + 1) % flatOrdered.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => (i - 1 + flatOrdered.length) % flatOrdered.length)
    } else if (event.key === 'Enter') {
      const chosen = flatOrdered[active] ?? flatOrdered[0]
      event.preventDefault()
      trace('repo-link-open', {
        type: chosen.type,
        source: chosen.source,
        via: 'keyboard',
      })
      window.open(chosen.url, '_blank', 'noopener,noreferrer')
    }
  }

  const targetLabel = target?.label ?? ''
  const title = targetLabel ? t`${targetLabel} · Links` : t`Repository links`

  let flatIndex = 0
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      testId="repo-links-sheet"
      className="h-[min(30rem,80dvh)]"
    >
      <div data-testid="repo-links-body" className="grid gap-3 px-4">
        <div className="flex items-center gap-2">
          <label className="relative min-w-0 flex-1">
            <Search
              size={15}
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-brand-label"
            />
            <Input
              ref={searchRef}
              variant="field"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder={t`Search links…`}
              aria-label={t`Search links`}
              data-testid="repo-links-search"
              className="h-9 min-h-9 w-full pl-8 pr-8 text-caption"
            />
            {query ? (
              <Button
                type="button"
                variant="plain"
                size="none"
                aria-label={t`Clear search`}
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-1 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-brand-muted"
              >
                <X size={14} aria-hidden />
              </Button>
            ) : null}
          </label>
          {!sample ? (
            <Button
              type="button"
              variant="plain"
              size="none"
              data-testid="repo-links-refresh"
              aria-label={t`Refresh links`}
              title={t`Refresh links`}
              disabled={refreshing || read.isPending}
              onClick={() => void refresh()}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-brand-muted hover:text-brand-text disabled:opacity-40"
            >
              <RefreshCw
                size={15}
                aria-hidden
                className={cn(refreshing && 'animate-spin')}
              />
            </Button>
          ) : null}
        </div>

        {error ? (
          <p className="py-6 text-center text-caption text-brand-error">
            {String(error.message)}
          </p>
        ) : !reply ? (
          <RepoLinksSkeleton />
        ) : flatOrdered.length === 0 ? (
          <div className="grid gap-2 py-4 text-center">
            <p className="text-caption text-brand-muted">
              {links.length
                ? t`No links match that search.`
                : reply.cli_available
                  ? t`No links resolved for this repository.`
                  : t`vscode-links is not installed on the host.`}
            </p>
            {diagnostics.length && !links.length ? (
              <ul className="grid gap-1 rounded-xl bg-brand-surface p-3 text-left font-mono text-meta text-brand-label">
                {diagnostics.map((line) => (
                  <li key={line} className="break-words">
                    {line}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-3 pb-2">
            {groups.map((group) => (
              <section
                key={group.type}
                data-link-group={group.type}
                className="grid gap-1.5"
              >
                <h3 className="text-meta text-brand-label">
                  {labels[group.type]} · {group.items.length}
                </h3>
                <ul className="grid gap-1.5">
                  {group.items.map((link) => {
                    const idx = flatIndex++
                    return (
                      <RepoLinkRow
                        key={`${link.type}:${link.source}:${link.url}:${link.title}`}
                        link={link}
                        active={idx === active}
                        onHover={() => setActive(idx)}
                      />
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  )
}

/** `l` on a session page opens the repository links sheet (desk: Ctrl+K l). */
export function useRepoLinksKey(enabled: boolean, onOpen: () => void) {
  const latest = useRef({ enabled, onOpen })
  latest.current = { enabled, onOpen }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.key !== 'l' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        jumpPending() ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        document.querySelector('[role=dialog], [role=alertdialog]') ||
        !latest.current.enabled
      )
        return
      event.preventDefault()
      trace('repo-links', { open: true, via: 'key' })
      latest.current.onOpen()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** Button + sheet for 会话信息 (and 交互调试 sample). */
export function RepoLinksButton({
  target,
  onBeforeOpen,
  shortcut = false,
  sample,
}: {
  target: RepoLinksTarget | null
  onBeforeOpen?: () => void
  /** Bind bare `l` on the session page to open this sheet. */
  shortcut?: boolean
  sample?: RepoLinksReply
}) {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const enabled = Boolean(sample || target?.repo || target?.cwd)
  useRepoLinksKey(shortcut && enabled, () => setOpen(true))
  if (!enabled) return null
  return (
    <>
      <Button
        variant="plain"
        type="button"
        data-testid="session-repo-links-button"
        aria-haspopup="dialog"
        title={
          shortcut
            ? t`Open repository links (key: l)`
            : t`Open repository links`
        }
        onClick={() => {
          trace('repo-links', {
            open: true,
            via: 'info',
            repo: target?.label ?? '',
          })
          onBeforeOpen?.()
          setOpen(true)
        }}
        className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-brand-edge px-3 text-body font-medium"
      >
        <ExternalLink size={15} aria-hidden />
        {t`Repository links`}
      </Button>
      <RepoLinksSheet
        open={open}
        onOpenChange={setOpen}
        target={target}
        sample={sample}
      />
    </>
  )
}

/** Session list repo group heading: opens `RepoLinksSheet` when a repo/cwd is known. */
export function RepoSectionHeader({
  label,
  repoRoot,
  fallbackCwd,
  onOpen,
}: {
  label: string
  repoRoot?: string
  fallbackCwd?: string
  onOpen: (target: RepoLinksTarget) => void
}) {
  const { t } = useLingui()
  const canOpen = Boolean(repoRoot || fallbackCwd)
  return (
    <h2 className="flex h-8 items-center border-y border-brand-edge bg-brand-deck px-3 text-meta font-medium text-brand-label group-first/repo-section:border-t-0">
      {canOpen ? (
        <Button
          variant="plain"
          size="none"
          type="button"
          data-testid="repo-links-button"
          data-repo-links={label}
          aria-haspopup="dialog"
          title={t`Open repository links`}
          onClick={() => {
            trace('repo-links', { open: true, via: 'list', repo: label })
            onOpen({
              label,
              repo: repoRoot,
              cwd: repoRoot ? undefined : fallbackCwd,
            })
          }}
          className="group/repo flex h-7 w-full min-w-0 items-center gap-1.5 rounded-lg text-left text-meta font-medium text-brand-label transition-colors hover:text-brand-text focus-visible:ring-2 focus-visible:ring-brand-running"
        >
          <FolderGit2 size={13} aria-hidden className="shrink-0" />
          <span className="min-w-0 truncate">{label}</span>
          <ExternalLink
            size={12}
            aria-hidden
            className="ml-auto shrink-0 opacity-60 transition-opacity group-hover/repo:opacity-100"
          />
        </Button>
      ) : (
        <span className="flex h-7 items-center gap-1.5">
          <FolderGit2 size={13} aria-hidden className="shrink-0" />
          {label}
        </span>
      )}
    </h2>
  )
}
