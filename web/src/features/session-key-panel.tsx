// The composer's 按键 panel: Enter / Esc / Ctrl+C into the agent pane, and
// below them whatever the composer adds (重启会话 / 新开会话, session-restart.tsx).
// Split from session-composer.tsx.
import { useLingui } from '@lingui/react/macro'
import { X } from 'lucide-react'

import { Button } from '#/components/ui/button'

/**
 * The three keys any agent TUI understands. Choices (digits, arrows, Tab)
 * are not here: questions and plans get their own tap targets on the page
 * (session-elicitation.tsx, permission keys), which is where they belong;
 * so does Claude Code's Ctrl+B — 转到后台 on the running call's own row, shown only
 * while a foreground command or subagent runs (chat-thread.tsx).
 */
function useQuickKeys() {
  const { t } = useLingui()
  return [
    { key: 'Enter', label: 'Enter', hint: t`confirm` },
    { key: 'Escape', label: 'Esc', hint: t`cancel` },
    { key: 'C-c', label: 'Ctrl+C', hint: t`interrupt` },
  ] as const
}

/**
 * Confirm / cancel / interrupt for the session TUI (Ctrl+C stops Grok).
 * Opens above the toolbar like every tool; each key says what it does,
 * and the panel closes once a key is sent.
 */
export function KeyPanel({
  disabled,
  onKey,
  onClose,
  children,
}: {
  disabled: boolean
  onKey: (key: string) => void
  onClose: () => void
  /** under the keys: 重启会话 / 新开会话 */
  children?: React.ReactNode
}) {
  const { t } = useLingui()
  const keys = useQuickKeys()
  return (
    <div data-write className="grid gap-1.5 rounded-2xl bg-brand-surface p-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-meta text-brand-label">
          {disabled
            ? t`Turn on write access in Settings to send these keys`
            : t`Tap to send into the agent pane`}
        </span>
        <Button
          variant="plain"
          type="button"
          onClick={onClose}
          aria-label={t`Close keys`}
          className="inline-flex size-7 items-center justify-center rounded-full text-brand-muted"
        >
          <X size={14} aria-hidden />
        </Button>
      </div>
      <div
        role="group"
        aria-label={t`Quick keys`}
        data-testid="session-quick-keys"
        className="grid grid-cols-3 gap-1.5"
      >
        {keys.map(({ key, label, hint }) => (
          <Button
            variant="key"
            key={key}
            type="button"
            disabled={disabled}
            onClick={() => {
              onKey(key)
              onClose()
            }}
            className="grid h-12 place-content-center gap-0.5 rounded-xl px-1 disabled:opacity-40"
          >
            <span className="text-body leading-none font-medium">{label}</span>
            <span className="text-meta leading-none text-brand-label">
              {hint}
            </span>
          </Button>
        ))}
      </div>
      {children}
    </div>
  )
}
