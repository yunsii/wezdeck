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
