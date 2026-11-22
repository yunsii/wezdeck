// Images read back from the host for the conversation: phone attachments
// (`upload.get`, remote_upload_get.go) and images embedded base64 in a Claude
// transcript (`session.image`, remote_image.go). Both answer a thumbnail in
// one frame and the original in 48 KB chunks; both are cached for the page's
// lifetime — neither changes under its name / ref.
import { useQuery } from '@tanstack/react-query'

import { remoteLink } from '#/lib/remote-link'

export type ImageSource =
  | { kind: 'upload'; name: string }
  | { kind: 'session'; id: string; ref: string }

type Thumb = { mime: string; data: string; width: number; height: number }
type Chunk = { mime: string; size: number; offset: number; data: string }

const decode = (data: string) =>
  Uint8Array.from(atob(data), (c) => c.charCodeAt(0))

const sourceKey = (src: ImageSource) =>
  src.kind === 'upload' ? `u:${src.name}` : `s:${src.id}:${src.ref}`

const call = (src: ImageSource, extra: Record<string, unknown>) =>
  src.kind === 'upload'
    ? remoteLink.rpc('upload.get', { name: src.name, ...extra })
    : remoteLink.rpc('session.image', { id: src.id, ref: src.ref, ...extra })

/** The host said the file is gone (uploads are kept 30 days); not worth retrying. */
export const isGone = (error: unknown) =>
  /no longer on the host|not found/i.test(
    String((error as Error | null)?.message),
  )

export function useImageThumb(src: ImageSource) {
  return useQuery({
    queryKey: ['remote', 'image-thumb', sourceKey(src)],
    enabled: typeof window !== 'undefined',
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    // a page that just opened may ask before the link is up: keep trying
    retry: (count, error) => !isGone(error) && count < 6,
    retryDelay: (count) => Math.min(8_000, 600 * 2 ** count),
    queryFn: async () => {
      const t = (await call(src, { thumb: true })) as Thumb
      return {
        url: `data:${t.mime};base64,${t.data}`,
        width: t.width,
        height: t.height,
      }
    },
  })
}

export const thumbQueryKey = (src: ImageSource) => [
  'remote',
  'image-thumb',
  sourceKey(src),
]

const originals = new Map<string, Promise<string>>()

/** Object URL of the original image (fetched once per page). */
export function loadImageOriginal(src: ImageSource): Promise<string> {
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
      return URL.createObjectURL(
        new Blob(parts as Array<BlobPart>, { type: mime }),
      )
    })()
    pending.catch(() => originals.delete(key))
    originals.set(key, pending)
  }
  return pending
}
