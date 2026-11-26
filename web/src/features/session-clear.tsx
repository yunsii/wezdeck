// "Mark as read" — wezdeck's Ctrl+X in the Alt+/ picker: archive one live
// attention entry (host `clear`, remote_clear.go → attention-jump.sh
// --forget) so a stuck ● / ▲ / ✓ stops counting. On the phone: swipe a
// session row left; with a keyboard / pointer: the button in 会话信息.
// Needs an approved device (signed write). A done session that stays on
// screen is cleared on its own (useSeenAck).
import { useLingui } from '@lingui/react/macro'
import { trace } from '#/lib/client-trace'
import { hostWrite } from '#/lib/runtime-client'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { useDeviceState } from './device-state'
import { Button } from '#/components/ui/button'
import { SwipeActions } from './session-row-swipe'

/** an entry counts while running / waiting / done; idle ones have nothing to clear */
export const clearable = (status: string, waitingKind?: string) =>
  Boolean(waitingKind) || ['running', 'waiting', 'done'].includes(status)

/** on screen this long before a done counts as seen (the desk's floor) */
const SEEN_AFTER_MS = 1_500
/** id:ts already acked from this page, so a re-render or poll sends once */
const acked = new Set<string>()

/**
 * Seen on the web = seen at the desk: a `done` session open on this page,
 * in the foreground, for SEEN_AFTER_MS is cleared on the host like a focus-
 * ack (✓ badge and counter drop). Done only — a waiting one stays until it
 * is answered, as at the desk. The write names the ts and status it saw,
 * so a session that moved on meanwhile is skipped by the host
 * (remote_clear.go), never swallowed.
 */
export function useSeenAck(
  id: string,
  status: string | undefined,
  ts: number | undefined,
  writable: boolean,
) {
  const client = useQueryClient()
  useEffect(() => {
    if (status !== 'done' || !ts || !writable) return
    const key = `${id}:${ts}`
    if (acked.has(key)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      clearTimeout(timer)
      if (document.visibilityState !== 'visible') return
      timer = setTimeout(() => {
        if (document.visibilityState !== 'visible' || acked.has(key)) return
        acked.add(key)
        hostWrite('clear', { id, ts, status: 'done' })
          .then((result) => {
            const skipped = (result as { skipped?: string } | null)?.skipped
            trace('session-seen-ack', { id, ts, skipped: skipped ?? null })
            return client.invalidateQueries({ queryKey: ['remote'] })
          })
          .catch((error: unknown) => {
            acked.delete(key) // try again next time it is on screen
            trace('session-seen-ack', { id, ts, error: String(error) })
          })
      }, SEEN_AFTER_MS)
    }
    arm()
    document.addEventListener('visibilitychange', arm)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', arm)
    }
  }, [id, status, ts, writable, client])
}

export function useClearSession() {
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const clear = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      await hostWrite('clear', { id })
      await client.invalidateQueries({ queryKey: ['remote'] })
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }
  return { clear, busy, error }
}

/** @deprecated prefer SwipeActions from session-row-swipe; kept for call sites that only need mark-read */
export function SwipeToClear({
  id,
  enabled,
  children,
}: {
  id: string
  enabled: boolean
  children: React.ReactNode
}) {
  const { t } = useLingui()
  const device = useDeviceState()
  const { clear, error } = useClearSession()
  if (!enabled || device.state !== 'approved') return <>{children}</>
  return (
    <>
      <SwipeActions
        id={id}
        right={{
          label: t`Mark read`,
          busyLabel: t`Clearing…`,
          className: 'bg-brand-done text-white',
          onAction: () => clear(id),
        }}
      >
        {children}
      </SwipeActions>
      {error ? (
        <p role="alert" className="px-4 pb-2 text-meta text-brand-error">
          {error}
        </p>
      ) : null}
    </>
  )
}

/** the keyboard / pointer path, in 会话信息 */
export function ClearButton({
  id,
  status,
  waitingKind,
}: {
  id: string
  status: string
  waitingKind?: string
}) {
  const { t } = useLingui()
  const device = useDeviceState()
  const { clear, busy, error } = useClearSession()
  const [done, setDone] = useState(false)
  if (device.state !== 'approved' || !clearable(status, waitingKind))
    return null
  return (
    <div className="grid gap-1">
      <Button
        variant="plain"
        type="button"
        data-write
        disabled={busy || done}
        title={t`Same as Ctrl+X in the Alt+/ picker`}
        onClick={() => void clear(id).then(setDone)}
        className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-brand-edge px-3 text-body font-medium disabled:opacity-40"
      >
        {done ? t`Marked read` : t`Mark read`}
      </Button>
      {error ? (
        <p role="alert" className="px-1 text-meta text-brand-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
