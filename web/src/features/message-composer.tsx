// Reusable rich message composer primitive shared across the session chat box,
// quick ticket composer, and future multi-attachment inputs:
//   - multi-line auto-growing Textarea
//   - clipboard image paste + file picker + host-uploaded image reuse (0 re-upload)
//   - [图片N] atomic token editing and merge renumbering
//   - per-key localStorage + IndexedDB draft persistence
import { useLingui } from '@lingui/react/macro'
import { SendHorizontal } from 'lucide-react'
import { useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Textarea } from '#/components/ui/textarea'
import { trace } from '#/lib/client-trace'
import { restoreDraft, useDraft } from '#/lib/use-draft'
import { useIsWide, useMediaQuery } from '#/lib/use-media'
import {
  isHardwareOnlyKey,
  isSoftKeyboardOpen,
  shouldEnterSend,
} from './composer-enter'
import {
  MAX_IMAGES,
  forgetPicks,
  materializeAttachments,
  restorePicks,
  revokeComposerImages,
  usePickedImages,
} from './composer-images'
import type { ComposerImage, MessagePayload } from './composer-images'
import { PickedImages } from './composer-picked'
import { mergePayloads, tokenKey } from './composer-tokens'

export type Outgoing = MessagePayload & {
  /** shown on the queued bubble, e.g. "2 images" */
  note: string
  /** local object URLs shown on the optimistic bubble while uploading */
  localPreviews?: Array<string>
  /** when deferUpload is enabled, resolves uploaded attachment names inside send() */
  materialize?: (onProgress: (label: string) => void) => Promise<Array<string>>
}

export function useRichDraft({
  storageKey,
  imageKey,
  onSend,
  deferUpload = false,
}: {
  /** localStorage key for text draft */
  storageKey: string
  /** IndexedDB key suffix for image picks */
  imageKey: string
  onSend: (message: Outgoing) => Promise<boolean>
  /** if true, call onSend immediately with materialize() so bubbles render at 0ms */
  deferUpload?: boolean
}) {
  const { t } = useLingui()
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [text, setText] = useDraft(storageKey)
  const [progress, setProgress] = useState('')
  const {
    images,
    setImages,
    pick,
    remove,
    insertToken,
    appendUploaded,
    replaceUploaded,
    toSaved,
  } = usePickedImages(imageKey, text, setText, textareaRef)

  const ready = Boolean(text.trim() || images.length)

  const focusEnd = () => {
    setTimeout(() => {
      const box = textareaRef.current
      if (!box) return
      box.focus()
      const end = box.value.length
      box.setSelectionRange(end, end)
    }, 60)
  }

  /** Append a structured payload (sent record, ticket, etc.), renumbering [图片N]. */
  const appendPayload = (payload: MessagePayload) => {
    const merged = mergePayloads(
      text,
      images.length,
      payload.text,
      payload.attachments,
      MAX_IMAGES,
    )
    setText(merged.text)
    if (merged.addedAttachments.length) appendUploaded(merged.addedAttachments)
    if (merged.droppedCount > 0) {
      toast(t`Only up to ${MAX_IMAGES} images fit in one message`)
    }
    trace('composer-payload', {
      mode: 'append',
      attachments: merged.addedAttachments.length,
      dropped: merged.droppedCount,
      renumbered: merged.renumbered,
    })
    focusEnd()
  }

  /** Replace the current draft with a structured payload (recall / edit). */
  const replacePayload = (payload: MessagePayload) => {
    setText(payload.text)
    replaceUploaded(payload.attachments)
    trace('composer-payload', {
      mode: 'replace',
      attachments: Math.min(payload.attachments.length, MAX_IMAGES),
    })
    focusEnd()
  }

  const submit = async () => {
    if (!ready || progress) return
    const typed = text
    const picked: Array<ComposerImage> = images
    const savedPicks = toSaved()
    setText('')
    setImages([])
    void forgetPicks(imageKey)
    const giveBack = () => {
      restoreDraft(storageKey, typed)
      void restorePicks(imageKey, savedPicks)
    }
    const hasLocal = picked.some((img) => img.kind === 'local')
    if (deferUpload && hasLocal) {
      const count = picked.length
      const note = count ? t`${count} images` : ''
      const localPreviews = picked.flatMap((img) =>
        img.kind === 'local' ? [img.url] : [],
      )
      const ok = await onSend({
        text: typed.trim(),
        attachments: [],
        note,
        localPreviews,
        materialize: (onProgress) =>
          materializeAttachments(picked, (step, total) => {
            onProgress(t`Uploading ${step}/${total}…`)
          }),
      })
      if (!ok) giveBack()
      revokeComposerImages(picked)
      return
    }
    let attachments: Array<string> = []
    try {
      attachments = await materializeAttachments(picked, (step, total) => {
        setProgress(t`Uploading ${step}/${total}…`)
      })
    } catch (error) {
      setProgress('')
      giveBack()
      throw error
    }
    setProgress('')
    const count = attachments.length
    const note = count ? t`${count} images` : ''
    const ok = await onSend({ text: typed.trim(), attachments, note })
    if (!ok) giveBack()
    revokeComposerImages(picked)
  }

  const clear = (via: string) => {
    const typed = text
    const picked = images
    if (!typed && !picked.length) return
    setText('')
    setImages([])
    void forgetPicks(imageKey)
    trace('composer-clear', { via, chars: typed.length, images: picked.length })
    toast(t`Input cleared`, {
      action: {
        label: t`Undo`,
        onClick: () => {
          setText((current) => current || typed)
          setImages((current) => (current.length ? current : picked))
        },
      },
    })
  }

  return {
    text,
    setText,
    images,
    pick,
    remove,
    insertToken,
    appendPayload,
    replacePayload,
    clear,
    progress,
    ready,
    submit,
    textareaRef,
  }
}

