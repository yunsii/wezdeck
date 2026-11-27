// Terminal control keys in the session actions sheet.
import { useLingui } from '@lingui/react/macro'
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
}: {
  disabled: boolean
  onKey: (key: string) => void
  onClose: () => void
}) {
  const { t } = useLingui()
  const keys = useQuickKeys()
  return (
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
          className="grid h-11 place-content-center gap-0.5 rounded-lg px-1 disabled:opacity-40"
        >
          <span className="text-body leading-none font-medium">{label}</span>
          <span className="text-meta leading-none text-brand-label">
            {hint}
          </span>
        </Button>
      ))}
    </div>
  )
}
