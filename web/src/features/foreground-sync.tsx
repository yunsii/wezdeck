import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '#/components/ui/button'
import { collabKey } from '#/lib/collab-query'
import { LIST_PARAMS } from '#/lib/ticket-sync'
import { trace } from '#/lib/client-trace'
import { detailKey } from './session-detail-read'

const CORE_KEYS: Array<QueryKey> = [
  ['remote', 'sessions'],
  collabKey('health'),
  collabKey('list', LIST_PARAMS),
]

const isFailedEnvelope = (data: unknown) =>
  typeof data === 'object' && data !== null && 'ok' in data && data.ok === false

export function foregroundSyncKeys(pathname: string): Array<QueryKey> {
  const session = pathname.match(/\/console\/sessions\/([^/]+)$/)?.[1]
  const ticket = pathname.match(/\/console\/(?:collab|inbox)\/([^/]+)$/)?.[1]
  if (session) return [...CORE_KEYS, detailKey(decodeURIComponent(session))]
  if (ticket)
    return [...CORE_KEYS, collabKey('show', { id: decodeURIComponent(ticket) })]
  return CORE_KEYS
}

export function foregroundSyncState(
  client: QueryClient,
  keys: Array<QueryKey>,
  wakeAt = 0,
) {
  const states = keys.map((key) => client.getQueryState(key))
  const complete = states.every(
    (state) => state?.dataUpdatedAt && !isFailedEnvelope(state.data),
  )
  const lastAt = complete
    ? Math.min(...states.map((state) => state!.dataUpdatedAt))
    : 0
  return {
    lastAt,
    failed: states.some(
      (state) => state?.status === 'error' || isFailedEnvelope(state?.data),
    ),
    fresh:
      complete &&
      states.every(
        (state) =>
          state!.status === 'success' && state!.dataUpdatedAt >= wakeAt,
      ),
  }
}

export function ForegroundSync({ pathname }: { pathname: string }) {
  const { t } = useLingui()
  const client = useQueryClient()
  const [, setRevision] = useState(0)
  const [wake, setWake] = useState({ at: 0, waiting: false })
  const keys = useMemo(() => foregroundSyncKeys(pathname), [pathname])
  const keyNames = useMemo(() => keys.map((key) => JSON.stringify(key)), [keys])

  useEffect(() => {
    const names = new Set(keyNames)
    return client.getQueryCache().subscribe((event) => {
      if (names.has(JSON.stringify(event.query.queryKey)))
        setRevision((value) => value + 1)
    })
  }, [client, keyNames])

  const refresh = useCallback(() => {
    const at = Date.now()
    setWake({ at, waiting: true })
    if (navigator.onLine === false) {
      trace('foreground-sync', { outcome: 'offline', keys: keys.length })
      setWake({ at, waiting: false })
      return
    }
    void Promise.allSettled(
      keys.map((queryKey) =>
        client.refetchQueries({ queryKey, exact: true, type: 'active' }),
      ),
    ).then(() => {
      trace('foreground-sync', {
        outcome: foregroundSyncState(client, keys, at).fresh
          ? 'synced'
          : 'failed',
        ms: Date.now() - at,
        keys: keys.length,
      })
      setWake((current) =>
        current.at === at ? { at, waiting: false } : current,
      )
    })
  }, [client, keys])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', refresh)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', refresh)
    }
  }, [refresh])

  const state = foregroundSyncState(client, keys, wake.at)
  const loading =
    wake.waiting || (wake.at === 0 && !state.failed && !state.fresh)
  const failed = !loading && (state.failed || (wake.at > 0 && !state.fresh))
  const time = state.lastAt
    ? new Date(state.lastAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : ''
  const text = loading
    ? time
      ? t`Syncing · last synced ${time}`
      : t`Fetching latest status…`
    : failed
      ? time
        ? t`Unable to sync · last synced ${time}`
        : t`Unable to sync`
      : t`Synced ${time}`

  return (
    <div
      data-testid="foreground-sync"
      data-state={loading ? 'loading' : failed ? 'failed' : 'synced'}
      role="status"
      aria-live="polite"
      className="flex h-7 min-w-0 items-center justify-center gap-1.5 border-t border-brand-edge bg-brand-deck px-3 text-meta text-brand-muted"
    >
      <span className="truncate">{text}</span>
      {loading ? (
        <RefreshCw size={12} className="shrink-0 animate-spin" aria-hidden />
      ) : failed ? (
        <Button
          variant="plain"
          size="none"
          type="button"
          onClick={refresh}
          title={t`Retry sync`}
          aria-label={t`Retry sync`}
          className="grid size-6 shrink-0 place-items-center text-brand-text focus-visible:ring-2 focus-visible:ring-brand-running"
        >
          <RefreshCw size={14} aria-hidden />
        </Button>
      ) : null}
    </div>
  )
}
