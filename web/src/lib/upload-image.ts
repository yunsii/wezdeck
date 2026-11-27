// Images read back from the host for the conversation: phone attachments
// (`upload.get`, remote_upload_get.go) and images embedded base64 in a Claude
// transcript (`session.image`, remote_image.go). The host only sends the
// original, in 48 KB chunks; the page makes the thumbnail itself
// (createImageBitmap + canvas: the browser decodes webp and refuses what it
// cannot afford, the host no longer decodes anything). The original is kept
// for the page's lifetime (the viewer reuses it); the thumbnail, a small
// JPEG data URL, rides the persisted query cache — neither changes under its
// name / ref.
import { useQuery } from '@tanstack/react-query'

import { hostRead } from '#/lib/runtime-client'

export type ImageSource =
  | { kind: 'upload'; name: string; ticket?: string }
  | { kind: 'session'; id: string; ref: string }

type Chunk = { mime: string; size: number; offset: number; data: string }

const decode = (data: string) =>
  Uint8Array.from(atob(data), (c) => c.charCodeAt(0))

const sourceKey = (src: ImageSource) =>
  src.kind === 'upload'
    ? src.ticket
      ? `u:${src.ticket}:${src.name}`
      : `u:${src.name}`
    : `s:${src.id}:${src.ref}`

const call = (src: ImageSource, extra: Record<string, unknown>) =>
  src.kind === 'upload'
    ? hostRead('upload.get', {
        name: src.name,
        ...(src.ticket ? { ticket: src.ticket } : {}),
        ...extra,
      })
    : hostRead('session.image', { id: src.id, ref: src.ref, ...extra })

/** The host said the file is gone (uploads are kept 30 days); not worth retrying. */
export const isGone = (error: unknown) =>
  /no longer on the host|not found/i.test(
    String((error as Error | null)?.message),
  )

/** long edge of a thumbnail, in image pixels (sharp at 2× for a ~360 px box) */
const THUMB_EDGE = 720

/** a JPEG data URL of the image scaled to THUMB_EDGE on its long edge */
export async function makeThumb(blob: Blob) {
  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(
      1,
      THUMB_EDGE / Math.max(bitmap.width, bitmap.height, 1),
    )
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('cannot draw the image')
    // a transparent PNG would turn black in a JPEG
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return {
      url: canvas.toDataURL('image/jpeg', 0.82),
      width: bitmap.width,
      height: bitmap.height,
    }
  } finally {
    bitmap.close()
  }
}

export function useImageThumb(src: ImageSource) {
  return useQuery({
    queryKey: ['remote', 'image-thumb', sourceKey(src)],
    enabled: typeof window !== 'undefined',
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    // a page that just opened may ask before the link is up: keep trying
    retry: (count, error) => !isGone(error) && count < 6,
    retryDelay: (count) => Math.min(8_000, 600 * 2 ** count),
    queryFn: async () => makeThumb(await loadImageBlob(src)),
  })
}

export const thumbQueryKey = (src: ImageSource) => [
  'remote',
  'image-thumb',
  sourceKey(src),
]

const originals = new Map<string, Promise<Blob>>()

/** The original image, fetched once per page in 48 KB chunks. */
export function loadImageBlob(src: ImageSource): Promise<Blob> {
  const key = sourceKey(src)
  let pending = originals.get(key)
  if (!pending) {
    pending = (async () => {
      const parts: Array<Uint8Array> = []
      let offset = 0
      let mime = 'image/jpeg'
      for (;;) {
        const c = (await call(src, { offset })) as Chunk
        mime = c.mime
        const part = decode(c.data)
        parts.push(part)
        offset += part.length
        if (part.length === 0 || offset >= c.size) break
      }
      return new Blob(parts as Array<BlobPart>, { type: mime })
    })()
    pending.catch(() => originals.delete(key))
    originals.set(key, pending)
  }
  return pending
}

const originalUrls = new Map<string, Promise<string>>()

/** Object URL of the original image (fetched once per page). */
export function loadImageOriginal(src: ImageSource): Promise<string> {
  const key = sourceKey(src)
  let url = originalUrls.get(key)
  if (!url) {
    url = loadImageBlob(src).then((blob) => URL.createObjectURL(blob))
    url.catch(() => originalUrls.delete(key))
    originalUrls.set(key, url)
  }
  return url
}
