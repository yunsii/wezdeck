// Phone → host files (remote_upload.go): images are shrunk on the phone
// (long edge ≤ 1600 px, JPEG) and every file goes up as signed chunks small
// enough for one DataChannel message; the host answers the last chunk with
// the stored file's name, which a later `send` attaches to the message.
import { remoteLink } from '#/lib/remote-link'

const CHUNK = 36 * 1024
const LONG_EDGE = 1600

function toBase64(bytes: Uint8Array) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** A phone screenshot is megabytes of PNG; the agent reads a 1600 px JPEG fine. */
export async function shrinkImage(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('this image format cannot be read in the browser')
  }
  const scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error('could not encode the image')),
      'image/jpeg',
      0.82,
    )
  })
}

/** Upload one file; resolves to the name the host stored it under. */
export async function uploadBlob(
  blob: Blob,
  mime: string,
  onChunk?: (done: number, total: number) => void,
) {
  const id = crypto.randomUUID()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK))
  let name = ''
  for (let seq = 0; seq < total; seq++) {
    const result = (await remoteLink.write('upload', {
      upload: id,
      seq,
      total,
      mime,
      data: toBase64(bytes.subarray(seq * CHUNK, (seq + 1) * CHUNK)),
    })) as { name?: string }
    if (result.name) name = result.name
    onChunk?.(seq + 1, total)
  }
  if (!name) throw new Error('the upload did not finish on the host')
  return name
}
