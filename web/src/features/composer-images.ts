// The composer's picked images (file picker, pasted screenshots): previews
// as object URLs, freed when removed or when the page goes; each one leaves
// [图片N] at the caret, removing it drops the token and renumbers the rest
// (composer-tokens.ts), so the text says which picture is which.
// Kept with the draft: the text is in localStorage (useDraft), the picked
// files in IndexedDB per session, so a reload brings back both — the text's
// [图片N] used to survive while its pictures were gone.
import { createStore, del, get, set } from 'idb-keyval'
import { useEffect, useRef, useState } from 'react'

import { dropToken, imageToken, insertTokens } from './composer-tokens'

export const MAX_IMAGES = 5

export type Picked = { key: string; file: File; url: string }

type SetText = (next: string | ((current: string) => string)) => void

// own database, like the device key (idb-keyval makes a store only with
// its database)
const store = () => createStore('wezdeck-draft-images', 'images')
const draftKey = (id: string) => `draft:${id}`
type Saved = Array<{ key: string; file: File }>

export function usePickedImages(id: string, text: string, setText: SetText) {
  const [images, setImages] = useState<Array<Picked>>([])
  const urls = useRef(images)
  urls.current = images
  useEffect(
    () => () => urls.current.forEach((image) => URL.revokeObjectURL(image.url)),
    [],
  )
  // load this session's saved picks once; save on every change after that
  // (never before: the empty first state would overwrite them)
  const loaded = useRef<string | null>(null)
  useEffect(() => {
    let live = true
    get<Saved>(draftKey(id), store())
      .catch(() => undefined)
      .then((saved) => {
        if (!live) return
        loaded.current = id
        if (!saved?.length) return
        setImages(
          saved.map((item) => ({
            key: item.key,
            file: item.file,
            url: URL.createObjectURL(item.file),
          })),
        )
      })
    return () => {
      live = false
    }
  }, [id])
  useEffect(() => {
    if (loaded.current !== id) return
    const saved: Saved = images.map(({ key, file }) => ({ key, file }))
    void (
      saved.length
        ? set(draftKey(id), saved, store())
        : del(draftKey(id), store())
    ).catch(() => undefined) // storage blocked: picks just don't persist
  }, [id, images])

  const pick = (files: Iterable<File> | null) => {
    const room = MAX_IMAGES - images.length
    const added = [...(files ?? [])]
      .filter((file) => file.type.startsWith('image/'))
      .slice(0, room)
      .map((file) => ({
        key: crypto.randomUUID(),
        file,
        url: URL.createObjectURL(file),
      }))
    if (!added.length) return
    const tokens = added.map((_, i) => imageToken(images.length + i + 1))
    const box = document.getElementById('session-composer')
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
      if (gone) URL.revokeObjectURL(gone.url)
      return current.filter((image) => image.key !== key)
    })
  }

  /** [图片n] again at the caret (its number tapped on the thumbnail) */
  const insertToken = (n: number) => {
    const box = document.getElementById('session-composer')
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

  return { images, setImages, pick, remove, insertToken }
}
