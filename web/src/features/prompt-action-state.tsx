// Shared immediate loading → waiting feedback for every parsed special
// interaction card (permission approval, Ask questions, plan review, and the
// generic key strip). Clicking an action locks the card against double-taps,
// shows a spinner while the key write is in flight ("sending"), then holds a
// clear "waiting for the agent to continue…" status until the host poll
// dismisses or replaces the prompt — or unlocks immediately on write failure.
import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import type { ReactNode } from 'react'

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
 * Overlay spinner inside a button without altering its intrinsic width or
 * height: the label stays in flow (opacity-0 while loading, keeping both
 * layout dimensions and accessible name intact), preventing flex-wrap buttons
 * from shifting neighbors or wrapping onto a new row.
 */
export function PromptActionLabel({
  loading,
  tone = 'default',
  spinnerClassName,
  children,
}: {
  loading: boolean
  /** `solid` matches Button variant="solid" (inverted bg-brand-text / text-brand-deck in both themes). */
  tone?: 'default' | 'solid'
  spinnerClassName?: string
  children: ReactNode
}) {
  return (
    <span className="inline-grid place-items-center">
      <span
        className={cn(
          'col-start-1 row-start-1 inline-flex items-center justify-center',
          loading && 'opacity-0 select-none',
        )}
      >
        {children}
      </span>
      {loading ? (
        <PromptActionSpinner
          className={cn(
            'col-start-1 row-start-1',
            tone === 'solid' && 'border-brand-deck/30 border-t-brand-deck',
            spinnerClassName,
          )}
        />
      ) : null}
    </span>
  )
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