export type RichDraft = ReturnType<typeof useRichDraft>

export function MessageComposer({
  draft,
  inputId,
  label,
  placeholder,
  submitLabel,
  writable,
  blocked = false,
  leadingSlot,
  topSlot,
  inputProps,
  onChangeTrack,
  onExtraKeyDown,
  onRecallLatest,
  onSubmitForm,
  textareaRef: externalRef,
}: {
  draft: RichDraft
  inputId: string
  label: string
  placeholder: string
  submitLabel?: string
  writable: boolean
  blocked?: boolean
  leadingSlot?: ReactNode
  topSlot?: ReactNode
  inputProps?: Record<string, unknown>
  onChangeTrack?: (caret: number) => void
  onExtraKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** Triggered on ArrowUp in an empty composer (recalls the latest sent message). */
  onRecallLatest?: () => void
  /** Optional direct submit handler when not wrapped in an outer <form>. */
  onSubmitForm?: () => void
  textareaRef?: RefObject<HTMLTextAreaElement | null>
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
  const [sawHardwareKey, setSawHardwareKey] = useState(false)
  const touchOnly = coarsePrimary && !anyFinePointer && !sawHardwareKey
  const canSend = !draft.progress && draft.ready && !blocked

  const assignRef = (node: HTMLTextAreaElement | null) => {
    draft.textareaRef.current = node
    if (externalRef) externalRef.current = node
  }

  return (
    <>
      {topSlot}
      <PickedImages composer={draft} />
      {draft.progress ? (
        <p role="status" className="px-1 text-meta text-brand-muted">
          {draft.progress}
        </p>
      ) : null}
      <div
        data-text-field
        // Dedicated static GPU layer (`transform-gpu`): isolates the textarea's
        // 530 ms blinking caret and focus-ring repaints from the <form> and
        // SessionStatusBar below so Chromium/Skia Graphite dirty-rect tracking
        // never strobes the status bar on focus.
        className="relative flex min-h-12 transform-gpu items-center rounded-3xl bg-brand-surface p-1"
      >
        {leadingSlot}
        <label htmlFor={inputId} className="sr-only">
          {label}
        </label>
        <Textarea
          ref={assignRef}
          variant="bare"
          id={inputId}
          {...inputProps}
          value={draft.text}
          onFocus={(event) => {
            if (wide && !isSoftKeyboardOpen()) return
            const form = event.currentTarget.form
            setTimeout(() => form?.scrollIntoView({ block: 'end' }), 300)
          }}
          onChange={(event) => {
            draft.setText(event.target.value)
            onChangeTrack?.(event.target.selectionStart)
          }}
          onKeyDown={(event) => {
            if (!sawHardwareKey && isHardwareOnlyKey(event))
              setSawHardwareKey(true)
            if (onExtraKeyDown?.(event)) return
            if (tokenKey(event, draft.setText)) return
            if (
              event.key === 'ArrowUp' &&
              !event.shiftKey &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.nativeEvent.isComposing &&
              !draft.text &&
              draft.images.length === 0 &&
              onRecallLatest
            ) {
              event.preventDefault()
              onRecallLatest()
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              event.currentTarget.blur()
              return
            }
            if (
              !shouldEnterSend({
                coarsePrimary,
                anyFinePointer,
                wide,
                sawHardwareKey: sawHardwareKey || isHardwareOnlyKey(event),
                softKeyboardOpen: isSoftKeyboardOpen(),
                key: event.key,
                code: event.code,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                isComposing: event.nativeEvent.isComposing,
                keyCode: event.keyCode,
              })
            )
              return
            event.preventDefault()
            if (!canSend) return
            if (onSubmitForm) onSubmitForm()
            else event.currentTarget.form?.requestSubmit()
          }}
          onPaste={(event) => {
            if (!writable) return
            const files = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith('image/'),
            )
            if (files.length === 0) return
            if (event.clipboardData.types.includes('text/plain'))
              setTimeout(() => draft.pick(files))
            else {
              event.preventDefault()
              draft.pick(files)
            }
          }}
          enterKeyHint={touchOnly ? 'enter' : 'send'}
          rows={1}
          placeholder={placeholder}
          className={
            leadingSlot
              ? 'w-full max-h-40 min-h-10 min-w-0 resize-none bg-transparent py-2 pl-11 pr-14 text-body outline-none [field-sizing:content] placeholder:text-brand-label'
              : 'w-full max-h-40 min-h-10 min-w-0 resize-none bg-transparent py-2 pl-3 pr-14 text-body outline-none [field-sizing:content] placeholder:text-brand-label'
          }
        />
        <Button
          variant="solid"
          size="round"
          type={onSubmitForm ? 'button' : 'submit'}
          onClick={onSubmitForm ? () => onSubmitForm() : undefined}
          aria-label={submitLabel ?? t`Send`}
          aria-keyshortcuts="Control+Enter Meta+Enter"
          title={`${submitLabel ?? t`Send`} · Ctrl/⌘+Enter`}
          disabled={!canSend}
          className="absolute right-1.5 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full disabled:opacity-30"
        >
          <SendHorizontal
            size={20}
            strokeWidth={2.25}
            aria-hidden
            className="shrink-0"
          />
        </Button>
      </div>
    </>
  )
}
