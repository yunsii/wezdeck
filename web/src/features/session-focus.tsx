// 在终端中打开 — bring WezTerm to this session's tmux window and pane, the
// same jump as Enter in the Alt+/ picker. This computer only: the local
// Runtime's sessions/focus (SessionRequestHandler.cs) drops an
// `attention.jump` event that WezTerm drains on its next tick (workspace,
// tab, pane, then tmux select-window / select-pane). The host says which
// attention row to name (detail `focus`, remote_session.go sessionFocus):
// the live entry, or an archived one by id + archived_ts. Keyboard: `o`.
import { useLingui } from '@lingui/react/macro'
import { SquareTerminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { useConsoleMode } from './console-mode'
import { jumpPending } from './console-jump-keys'
import type { Detail } from './console-sessions'
import { Button } from '#/components/ui/button'
import { trace } from '#/lib/client-trace'
import { postRuntimeAction } from '#/lib/runtime-client'

export type FocusTarget = NonNullable<Detail['focus']>

function useFocusInTerminal(focus: FocusTarget | undefined) {
  const { t } = useLingui()
  const mode = useConsoleMode()
  const [busy, setBusy] = useState(false)
  const available = mode === 'local' && Boolean(focus?.session_id)
  const run = async () => {
    if (!available || !focus || busy) return
    setBusy(true)
    const started = performance.now()
    try {
      const response = await postRuntimeAction('sessions', 'focus', focus)
      trace('session-focus', {
        id: focus.session_id,
        recent: Boolean(focus.recent),
        ok: response.ok,
        ms: Math.round(performance.now() - started),
        error: response.error?.message ?? null,
      })
      if (!response.ok)
        throw new Error(response.error?.message || t`Runtime action failed`)
      toast(t`Switched WezTerm to this session`)
    } catch (error) {
      toast(error instanceof Error ? error.message : t`Runtime action failed`)
    } finally {
      setBusy(false)
    }
  }
  return { available, busy, run }
}

/** `o` on the session page (not while typing, not after the `g` jump prefix) */
export function useFocusKey(focus: FocusTarget | undefined) {
  const action = useFocusInTerminal(focus)
  const latest = useRef(action)
  latest.current = action
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.key !== 'o' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        jumpPending() ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        !latest.current.available
      )
        return
      event.preventDefault()
      void latest.current.run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function FocusInTerminal({ focus }: { focus: FocusTarget | undefined }) {
  const { t } = useLingui()
  const { available, busy, run } = useFocusInTerminal(focus)
  if (!available) return null
  return (
    <Button
      variant="plain"
      type="button"
      disabled={busy}
      title={t`Same as Enter in the Alt+/ picker (key: o)`}
      onClick={() => void run()}
      className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-brand-edge px-3 text-body font-medium disabled:opacity-40"
    >
      <SquareTerminal size={15} aria-hidden />
      {t`Open in terminal`}
    </Button>
  )
}
