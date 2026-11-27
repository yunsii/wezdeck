// Picked images, a row of their own above the composer toolbar. Supports both
// local File picks (object URL) and reused host-uploaded attachments (fetched
// through useImageThumb / loadImageOriginal with zero re-upload).
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import {
  isGone,
  loadImageOriginal,
  thumbQueryKey,
  useImageThumb,
} from '#/lib/upload-image'
import type { ComposerImage } from './composer-images'
import { ImageViewer } from './image-viewer'

function UploadedPreview({ name }: { name: string }) {
  const { t } = useLingui()
  const thumb = useImageThumb({ kind: 'upload', name })
  const gone = thumb.isError && isGone(thumb.error)
  if (thumb.data) {
    return (
      <img
        src={thumb.data.url}
        alt=""
        className="size-16 rounded-xl object-cover"
      />
    )
  }
  return (
    <span className="flex size-16 items-center justify-center rounded-xl bg-brand-soft text-meta text-brand-muted">
      {gone ? t`Expired` : thumb.isError ? t`Retry` : t`Image`}
    </span>
  )
}

export function PickedImages({
  composer,
}: {
  composer: {
    images: Array<ComposerImage>
    remove: (key: string) => void
    insertToken: (n: number) => void
  }
}) {
  const { t } = useLingui()
  const client = useQueryClient()
  const [preview, setPreview] = useState<number | null>(null)
  if (composer.images.length === 0) return null
  return (
    <div
      data-testid="composer-images"
      className="flex gap-2 overflow-x-auto px-0.5 py-1 [scrollbar-width:none]"
    >
      {composer.images.map((image, i) => {
        const label = `图片${i + 1}`
        return (
          <span key={image.key} className="relative size-16 shrink-0">
            <Button
              variant="plain"
              type="button"
              aria-label={t`Preview ${label}`}
              onClick={() => setPreview(i)}
              className="block size-16"
            >
              {image.kind === 'local' ? (
                <img
                  src={image.url}
                  alt=""
                  className="size-16 rounded-xl object-cover"
                />
              ) : (
                <UploadedPreview name={image.name} />
              )}
            </Button>
            <Button
              variant="plain"
              size="none"
              type="button"
              title={t`Put [${label}] at the caret`}
              onClick={() => composer.insertToken(i + 1)}
              className="absolute bottom-1 left-1 rounded-md bg-black/60 px-1 text-meta leading-4 font-medium text-white"
            >
              {label}
            </Button>
            <Button
              variant="plain"
              size="none"
              type="button"
              aria-label={t`Remove image`}
              onClick={() => composer.remove(image.key)}
              className="absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded-full bg-black/60 text-white"
            >
              <X size={14} strokeWidth={2.5} aria-hidden className="shrink-0" />
            </Button>
          </span>
        )
      })}
      {preview !== null ? (
        <ImageViewer
          images={composer.images.map((image) =>
            image.kind === 'local'
              ? { key: image.key, src: image.url }
              : {
                  key: image.key,
                  load: () =>
                    loadImageOriginal({ kind: 'upload', name: image.name }),
                  placeholder: client.getQueryData<{ url: string }>(
                    thumbQueryKey({ kind: 'upload', name: image.name }),
                  )?.url,
                },
          )}
          index={Math.min(preview, composer.images.length - 1)}
          onIndex={setPreview}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  )
}
