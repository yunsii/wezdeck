// Generic permission key strip and Grok plan review card (split out of
// session-elicitation.tsx to keep both files small and focused).
import { useLingui } from '@lingui/react/macro'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'
import { ChatMarkdown } from './chat-markdown'
import {
  PromptActionStatus,
  promptButtonClass,
  usePromptAction,
} from './prompt-action-state'
import type { PromptResolveFn } from './session-elicitation'

/** Permission-prompt strip (Claude-style 1/2/3/Enter) when Ask payload is absent. */
export function SessionPermissionKeys({
  screen,
  disabled,
  onKey,
  promptKey,
  onResolve,
}: {
  screen?: string
  disabled: boolean
  onKey: (key: string) => Promise<unknown> | void
  promptKey?: string
  onResolve?: PromptResolveFn
}) {
  const { t } = useLingui()
  // Keyed on screen so if the terminal moves to a follow-up screen the keys unlock.
  const { pending, run } = usePromptAction(screen ?? 'keys')
  const press = (key: string) => {
    const cancel = key === 'Escape' || key === 'C-c'
    if (onResolve) {
      void onResolve({
        kind: cancel ? 'prompt-cancel' : 'prompt-submit',
        promptKey: promptKey ?? screen ?? 'keys',
        execute: async () => (await onKey(key)) !== false,
      })
      return
    }
    void run(key, () => onKey(key), {
      kind: cancel ? 'cancel' : 'submit',
    })
  }
  return (
    <div
      data-write
      data-testid="session-permission-keys"
      aria-busy={Boolean(pending)}
      className={cn(
        'grid gap-2 rounded-2xl bg-brand-surface p-3',
        pending && 'pointer-events-none',
      )}
    >
      <p className="text-body font-medium">{t`The agent asks:`}</p>
      <pre className="max-h-64 overflow-auto overscroll-contain font-mono text-meta leading-snug text-brand-muted">
        {screen ?? ''}
      </pre>
      <div className="flex flex-wrap gap-2">
        {[
          ['1', '1'],
          ['2', '2'],
          ['3', '3'],
          ['Enter', t`Enter`],
          ['Escape', t`Esc`],
          ['C-c', t`Ctrl+C`],
        ].map(([key, label]) => (
          <Button
            variant="key"
            key={key}
            type="button"
            disabled={disabled || Boolean(pending)}
            onClick={() => press(key)}
            className={cn(
              'flex min-h-11 min-w-11 items-center justify-center px-3 text-body disabled:opacity-40',
              promptButtonClass(pending, key),
            )}
          >
            {label}
          </Button>
        ))}
      </div>
      <PromptActionStatus pending={pending} />
    </div>
  )
}

/** Grok plan review: a=approve, s=request changes, q=quit (TUI plan approval bar). */
export function SessionPlanReview({
  excerpt,
  awaitingApproval,
  disabled,
  onKey,
  promptKey,
  onResolve,
}: {
  excerpt?: string
  awaitingApproval?: boolean
  disabled: boolean
  onKey: (key: string) => Promise<unknown> | void
  promptKey?: string
  onResolve?: PromptResolveFn
}) {
  const { t } = useLingui()
  const { pending, run } = usePromptAction(excerpt ?? 'plan')
  const trigger = (
    action: 'approve' | 'changes' | 'quit',
    key: 'a' | 's' | 'q',
  ) => {
    if (onResolve) {
      void onResolve({
        kind: action === 'approve' ? 'prompt-submit' : 'prompt-cancel',
        promptKey: promptKey ?? excerpt ?? 'plan',
        execute: async () => (await onKey(key)) !== false,
      })
      return
    }
    void run(action, () => onKey(key), {
      kind: action === 'quit' ? 'cancel' : 'submit',
    })
  }
  // Only while the TUI is on the plan-approval bar — not while plan.md is
  // still being written under plan mode Active.
  if (!awaitingApproval) return null
  return (
    <div
      className={cn(
        'grid gap-3 rounded-2xl border border-brand-running/40 bg-brand-running/10 p-3',
        pending && 'pointer-events-none',
      )}
      data-testid="session-plan-review"
      data-write
      aria-busy={Boolean(pending)}
    >
      <p className="text-body font-medium">{t`Plan ready for review`}</p>
      {excerpt ? (
        <div className="max-h-96 overflow-y-auto rounded-xl bg-brand-deck px-3 py-2">
          <ChatMarkdown text={excerpt} />
        </div>
      ) : (
        <p className="text-caption text-brand-muted">{t`No plan written yet`}</p>
      )}
      <div className="grid gap-2">
        <Button
          variant="solid"
          type="button"
          disabled={disabled || Boolean(pending)}
          onClick={() => trigger('approve', 'a')}
          className={cn(
            'flex min-h-12 items-center justify-center px-3 text-body disabled:opacity-40',
            promptButtonClass(pending, 'approve', 'solid'),
          )}
        >
          {t`Approve plan`}
        </Button>
        <Button
          variant="key"
          type="button"
          disabled={disabled || Boolean(pending)}
          onClick={() => trigger('changes', 's')}
          className={cn(
            'flex min-h-12 items-center justify-center px-3 text-body disabled:opacity-40',
            promptButtonClass(pending, 'changes'),
          )}
        >
          {t`Request changes`}
        </Button>
        <Button
          variant="key"
          type="button"
          disabled={disabled || Boolean(pending)}
          onClick={() => trigger('quit', 'q')}
          className={cn(
            'flex min-h-11 items-center justify-center px-3 text-body text-brand-muted disabled:opacity-40',
            promptButtonClass(pending, 'quit'),
          )}
        >
          {t`Quit plan`}
        </Button>
      </div>
      <PromptActionStatus
        pending={pending}
        idle={t`Approve sends a, request changes sends s (then type notes below), quit sends q — same as the Grok TUI.`}
      />
    </div>
  )
}
