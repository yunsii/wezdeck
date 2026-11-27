// The composer's picked images (file picker, pasted screenshots, or reused
// host-uploaded attachments): previews as object URLs (local) or cached host
// thumbnails (uploaded); each leaves [图片N] at the caret, removing drops its
// token and renumbers the rest (composer-tokens.ts).
// Kept with the draft: the text is in localStorage (useDraft), the images in
// IndexedDB per draft key, so a reload brings back both.
import { createStore, del, get, set } from 'idb-keyval'
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { shrinkImage, uploadBlob } from '#/lib/upload'
import { dropToken, imageToken, insertTokens } from './composer-tokens'

export const MAX_IMAGES = 5

export type ComposerImage =
  | { kind: 'local'; key: string; file: File; url: string }
  | { kind: 'uploaded'; key: string; name: string }

/** Backwards-friendly alias for composer image entries. */
export type Picked = ComposerImage

export type MessagePayload = {
  text: string
  attachments: Array<string>
}

type SetText = (next: string | ((current: string) => string)) => void

// own database, like the device key (idb-keyval makes a store only with
// its database)
const store = () => createStore('wezdeck-draft-images', 'images')
const draftKey = (id: string) => `draft:${id}`

type LegacySavedItem = { key: string; file: File }
export type SavedImage =
  | { kind: 'local'; key: string; file: File }
  | { kind: 'uploaded'; key: string; name: string }
export type Saved = Array<SavedImage | LegacySavedItem>

const EVENT = 'wezdeck:draft-picks'

function toSaved(images: Array<ComposerImage>): Array<SavedImage> {
  return images.map((image) =>
    image.kind === 'local'
      ? { kind: 'local', key: image.key, file: image.file }
      : { kind: 'uploaded', key: image.key, name: image.name },
  )
}

function hydrateSaved(saved: Saved): Array<ComposerImage> {
  return saved.map((item) => {
    if ('kind' in item) {
      if (item.kind === 'uploaded') {
        return { kind: 'uploaded', key: item.key, name: item.name }
      }
      return {
        kind: 'local',
        key: item.key,
        file: item.file,
        url: URL.createObjectURL(item.file),
      }
    }
    return {
      kind: 'local',
      key: item.key,
      file: item.file,
      url: URL.createObjectURL(item.file),
    }
  })
}

export function revokeComposerImages(images: Array<ComposerImage>) {
  for (const image of images) {
    if (image.kind === 'local') URL.revokeObjectURL(image.url)
  }
}

/**
 * Upload only `local` images; `uploaded` ones already live on the host and
 * pass straight through with zero network traffic.
 */
export async function materializeAttachments(
  images: Array<ComposerImage>,
  onProgress?: (step: number, total: number) => void,
): Promise<Array<string>> {
  const localTotal = images.filter((img) => img.kind === 'local').length
  let uploadedCount = 0
  const out: Array<string> = []
  for (const image of images) {
    if (image.kind === 'uploaded') {
      out.push(image.name)
      continue
    }
    uploadedCount += 1
    onProgress?.(uploadedCount, localTotal)
    const small = await shrinkImage(image.file)
    out.push(await uploadBlob(small, 'image/jpeg'))
  }
  return out
}

/** drop a session's saved picks now, not when the state effect would run
 * (it never does once the page is gone) */
export const forgetPicks = (id: string) =>
  del(draftKey(id), store()).catch(() => undefined)

/**
 * Put picks back after a failed send unless new ones were picked since; a
 * mounted composer of that session reloads them (the page may be gone or
 * opened again meanwhile).
 */
export async function restorePicks(id: string, picks: Saved) {
  if (!picks.length) return
  try {
    const current = await get<Saved>(draftKey(id), store())
    if (current?.length) return
    await set(draftKey(id), picks, store())
  } catch {
    // storage blocked: the mounted composer still hears about them
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { id, picks } }))
}

