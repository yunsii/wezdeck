import { useLingui } from '@lingui/react/macro'
import { Square } from 'lucide-react'

import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'
import { Sheet } from '#/components/ui/sheet'
import { trace } from '#/lib/client-trace'
import { HandoffActions } from './session-handoff'
import { KeyPanel } from './session-key-panel'
import { RestartActions } from './session-restart'

export function SessionActionsSheet({
  id,
  agent,
  running,
  disabled,
  open,
  onOpenChange,
  onRun,
  onNewConversation,
}: {
  id: string
  agent?: string
  running: boolean
  disabled: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onRun: (
    action: 'key' | 'session.restart',
    args: Record<string, unknown>,
  ) => Promise<boolean>
  onNewConversation: () => Promise<boolean>
}) {
  const { t } = useLingui()
  const close = () => onOpenChange(false)
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t`Session actions`}
      testId="session-actions-sheet"
      write
    >
      <div className="grid gap-3 px-4">
        {running ? (
          <Button
            variant="plain"
            type="button"
            disabled={disabled}
            onClick={() => {
              trace('session-controls', { action: 'interrupt' })
              void onRun('key', { key: 'C-c' })
              close()
            }}
            className="flex min-h-11 items-center gap-3 border-b border-brand-edge px-2 text-left text-body text-brand-waiting"
          >
            <Square size={17} aria-hidden />
            {t`Interrupt`}
          </Button>
        ) : null}
        <RestartActions
          agent={agent}
          disabled={disabled}
          onNewConversation={onNewConversation}
          onRestart={(fresh) => onRun('session.restart', { fresh })}
          onDone={close}
        />
        <Disclosure
          title={t`Terminal keys`}
          className="border-t border-brand-edge"
          triggerClassName="px-2 text-brand-text"
          panelClassName="pb-2"
        >
          <KeyPanel
            disabled={disabled}
            onKey={(key) => void onRun('key', { key })}
            onClose={close}
          />
        </Disclosure>
        <Disclosure
          title={t`Switch agent`}
          className="border-t border-brand-edge"
          triggerClassName="px-2 text-brand-text"
          panelClassName="pb-2"
        >
          <HandoffActions
            id={id}
            agent={agent}
            disabled={disabled}
            onDone={close}
          />
        </Disclosure>
      </div>
    </Sheet>
  )
}
