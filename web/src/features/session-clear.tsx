// "Mark as read" — wezdeck's Ctrl+X in the Alt+/ picker: archive one live
// attention entry (host `clear`, remote_clear.go → attention-jump.sh
// --forget) so a stuck ● / ▲ / ✓ stops counting. On the phone: swipe a
// session row left; with a keyboard / pointer: the button in 会话信息.
// Needs an approved device (signed write).
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'

import { remoteLink } from '#/lib/remote-link'
import { useDeviceState } from './device-state'
import { Button } from '#/components/ui/button'

const OPEN = 104 // px the row slides to show the action
const ARM = 48 // drag past this to open

/** an entry counts while running / waiting / done; idle ones have nothing to clear */
export const clearable = (status: string, waitingKind?: string) =>
  Boolean(waitingKind) || ['running', 'waiting', 'done'].includes(status)

export function useClearSession() {
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const clear = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      await remoteLink.write('clear', { id })
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
  const { clear, busy, error } = useClearSession()
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{
    x: number
    y: number
    base: number
    axis?: 'x' | 'y'
  }>(null)
  if (!enabled || device.state !== 'approved') return <>{children}</>
  const open = offset <= -OPEN + 1
  return (
    <div className="relative overflow-hidden" data-swipe={id}>
      <Button
        variant="plain"
        type="button"
        disabled={busy}
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        onClick={() => void clear(id).then((ok) => ok && setOffset(0))}
        className="absolute inset-y-0 right-0 flex items-center justify-center bg-brand-done px-3 text-[14px] font-semibold text-white disabled:opacity-60"
        style={{ width: OPEN }}
      >
        {busy ? t`Clearing…` : t`Mark read`}
      </Button>
      <div
        className="relative bg-brand-surface touch-pan-y"
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? 'none' : 'transform 180ms ease-out',
        }}
        onTouchStart={(event) => {
          const touch = event.touches[0]
          start.current = { x: touch.clientX, y: touch.clientY, base: offset }
        }}
        onTouchMove={(event) => {
          const s = start.current
          if (!s) return
          const touch = event.touches[0]
          const dx = touch.clientX - s.x
          const dy = touch.clientY - s.y
          // decide once per gesture: a vertical drag scrolls the list
          s.axis ??=
            Math.abs(dx) > Math.abs(dy) + 4
              ? 'x'
              : Math.abs(dy) > 6
                ? 'y'
                : undefined
          if (s.axis !== 'x') return
          setDragging(true)
          setOffset(Math.max(-OPEN - 24, Math.min(0, s.base + dx)))
        }}
        onTouchEnd={() => {
          const s = start.current
          start.current = null
          setDragging(false)
          if (s?.axis !== 'x') return
          setOffset(
            offset < s.base - ARM || (s.base < 0 && offset < -ARM) ? -OPEN : 0,
          )
        }}
        // an open row closes on tap instead of opening the session
        onClickCapture={(event) => {
          if (offset !== 0) {
            event.preventDefault()
            event.stopPropagation()
            setOffset(0)
          }
        }}
      >
        {children}
      </div>
      {error ? (
        <p role="alert" className="px-4 pb-2 text-xs text-brand-error">
          {error}
        </p>
      ) : null}
    </div>
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
        className="flex min-h-11 items-center justify-center gap-2 rounded-[12px] border border-brand-edge px-3 text-[14px] font-medium disabled:opacity-40"
      >
        {done ? t`Marked read` : t`Mark read`}
      </Button>
      {error ? (
        <p role="alert" className="px-1 text-xs text-brand-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
