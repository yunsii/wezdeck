// Shared immediate loading → waiting feedback for every parsed special
// interaction card (permission approval, Ask questions, plan review, and the
// generic key strip). Clicking an action locks the card against double-taps,
// highlights the chosen button (keeping its label readable and its dimensions
// unchanged), and shows a single spinner in PromptActionStatus below until the
// host poll dismisses or replaces the prompt — or unlocks on write failure.
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

/**
 * Shared pending button styling across all prompt cards: keeps the chosen
 * action readable and highlighted, softly dims sibling actions during submit /
 * cancel waits, and avoids flashing siblings on quick multi-select toggles.
 * No in-button spinner is inserted, so the card shows one single spinner in
 * PromptActionStatus below and button geometry never shifts.
 */
export function promptButtonClass(
  pending: PromptPending | null,
  action: string,
  variant: 'key' | 'solid' = 'key',
) {
  if (!pending) return ''
  if (pending.action === action) {
    return variant === 'solid'
      ? 'disabled:opacity-100 ring-2 ring-brand-running/60'
      : 'disabled:opacity-100 border-brand-running bg-brand-running/10'
  }
  return pending.kind === 'toggle'
    ? 'disabled:opacity-100'
    : 'disabled:opacity-55'
}

/**
 * Zero-shift status slot shared by every interactive prompt card. Stacks the
 * idle hint, an invisible waiting-text sizer, and the active pending status
 * inside the same CSS Grid cell so toggling idle → sending → waiting → idle
 * keeps the card height strictly constant across all viewport widths.
 */
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
  const resolvedWaiting =
    waitingText ?? t`Action sent; waiting for the agent to continue…`
  const activeText = pending
    ? pending.phase === 'waiting'
      ? resolvedWaiting
      : pending.kind === 'toggle'
        ? t`Updating your selection…`
        : pending.kind === 'cancel'
          ? t`Cancelling…`
          : (sendingText ?? t`Sending action…`)
    : ''
  return (
    <div
      className={cn(
        'grid min-h-5 items-start text-meta leading-relaxed',
        className,
      )}
    >
      {/* Invisible sizer keeps the slot tall enough for the longest status line */}
      <p
        aria-hidden
        className="pointer-events-none col-start-1 row-start-1 flex items-center gap-2 opacity-0 select-none"
      >
        <PromptActionSpinner className="animate-none" />
        <span>{resolvedWaiting}</span>
      </p>
      {idle ? (
        <p
          aria-hidden={Boolean(pending)}
          className={cn(
            'col-start-1 row-start-1 text-brand-label transition-opacity duration-150',
            pending && 'pointer-events-none opacity-0 select-none',
          )}
        >
          {idle}
        </p>
      ) : null}
      {pending ? (
        <p
          role="status"
          aria-live="polite"
          data-testid={loadingTestId}
          data-prompt-loading={pending.phase}
          className="col-start-1 row-start-1 flex items-center gap-2 text-brand-running"
        >
          <PromptActionSpinner />
          <span>{activeText}</span>
        </p>
      ) : null}
    </div>
  )
}
