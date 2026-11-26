// A Claude permission prompt as a card (host permission.go): the call the
// agent is blocked on — the command, the diff, or for ExitPlanMode the plan —
// from the transcript, not the screen. Only the answers whose keys hold
// whatever the dialog offers: 1 is the first "Yes" (the plan dialog's first
// "Yes …" option, which varies by mode), Esc is "No, and tell Claude what to
// do differently" / "No, keep planning". The middle options (don't ask
// again, edit modes) depend on the tool and mode — answer those at the desk.
import { useLingui } from '@lingui/react/macro'

import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'
import { ToolBody } from './chat-diff'
import { ChatMarkdown } from './chat-markdown'

export type PendingCall = {
  tool: string
  text: string
  body?: string
  file?: string
  plan?: boolean
}

/** the keys each answer sends, also listed on the 交互调试 page */
export const PERMISSION_KEYS = { allow: '1', deny: 'Escape' } as const

export function PermissionCard({
  agent,
  call,
  screen,
  disabled,
  onKey,
}: {
  agent?: string
  call: PendingCall
  screen?: string
  disabled: boolean
  onKey: (key: string) => void
}) {
  const { t } = useLingui()
  const isAgy = agent === 'agy'
  const allowKey = isAgy ? 'Enter' : PERMISSION_KEYS.allow
  const target = call.text.startsWith(`${call.tool} `)
    ? call.text.slice(call.tool.length + 1)
    : ''
  return (
    <div
      data-write
      data-testid="permission-card"
      className="grid gap-2.5 rounded-2xl bg-brand-surface p-3"
    >
      <p className="text-body font-medium">
        {call.plan
          ? t`Claude wants to leave plan mode and start on this plan`
          : isAgy
            ? t`Antigravity asks to run this`
            : t`Claude asks to run this`}
      </p>
      {call.plan ? (
        <div className="max-h-96 overflow-y-auto rounded-xl bg-brand-deck px-3 py-2">
          <ChatMarkdown text={call.body ?? ''} />
        </div>
      ) : (
        <div className="grid gap-1.5">
          <p className="flex min-w-0 items-baseline gap-2 text-caption">
            <span className="shrink-0 text-brand-label">{call.tool}</span>
            {/* a command is shown whole below, not twice */}
            {call.body !== target ? (
              <span className="min-w-0 truncate font-mono text-caption">
                {target}
              </span>
            ) : null}
          </p>
          {call.body ? <ToolBody text={call.body} file={call.file} /> : null}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="solid"
          type="button"
          disabled={disabled}
          onClick={() => onKey(allowKey)}
          className="min-h-11 px-3 text-body disabled:opacity-40"
        >
          {call.plan ? t`Approve the plan` : t`Allow`}
        </Button>
        <Button
          variant="key"
          type="button"
          disabled={disabled}
          onClick={() => onKey(PERMISSION_KEYS.deny)}
          className="min-h-11 px-3 text-body disabled:opacity-40"
        >
          {call.plan ? t`Keep planning` : t`Deny`}
        </Button>
      </div>
      <p className="text-meta leading-relaxed text-brand-label">
        {call.plan
          ? t`Approve takes Claude's first option (its default edit mode). After keep planning, say in the box below what to change.`
          : isAgy
            ? t`Allow confirms the highlighted Yes option (Enter); Deny sends Esc. Persistent allow rules stay at the terminal.`
            : t`After deny, say in the box below what to do instead. "Don't ask again" and other options are at the desk.`}
      </p>
      {screen ? (
        <Disclosure
          title={t`Terminal`}
          triggerClassName="min-h-8 text-caption font-normal text-brand-label"
        >
          <pre className="max-h-48 overflow-auto font-mono text-meta leading-snug text-brand-muted">
            {screen.split('\n').slice(-14).join('\n')}
          </pre>
        </Disclosure>
      ) : null}
    </div>
  )
}
