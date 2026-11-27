// 重启会话 / 新开会话 in the header's 会话操作 Sheet: the desk's F5 and
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

export function RestartActions({
  agent,
  disabled,
  onNewConversation,
  onRestart,
  onDone,
}: {
  agent?: string
  disabled: boolean
  onNewConversation: () => Promise<boolean>
  /** send session.restart; true once the host took it */
  onRestart: (fresh: boolean) => Promise<boolean>
  /** close the panel */
  onDone: () => void
}) {
  const { t } = useLingui()
  // which one is waiting for 确认
  const [asking, setAsking] = useState<'new' | 'resume' | 'fresh' | null>(null)
  if (!agent || !AGENTS.has(agent)) return null
  const action =
    'flex min-h-11 min-w-0 items-center gap-3 px-2 text-left text-body disabled:opacity-40'
  if (asking) {
    const fresh = asking === 'fresh'
    const run = async () => {
      trace('session-restart', { action: asking, agent })
      setAsking(null)
      onDone()
      if (await (asking === 'new' ? onNewConversation() : onRestart(fresh)))
        toast(
          asking === 'new'
            ? t`A new conversation is starting in this agent`
            : fresh
              ? t`A fresh conversation is starting`
              : t`The pane is restarting; the agent resumes in a moment`,
        )
    }
    return (
      <div
        role="group"
        aria-label={
          asking === 'new'
            ? t`New conversation`
            : fresh
              ? t`New agent process`
              : t`Restart session`
        }
        data-testid="session-restart-confirm"
        data-restart-asking={asking}
        className="grid gap-2 py-2"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          setAsking(null)
        }}
      >
        <p className="px-1 text-caption text-brand-muted">
          {asking === 'new'
            ? t`Start a new conversation in the current agent without restarting its process. The current conversation stays available in Resume.`
            : fresh
              ? t`End this agent process and start a blank conversation in the same pane (the desk's Ctrl+Shift+n). The current conversation is kept: Resume a conversation finds it.`
              : t`Restart this session's pane on the computer; the agent resumes this conversation (the desk's F5).`}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="key"
            type="button"
            data-restart-cancel
            onClick={() => setAsking(null)}
            className="min-h-11 rounded-lg"
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
            className="min-h-11 rounded-lg"
          >
            {asking === 'new' ? t`Start` : fresh ? t`Start fresh` : t`Restart`}
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
      className="grid divide-y divide-brand-edge"
    >
      <Button
        variant="plain"
        type="button"
        disabled={disabled}
        data-restart="new"
        aria-keyshortcuts="Control+N Meta+N"
        title={t`Start /new in the current agent (Ctrl+N)`}
        onClick={() => setAsking('new')}
        className={action}
      >
        <SquarePlus size={14} aria-hidden />
        {t`New conversation (/new)`}
        <kbd
          aria-hidden
          className="ml-auto hidden shrink-0 font-mono text-meta text-brand-label md:inline"
        >
          Ctrl/⌘+N
        </kbd>
      </Button>
      <Button
        variant="plain"
        type="button"
        disabled={disabled}
        data-restart="fresh"
        aria-keyshortcuts="Control+Shift+N Meta+Shift+N"
        title={t`A blank agent process and conversation (Ctrl+Shift+n)`}
        onClick={() => setAsking('fresh')}
        className={action}
      >
        <SquarePlus size={14} aria-hidden />
        {t`New agent process`}
        <kbd
          aria-hidden
          className="ml-auto hidden shrink-0 font-mono text-meta text-brand-label md:inline"
        >
          Ctrl/⌘+Shift+N
        </kbd>
      </Button>
      <Button
        variant="plain"
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
    </div>
  )
}
