import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { AnimatePresence, m } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { collabKey } from '#/lib/collab-query'
import { trace } from '#/lib/client-trace'
import { dropIn } from '#/lib/motion'
import { LIST_PARAMS } from '#/lib/ticket-sync'
import { detailKey } from './session-detail-read'

const SESSION_LIST_KEY = ['remote', 'sessions'] as const
const TICKET_KEYS: Array<QueryKey> = [
  collabKey('health'),
  collabKey('list', LIST_PARAMS),
]

type Notice = {
  phase: 'loading' | 'synced' | 'failed'
  round: number
  at: number
  previousAt: number
  currentAt?: number
}

const isFailedEnvelope = (data: unknown) =>
  typeof data === 'object' && data !== null && 'ok' in data && data.ok === false

/** The shell keeps non-session reads warm; session views refresh their own query. */
export function foregroundSyncKeys(pathname: string): Array<QueryKey> {
  const keys: Array<QueryKey> = pathname.includes('/console/sessions')
    ? [...TICKET_KEYS]
    : [SESSION_LIST_KEY, ...TICKET_KEYS]
  const ticket = pathname.match(/\/console\/(?:collab|inbox)\/([^/]+)$/)?.[1]
  if (ticket) keys.push(collabKey('show', { id: decodeURIComponent(ticket) }))
  return keys
}

export function foregroundSyncState(
  client: QueryClient,
  key: QueryKey,
  wakeAt = 0,
) {
  const state = client.getQueryState(key)
  const lastAt = state?.dataUpdatedAt ?? 0
  const failed = state?.status === 'error' || isFailedEnvelope(state?.data)
  return {
    lastAt,
    failed,
    fresh: !failed && state?.status === 'success' && lastAt >= wakeAt,
  }
}

export function useForegroundCoreRefresh(pathname: string) {
  const client = useQueryClient()
  useEffect(() => {
    const keys = foregroundSyncKeys(pathname)
    const refresh = () => {
      if (document.visibilityState !== 'visible' || navigator.onLine === false)
        return
      for (const queryKey of keys)
        void client.refetchQueries({ queryKey, exact: true, type: 'active' })
    }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('online', refresh)
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('online', refresh)
    }
  }, [client, pathname])
}

export function useForegroundSyncNotice(kind: 'list' | 'detail', id?: string) {
  const client = useQueryClient()
  const key = useMemo(
    () => (kind === 'list' ? SESSION_LIST_KEY : detailKey(id ?? '')),
    [kind, id],
  )
  const round = useRef(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const refresh = useCallback(() => {
    if (document.visibilityState !== 'visible') return
    const currentRound = ++round.current
    const at = Date.now()
    const previousAt = foregroundSyncState(client, key).lastAt
    if (navigator.onLine === false) {
      setNotice({ phase: 'failed', round: currentRound, at, previousAt })
      trace('foreground-sync', { scope: kind, outcome: 'offline' })
      return
    }
    setNotice({ phase: 'loading', round: currentRound, at, previousAt })
    const settle = () => {
      const state = foregroundSyncState(client, key, at)
      const phase = state.fresh ? 'synced' : 'failed'
      trace('foreground-sync', {
        scope: kind,
        outcome: phase,
        ms: Date.now() - at,
      })
      setNotice((current) =>
        current?.round === currentRound
          ? {
              phase,
              round: currentRound,
              at,
              previousAt,
              currentAt: state.lastAt,
            }
          : current,
      )
    }
    void client
      .refetchQueries({ queryKey: key, exact: true, type: 'active' })
      .then(settle, settle)
  }, [client, key, kind])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
      else {
        round.current++
        setNotice(null)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', refresh)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', refresh)
    }
  }, [refresh])

  useEffect(() => {
    if (!notice || notice.phase === 'loading') return
    const timer = setTimeout(
      () =>
        setNotice((current) =>
          current?.round === notice.round ? null : current,
        ),
      notice.phase === 'synced' ? 1_500 : 3_000,
    )
    return () => clearTimeout(timer)
  }, [notice])

  return notice
}

export function ForegroundSyncNotice({
  kind,
  notice,
}: {
  kind: 'list' | 'detail'
  notice: Notice | null
}) {
  const { t } = useLingui()
  const at = notice?.phase === 'synced' ? notice.currentAt : notice?.previousAt
  const time = at
    ? new Date(at).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : ''
  const text =
    notice?.phase === 'loading'
      ? time
        ? t`Syncing · last synced ${time}`
        : t`Fetching latest status…`
      : notice?.phase === 'failed'
        ? time
          ? t`Unable to sync · last synced ${time}`
          : t`Unable to sync`
        : t`Synced ${time}`

  return (
    <AnimatePresence>
      {notice ? (
        <m.div
          key={kind}
          {...dropIn}
          data-testid={`foreground-sync-${kind}`}
          data-state={notice.phase}
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute inset-x-0 top-[calc(100%+0.375rem)] z-40 flex justify-center px-2"
        >
          <span className="inline-flex min-h-7 max-w-full items-center gap-1.5 border border-brand-edge bg-brand-deck px-2.5 text-meta text-brand-muted shadow-sm">
            <span className="truncate">{text}</span>
            {notice.phase === 'loading' ? (
              <RefreshCw
                size={12}
                className="shrink-0 animate-spin"
                aria-hidden
              />
            ) : null}
          </span>
        </m.div>
      ) : null}
    </AnimatePresence>
  )
}
