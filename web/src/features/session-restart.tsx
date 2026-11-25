// 重启会话 / 新开会话 in the composer's 按键 panel: the desk's F5 and
// Ctrl+Shift+n for this session's own pane (relay `session.restart`,
// native/wezdeck-wsl/session_restart.go → scripts/runtime/session-restart.sh).
// Both ask first: one ends the agent process, the other replaces the
// conversation. After 新开会话 on Claude the host marks the old session
// cleared_to the new one, and the page follows it (useFollowReplacement).
import { useLingui } from '@lingui/react/macro'
import { RotateCcw, SquarePlus } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { trace } from '#/lib/client-trace'

const AGENTS = new Set(['claude', 'codex', 'grok'])

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
  if (!agent || !AGENTS.has(agent)) return null
  const run = async (fresh: boolean) => {
    const ask = fresh
      ? t`End this agent process and start a blank conversation in the same pane (the desk's Ctrl+Shift+n). The current conversation is kept: Resume a conversation finds it. Continue?`
      : t`Restart this session's pane on the computer; the agent resumes this conversation (the desk's F5). Continue?`
    if (!window.confirm(ask)) return
    trace('session-restart', { fresh, agent })
    onDone()
    if (await onRestart(fresh))
      toast(
        fresh
          ? t`A fresh conversation is starting`
          : t`The pane is restarting; the agent resumes in a moment`,
      )
  }
  const action =
    'flex h-10 items-center justify-center gap-1.5 rounded-xl px-2 text-caption disabled:opacity-40'
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
        onClick={() => void run(false)}
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
        onClick={() => void run(true)}
        className={action}
      >
        <SquarePlus size={14} aria-hidden />
        {t`New conversation`}
      </Button>
    </div>
  )
}