export function usePickedImages(
  id: string,
  text: string,
  setText: SetText,
  textareaRef?: RefObject<HTMLTextAreaElement | null>,
) {
  const [images, setImages] = useState<Array<ComposerImage>>([])
  const urls = useRef(images)
  urls.current = images
  useEffect(() => () => revokeComposerImages(urls.current), [])

  const getTextarea = () =>
    textareaRef?.current ??
    (document.getElementById('session-composer') as HTMLTextAreaElement | null)

  // load this draft's saved picks once; save on every change after that
  // (never before: the empty first state would overwrite them)
  const loaded = useRef<string | null>(null)
  useEffect(() => {
    let live = true
    setImages((current) => {
      revokeComposerImages(current)
      return []
    })
    get<Saved>(draftKey(id), store())
      .catch(() => undefined)
      .then((saved) => {
        if (!live) return
        loaded.current = id
        if (!saved?.length) return
        setImages(hydrateSaved(saved))
      })
    const onRestore = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; picks: Saved }>).detail
      if (detail.id !== id) return
      setImages((current) =>
        current.length ? current : hydrateSaved(detail.picks),
      )
    }
    window.addEventListener(EVENT, onRestore)
    return () => {
      live = false
      window.removeEventListener(EVENT, onRestore)
    }
  }, [id])

  useEffect(() => {
    if (loaded.current !== id) return
    const saved = toSaved(images)
    void (
      saved.length
        ? set(draftKey(id), saved, store())
        : del(draftKey(id), store())
    ).catch(() => undefined) // storage blocked: picks just don't persist
  }, [id, images])

  const pick = (files: Iterable<File> | null) => {
    const room = MAX_IMAGES - images.length
    const added: Array<ComposerImage> = [...(files ?? [])]
      .filter((file) => file.type.startsWith('image/'))
      .slice(0, room)
      .map((file) => ({
        kind: 'local',
        key: crypto.randomUUID(),
        file,
        url: URL.createObjectURL(file),
      }))
    if (!added.length) return
    const tokens = added.map((_, i) => imageToken(images.length + i + 1))
    const box = getTextarea()
    // the caret survives a blur (the file picker took focus)
    const caret =
      box instanceof HTMLTextAreaElement ? box.selectionStart : text.length
    const next = insertTokens(text, caret, tokens)
    setImages((current) => [...current, ...added])
    setText(next.text)
    requestAnimationFrame(() => {
      if (!(box instanceof HTMLTextAreaElement)) return
      box.focus()
      box.setSelectionRange(next.caret, next.caret)
    })
  }

  const remove = (key: string) => {
    const n = images.findIndex((image) => image.key === key) + 1
    if (n > 0) setText((current) => dropToken(current, n))
    setImages((current) => {
      const gone = current.find((image) => image.key === key)
      if (gone?.kind === 'local') URL.revokeObjectURL(gone.url)
      return current.filter((image) => image.key !== key)
    })
  }

  /** [图片n] again at the caret (its number tapped on the thumbnail) */
  const insertToken = (n: number) => {
    const box = getTextarea()
    const caret =
      box instanceof HTMLTextAreaElement ? box.selectionStart : text.length
    const next = insertTokens(text, caret, [imageToken(n)])
    setText(next.text)
    requestAnimationFrame(() => {
      if (!(box instanceof HTMLTextAreaElement)) return
      box.focus()
      box.setSelectionRange(next.caret, next.caret)
    })
  }

  const appendUploaded = (names: Array<string>) => {
    if (!names.length) return
    setImages((current) => {
      const room = Math.max(0, MAX_IMAGES - current.length)
      const added: Array<ComposerImage> = names.slice(0, room).map((name) => ({
        kind: 'uploaded',
        key: crypto.randomUUID(),
        name,
      }))
      return added.length ? [...current, ...added] : current
    })
  }

  const replaceUploaded = (names: Array<string>) => {
    setImages((current) => {
      revokeComposerImages(current)
      return names.slice(0, MAX_IMAGES).map((name) => ({
        kind: 'uploaded',
        key: crypto.randomUUID(),
        name,
      }))
    })
  }

  return {
    images,
    setImages,
    pick,
    remove,
    insertToken,
    appendUploaded,
    replaceUploaded,
    toSaved: () => toSaved(images),
  }
}
