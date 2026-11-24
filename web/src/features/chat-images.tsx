// Thumbnails in the conversation, tap for the full-screen viewer: phone
// attachments of a sent message, images pasted at the desk, and images a tool
// returned (screenshots, Read of a .png). Thumbnails come from the host
// (lib/upload-image.ts); a slow first load retries by itself, "expired" is
// shown only when the host says the file is gone, and a failed one can be
// tapped to try again.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useState } from 'react'

import {
  isGone,
  loadImageOriginal,
  thumbQueryKey,
  useImageThumb,
} from '#/lib/upload-image'
import type { ImageSource } from '#/lib/upload-image'
import { ImageViewer } from './image-viewer'
import { Button } from '#/components/ui/button'

/** the session whose transcript refs (`session.image`) resolve */
export const SessionIdContext = createContext('')

export const sessionImages = (id: string, refs: Array<string>) =>
  refs.map((ref): ImageSource => ({ kind: 'session', id, ref }))

const keyOf = (src: ImageSource) =>
  src.kind === 'upload' ? src.name : `${src.id}:${src.ref}`

function ImageThumb({
  src,
  label,
  onOpen,
}: {
  src: ImageSource
  /** 图片N for a phone attachment, matching [图片N] in the text */
  label?: string
  onOpen: () => void
}) {
  const { t } = useLingui()
  const thumb = useImageThumb(src)
  const gone = thumb.isError && isGone(thumb.error)
  return (
    <Button
      variant="plain"
      type="button"
      onClick={() => {
        if (thumb.isError && !gone) void thumb.refetch()
        onOpen()
      }}
      aria-label={label ?? t`Open image`}
      className="relative size-16 overflow-hidden rounded-xl bg-brand-deck/15"
    >
      {thumb.data ? (
        <img src={thumb.data.url} alt="" className="size-full object-cover" />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-meta opacity-70">
          {gone ? t`Expired` : thumb.isError ? t`Retry` : t`Image`}
        </span>
      )}
      {label ? <ThumbLabel label={label} /> : null}
    </Button>
  )
}

/** 图片N in the thumbnail's corner */
export function ThumbLabel({ label }: { label: string }) {
  return (
    <span className="absolute bottom-1 left-1 rounded-md bg-black/60 px-1 text-meta leading-4 font-medium text-white">
      {label}
    </span>
  )
}

export function ImageStrip({
  sources,
  labels,
  open: openProp,
  onOpenChange,
}: {
  sources: Array<ImageSource>
  labels?: Array<string>
  /** the open image, when the caller opens it too (a [图片N] chip) */
  open?: number | null
  onOpenChange?: (index: number | null) => void
}) {
  const [openState, setOpenState] = useState<number | null>(null)
  const open = openProp !== undefined ? openProp : openState
  const setOpen = onOpenChange ?? setOpenState
  const client = useQueryClient()
  if (sources.length === 0) return null
  return (
    <span className="mt-1.5 flex flex-wrap gap-1.5">
      {sources.map((src, i) => (
        <ImageThumb
          key={keyOf(src)}
          src={src}
          label={labels?.[i]}
          onOpen={() => setOpen(i)}
        />
      ))}
      {open !== null ? (
        <ImageViewer
          images={sources.map((src) => ({
            key: keyOf(src),
            load: () => loadImageOriginal(src),
            placeholder: client.getQueryData<{ url: string }>(
              thumbQueryKey(src),
            )?.url,
          }))}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </span>
  )
}

/** images embedded in the transcript for this message (refs from the host) */
export function TranscriptImages({ refs }: { refs?: Array<string> }) {
  const id = useContext(SessionIdContext)
  if (!id || !refs?.length) return null
  return <ImageStrip sources={sessionImages(id, refs)} />
}
