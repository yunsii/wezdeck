// Phone attachments read back from the host (`upload.get`, remote_upload_get.go):
// a thumbnail in one frame, the original in 48 KB chunks. Both are cached for
// the page's lifetime — an uploaded file never changes under its name.
import { useQuery } from '@tanstack/react-query'

import { remoteLink } from '#/lib/remote-link'

type Thumb = { mime: string; data: string; width: number; height: number }
type Chunk = { mime: string; size: number; offset: number; data: string }

const decode = (data: string) =>
  Uint8Array.from(atob(data), (c) => c.charCodeAt(0))

export function useUploadThumb(name: string) {
  return useQuery({
    queryKey: ['remote', 'upload-thumb', name],
    enabled: typeof window !== 'undefined',
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: 1,
    queryFn: async () => {
      const t = (await remoteLink.rpc('upload.get', {
        name,
        thumb: true,
      })) as Thumb
      return {
        url: `data:${t.mime};base64,${t.data}`,
        width: t.width,
        height: t.height,
      }
    },
  })
}

const originals = new Map<string, Promise<string>>()

/** Object URL of the original image (fetched once per page). */
export function loadUploadOriginal(name: string): Promise<string> {
  let pending = originals.get(name)
  if (!pending) {
    pending = (async () => {
      const parts: Array<Uint8Array> = []
      let offset = 0
      let mime = 'image/jpeg'
      for (;;) {
        const c = (await remoteLink.rpc('upload.get', {
          name,
          offset,
        })) as Chunk
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
    pending.catch(() => originals.delete(name))
    originals.set(name, pending)
  }
  return pending
}
