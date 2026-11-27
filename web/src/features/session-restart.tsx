// 重启会话 / 新开会话 in the composer's 按键 panel: the desk's F5 and
// Ctrl+Shift+n for this session's own pane (relay `session.restart`,
// native/wezdeck-wsl/session_restart.go → scripts/runtime/session-restart.sh).
// Both ask first, in place — the pair turns into what it will do plus
// 确认 / 取消 (focus on 确认, Esc cancels); a browser confirm() dialog read
// as the browser blocking something. After 新开会话 on Claude the host marks
// the old session cleared_to the new one, and the page follows
// (useFollowReplacement).
import { useLingui } from '@lingui/react/macro'
import { RotateCcw, SquarePlus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { trace } from '#/lib/client-trace'

const AGENTS = new Set(['claude', 'codex', 'grok', 'agy'])

/** Compact same-pane fresh conversation action for the composer toolbar. */
export function QuickNewConversation({
  onStart,
}: {
  onStart: () => Promise<boolean>
}) {
  const { t } = useLingui()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const chip =
    'inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-brand-surface px-2.5 text-caption text-brand-muted'
  if (asking)
    return (
      <span className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-brand-surface px-1 text-caption">
        <span className="px-1 text-brand-muted">{t`Start a blank conversation?`}</span>
        <Button
          variant="solid"
          size="none"
          type="button"
          disabled={busy}
          autoFocus
          onClick={() => {
            setBusy(true)
            void onStart().then((ok) => {
              setBusy(false)
              if (ok) setAsking(false)
            })
          }}
          className="h-7 rounded-full px-2 text-caption"
        >
          {t`Start`}
        </Button>
        <Button
          variant="plain"
          size="none"
          type="button"
          disabled={busy}
          onClick={() => setAsking(false)}
          className="h-7 rounded-full px-2 text-caption text-brand-muted"
        >
          {t`Cancel`}
        </Button>
      </span>
    )
  return (
    <Button
      variant="plain"
      type="button"
      title={t`Start a blank conversation in this pane`}
      aria-label={t`New conversation`}
      onClick={() => setAsking(true)}
      className={chip}
      data-testid="quick-new-conversation"
    >
      <SquarePlus size={14} aria-hidden />
      {t`New conversation`}
    </Button>
  )
}

export function RestartActions({
  agent,
  disabled,
  onRestart,
  onDone,
}: {
  agent?: string
  disabled: boolean
  /** send session.restart; true once the host took it */
  onRestart: (fresh: boolean) => Promise<boolean>
  /** close the panel */
  onDone: () => void
}) {
  const { t } = useLingui()
  // which one is waiting for 确认
  const [asking, setAsking] = useState<'resume' | 'fresh' | null>(null)
  if (!agent || !AGENTS.has(agent)) return null
  const action =
    'flex h-10 items-center justify-center gap-1.5 rounded-xl px-2 text-caption disabled:opacity-40'
  if (asking) {
    const fresh = asking === 'fresh'
    const run = async () => {
      trace('session-restart', { fresh, agent })
      setAsking(null)
      onDone()
      if (await onRestart(fresh))
        toast(
          fresh
            ? t`A fresh conversation is starting`
            : t`The pane is restarting; the agent resumes in a moment`,
        )
    }
    return (
      <div
        role="group"
        aria-label={fresh ? t`New conversation` : t`Restart session`}
        data-testid="session-restart-confirm"
        data-restart-asking={asking}
        className="grid gap-1.5 rounded-xl bg-brand-deck p-2"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          setAsking(null)
        }}
      >
        <p className="px-1 text-caption text-brand-muted">
          {fresh
            ? t`End this agent process and start a blank conversation in the same pane (the desk's Ctrl+Shift+n). The current conversation is kept: Resume a conversation finds it.`
            : t`Restart this session's pane on the computer; the agent resumes this conversation (the desk's F5).`}
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            variant="key"
            type="button"
            data-restart-cancel
            onClick={() => setAsking(null)}
            className={action}
          >
            {t`Cancel`}
          </Button>
          <Button
            variant="solid"
            type="button"
            data-restart-confirm
            autoFocus
            disabled={disabled}
            onClick={() => void run()}
            className={action}
          >
            {fresh ? t`Start fresh` : t`Restart`}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div
      role="group"
      aria-label={t`Restart`}
      data-testid="session-restart"
      className="grid grid-cols-2 gap-1.5"
    >
      <Button
        variant="key"
        type="button"
        disabled={disabled}
        data-restart="resume"
        title={t`Respawn the pane; the agent resumes this conversation (F5)`}
        onClick={() => setAsking('resume')}
        className={action}
      >
        <RotateCcw size={14} aria-hidden />
        {t`Restart session`}
      </Button>
      <Button
        variant="key"
        type="button"
        disabled={disabled}
        data-restart="fresh"
        title={t`A blank agent process and conversation (Ctrl+Shift+n)`}
        onClick={() => setAsking('fresh')}
        className={action}
      >
        <SquarePlus size={14} aria-hidden />
        {t`New conversation`}
      </Button>
    </div>
  )
}
