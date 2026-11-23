// Full-screen image preview shared by the composer (local picks) and the
// conversation (phone attachments read back from the host). Fits the screen;
// a tap toggles actual size, which scrolls to pan. Esc / × / the backdrop
// close it, and so does the phone's back gesture (it owns a history entry
// while open); ← / → (or the side buttons) step through a message's images.
// Portalled to <body> so a blurred header can't become its containing block.
import { useLingui } from '@lingui/react/macro'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '#/lib/utils'
import { Button } from '#/components/ui/button'

export type ViewerImage = {
  key: string
  /** ready URL (object / data URL), or */
  src?: string
  /** a loader for the full image (resolves to a URL) */
  load?: () => Promise<string>
  /** shown while the full image loads */
  placeholder?: string
}

export function ImageViewer({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: Array<ViewerImage>
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const { t } = useLingui()
  const [actual, setActual] = useState(false)
  const [loaded, setLoaded] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const image = images[index] as ViewerImage | undefined
  const src = image ? (image.src ?? loaded[image.key]) : undefined

  const key = image?.key
  const loaderKey = useRef(key)
  const have = Boolean(image?.src || (key && loaded[key]))
  // load is recreated per render for the same target: hold the first one
  const loader = useRef(image?.load)
  if (key !== loaderKey.current) {
    loaderKey.current = key
    loader.current = image?.load
  }
  const load = loader.current
  // keyed on the image, not the array: the thread re-renders on every poll
  useEffect(() => {
    setActual(false)
    setError('')
  }, [key])
  useEffect(() => {
    if (!key || have || !load) return
    let live = true
    load().then(
      (url) => live && setLoaded((m) => ({ ...m, [key]: url })),
      (e: unknown) => live && setError((e as Error).message),
    )
    return () => {
      live = false
    }
  }, [key, have, load])

  // back closes the preview, not the page: open = one history entry (same
  // URL); back pops it and closes; closing any other way pops it too
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    window.history.pushState(
      { ...(window.history.state as object | null), imageViewer: true },
      '',
    )
    let popped = false
    const onPop = () => {
      popped = true
      closeRef.current()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      const state = window.history.state as { imageViewer?: boolean } | null
      if (!popped && state?.imageViewer) window.history.back()
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
      else if (event.key === 'ArrowRight' && index < images.length - 1)
        onIndex(index + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, images.length, onClose, onIndex])

  if (!image || typeof document === 'undefined') return null
  const shown = src ?? image.placeholder
  const step = (delta: number) => (event: React.MouseEvent) => {
    event.stopPropagation()
    onIndex(index + delta)
  }
  return createPortal(
    <div
      role="dialog"
      aria-label={t`Image preview`}
      data-testid="image-viewer"
      className="fixed inset-0 z-[60] bg-black"
      onClick={onClose}
    >
      <div
        className={cn(
          'absolute inset-0 overflow-auto overscroll-contain',
          !actual && 'flex items-center justify-center',
        )}
      >
        {shown ? (
          <img
            src={shown}
            alt=""
            onClick={(event) => {
              event.stopPropagation()
              setActual((v) => !v)
            }}
            className={cn(
              'select-none',
              actual
                ? 'max-w-none cursor-zoom-out'
                : 'max-h-full max-w-full cursor-zoom-in object-contain',
              !src && 'blur-sm',
            )}
          />
        ) : null}
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-[max(env(safe-area-inset-top),0.75rem)] px-3 text-white">
        <span className="text-[13px] opacity-80">
          {images.length > 1 ? `${index + 1} / ${images.length}` : ''}
          {!src && !error ? ` ${t`Loading original…`}` : ''}
          {error ? ` ${error}` : ''}
        </span>
        <Button
          variant="plain"
          type="button"
          aria-label={t`Close`}
          onClick={onClose}
          className="pointer-events-auto inline-flex size-10 items-center justify-center rounded-full bg-white/15"
        >
          <X size={20} aria-hidden />
        </Button>
      </div>
      {index > 0 ? (
        <Button
          variant="plain"
          type="button"
          aria-label={t`Previous image`}
          onClick={step(-1)}
          className="absolute top-1/2 left-2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white"
        >
          <ChevronLeft size={22} aria-hidden />
        </Button>
      ) : null}
      {index < images.length - 1 ? (
        <Button
          variant="plain"
          type="button"
          aria-label={t`Next image`}
          onClick={step(1)}
          className="absolute top-1/2 right-2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white"
        >
          <ChevronRight size={22} aria-hidden />
        </Button>
      ) : null}
    </div>,
    document.body,
  )
}
