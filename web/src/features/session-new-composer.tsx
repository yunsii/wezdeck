import { useLingui } from '@lingui/react/macro'
import { SendHorizontal } from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Textarea } from '#/components/ui/textarea'
import { trace } from '#/lib/client-trace'
import { useEnterMode } from '#/lib/enter-pref'
import { useIsWide, useMediaQuery } from '#/lib/use-media'
import {
  isHardwareOnlyKey,
  isSoftKeyboardOpen,
  shouldEnterSend,
} from './composer-enter'

export function NewSessionComposer({
  prompt,
  onPrompt,
  sending,
  ready,
  onSubmit,
}: {
  prompt: string
  onPrompt: (next: string) => void
  sending: boolean
  ready: boolean
  onSubmit: () => void
}) {
  const { t } = useLingui()
  const coarsePrimary = useMediaQuery(
    '(hover: none) and (pointer: coarse)',
    false,
  )
  const anyFinePointer = useMediaQuery(
    '(any-pointer: fine), (any-hover: hover)',
    true,
  )
  const wide = useIsWide()
  const [enterMode] = useEnterMode()
  const [sawHardwareKey, setSawHardwareKey] = useState(false)
  // A coarse-pointer device can have a soft keyboard even when it is wide.
  const advertisePlainEnter =
    enterMode === 'send' || (enterMode === 'auto' && !coarsePrimary)

  return (
    <form
      data-testid="new-session-composer"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)]"
    >
      <div
        data-text-field
        className="grid min-w-0 rounded-2xl bg-brand-surface"
      >
        <Textarea
          variant="bare"
          value={prompt}
          disabled={sending}
          rows={4}
          autoFocus
          enterKeyHint={advertisePlainEnter ? 'send' : 'enter'}
          aria-label={t`What do you want to solve?`}
          onChange={(event) => onPrompt(event.target.value)}
          onKeyDown={(event) => {
            const hardwareKey = sawHardwareKey || isHardwareOnlyKey(event)
            if (!sawHardwareKey && hardwareKey) setSawHardwareKey(true)
            if (event.key !== 'Enter') return
            const softKeyboardOpen = isSoftKeyboardOpen()
            const sendOnEnter = shouldEnterSend({
              mode: enterMode,
              coarsePrimary,
              anyFinePointer,
              wide,
              sawHardwareKey: hardwareKey,
              softKeyboardOpen,
              key: event.key,
              code: event.code,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.keyCode,
            })
            trace('composer-enter', {
              source: 'session-new',
              send: sendOnEnter,
              mode: enterMode,
              coarse: coarsePrimary,
              anyFine: anyFinePointer,
              wide,
              softKb: softKeyboardOpen,
              hwKey: hardwareKey,
              code: event.code,
              shift: event.shiftKey,
              ctrl: event.ctrlKey || event.metaKey,
              composing: event.nativeEvent.isComposing,
            })
            if (!sendOnEnter) return
            event.preventDefault()
            if (ready && !sending) onSubmit()
          }}
          placeholder={t`What should it work on?`}
          className="min-h-28 max-h-60 w-full resize-none bg-transparent px-3.5 pt-3 pb-2 text-body text-brand-text outline-none [field-sizing:content] placeholder:text-brand-label disabled:opacity-60"
        />
        <div className="flex items-center justify-between gap-3 px-3 pt-1 pb-2.5">
          <span className="hidden text-meta text-brand-label md:inline">
            {advertisePlainEnter
              ? t`Enter to send · Shift+Enter for newline`
              : t`Ctrl/⌘+Enter to send`}
          </span>
          <Button
            variant="solid"
            type="submit"
            disabled={!ready || sending}
            className="ml-auto inline-flex min-h-10 items-center justify-center gap-1.5 px-4 text-body whitespace-nowrap disabled:opacity-40 md:min-h-9"
          >
            <SendHorizontal size={16} aria-hidden />
            {t`Create session`}
          </Button>
        </div>
      </div>
    </form>
  )
}
