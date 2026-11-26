// Shared immediate loading → waiting feedback for every parsed special
// interaction card (permission approval, Ask questions, plan review, and the
// generic key strip). Clicking an action locks the card against double-taps,
// shows a spinner while the key write is in flight ("sending"), then holds a
// clear "waiting for the agent to continue…" status until the host poll
// dismisses or replaces the prompt — or unlocks immediately on write failure.
import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'

import { trace } from '#/lib/client-trace'
import { cn } from '#/lib/utils'

export type PromptActionKind = 'submit' | 'toggle' | 'cancel'

export type PromptPending = {
  key: string
  action: string
  phase: 'sending' | 'waiting'
  kind: PromptActionKind
}

export function usePromptAction(promptKey: string) {
  const [pendingBy, setPendingBy] = useState<PromptPending | null>(null)
  const pending = pendingBy?.key === promptKey ? pendingBy : null

  const run = async (
    action: string,
    job: () => Promise<unknown> | void,
    options?: { kind?: PromptActionKind; stayWaiting?: boolean },
  ): Promise<boolean> => {
    if (pending) return false
    const kind = options?.kind ?? 'submit'
    const stayWaiting = options?.stayWaiting ?? true
    setPendingBy({ key: promptKey, action, phase: 'sending', kind })
    try {
      const result = await job()
      if (result === false) {
        trace('prompt-action', { action, kind, outcome: 'failed' })
        setPendingBy(null)
        return false
      }
      trace('prompt-action', {
        action,
        kind,
        outcome: stayWaiting ? 'waiting' : 'settled',
      })
      if (stayWaiting) {
        setPendingBy({ key: promptKey, action, phase: 'waiting', kind })
      } else {
        setPendingBy(null)
      }
      return true
    } catch {
      trace('prompt-action', { action, kind, outcome: 'error' })
      setPendingBy(null)
      return false
    }
  }

  const clear = () => setPendingBy(null)

  return { pending, run, clear }
}

export function PromptActionSpinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-brand-border border-t-brand-running',
        className,
      )}
    />
  )
}

export function PromptActionStatus({
  pending,
  idle,
  sendingText,
  waitingText,
  loadingTestId = 'prompt-action-loading',
  className,
}: {
  pending: PromptPending | null
  idle?: string
  sendingText?: string
  waitingText?: string
  loadingTestId?: string
  className?: string
}) {
  const { t } = useLingui()
  if (!pending && !idle) return null
  const activeText = pending
    ? pending.phase === 'waiting'
      ? (waitingText ?? t`Action sent; waiting for the agent to continue…`)
      : pending.kind === 'toggle'
        ? t`Updating your selection…`
        : pending.kind === 'cancel'
          ? t`Cancelling…`
          : (sendingText ?? t`Sending action…`)
    : ''
  return (
    <p
      role={pending ? 'status' : undefined}
      aria-live={pending ? 'polite' : undefined}
      data-testid={pending ? loadingTestId : undefined}
      data-prompt-loading={pending ? pending.phase : undefined}
      className={cn(
        'flex min-h-5 items-center gap-2 text-meta leading-relaxed',
        pending ? 'text-brand-running' : 'text-brand-label',
        className,
      )}
    >
      {pending ? (
        <>
          <PromptActionSpinner />
          <span>{activeText}</span>
        </>
      ) : (
        idle
      )}
    </p>
  )
}
