// [图片N] placeholders in the composer text: where the user writes about a
// picked image. The host lists the images as 图片1, 图片2 … in the order
// sent (remote_upload.go attachmentNote), so "把 [图片1] 的按钮改成 [图片2]
// 那样" says which picture is which. Chinese like the host's note, whatever
// the page language: the agent reads both.

export const imageToken = (n: number) => `[图片${n}]`

/**
 * Insert the tokens at `pos` (the caret), with a space on either side
 * unless the text already has one there; returns the text and the caret
 * just after them.
 */
export function insertTokens(text: string, pos: number, tokens: Array<string>) {
  const at = Math.max(0, Math.min(pos, text.length))
  const before = text.slice(0, at)
  const after = text.slice(at)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && /^\s/.test(after) ? '' : ' '
  const inserted = lead + tokens.join(' ') + trail
  return { text: before + inserted + after, caret: at + inserted.length }
}

/**
 * Image n was removed: drop its token (and one space next to it) and move
 * the later ones down, so the numbers still match the images sent.
 */
export function dropToken(text: string, n: number) {
  const gone = text
    .replace(
      new RegExp(` ?\\[图片${n}\\] ?`),
      (match, offset: number, whole: string) =>
        // a space between two words stays; at either end of the text none
        match.startsWith(' ') &&
        match.endsWith(' ') &&
        offset > 0 &&
        offset + match.length < whole.length
          ? ' '
          : '',
    )
    .replace(/\[图片(\d+)\]/g, (match, digits: string) => {
      const m = Number(digits)
      return m > n ? imageToken(m - 1) : match
    })
  return gone
}

const TOKEN = /\[图片\d+\]/g

/**
 * The [图片N] token the caret touches: ending at `pos` (Backspace, ←) or
 * starting at it (Delete, →); [start, end) or null. Tokens act as one unit
 * like a chat app's mention: one key removes or steps over the whole of it
 * instead of a character at a time.
 */
export function tokenAt(text: string, pos: number, side: 'before' | 'after') {
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index
    const end = start + match[0].length
    if (side === 'before' ? end === pos : start === pos)
      return [start, end] as const
    // the caret inside a token (a click landed there): the whole token
    if (start < pos && pos < end) return [start, end] as const
  }
  return null
}

/**
 * Backspace / Delete next to a [图片N] removes the whole token, ← / → step
 * over it (the composer's keydown). The image stays: its thumbnail's number
 * puts the token back, its × removes both. Returns whether it handled the
 * key.
 */
export function tokenKey(
  event: {
    key: string
    shiftKey: boolean
    altKey: boolean
    ctrlKey: boolean
    metaKey: boolean
    nativeEvent: { isComposing: boolean }
    currentTarget: HTMLTextAreaElement
    preventDefault: () => void
  },
  setText: (text: string) => void,
) {
  const keys = ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight']
  if (!keys.includes(event.key) || event.nativeEvent.isComposing) return false
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
    return false
  const box = event.currentTarget
  if (box.selectionStart !== box.selectionEnd) return false
  const pos = box.selectionStart
  const back = event.key === 'Backspace' || event.key === 'ArrowLeft'
  const hit = tokenAt(box.value, pos, back ? 'before' : 'after')
  if (!hit) return false
  const [start, end] = hit
  event.preventDefault()
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const to = event.key === 'ArrowLeft' ? start : end
    box.setSelectionRange(to, to)
    return true
  }
  setText(box.value.slice(0, start) + box.value.slice(end))
  requestAnimationFrame(() => box.setSelectionRange(start, start))
  return true
}
