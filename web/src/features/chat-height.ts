// Height estimation for progressive chat mounting and CSS content-visibility.
// Pure arithmetic (zero DOM reads / zero reflow): gives `useProgressiveFloor`
// enough items to fill ~2 mobile screens even when recent turns are short
// one-liners or collapsed tool runs, while stopping early on long Markdown
// replies so initial navigation stays jank-free.
import type { Item } from './chat-thread'

/** Minimum items mounted on Frame 0 (when the thread has at least this many). */
export const MIN_FIRST_ITEMS = 6
/** Cap Frame-0 mount even for dense tool/one-line runs so mount stays bounded. */
export const MAX_FIRST_ITEMS = 18
/** Target vertical height (~2 mobile viewports) to fill before deferring older items. */
export const INITIAL_VIEWPORT_PX = 1400

const LINE_HEIGHT_PX = 22
const MOBILE_LINE_UNITS = 38 // ~38 ASCII or ~21 CJK chars per mobile bubble line

function round8(px: number) {
  return Math.round(px / 8) * 8
}

function estimateTextLines(text: string): number {
  if (!text) return 1
  let lines = 0
  let cur = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code === 10) {
      lines += Math.max(1, Math.ceil(cur / MOBILE_LINE_UNITS))
      cur = 0
      continue
    }
    // CJK / full-width / emoji take ~1.8× an ASCII glyph width.
    cur += code > 0x2e7f ? 1.8 : 1
  }
  lines += Math.max(1, Math.ceil(cur / MOBILE_LINE_UNITS))
  return lines
}

/**
 * Estimate rendered vertical height (px) of one grouped thread item without
 * touching DOM layout. Used both for Frame-0 height budgeting and as the
 * fallback `--chat-item-est` for `contain-intrinsic-size: auto`.
 */
export function estimateItemHeight(item: Item): number {
  if (item.kind === 'tools') return 44
  const { message } = item
  if (message.role === 'system') {
    if (message.kind === 'compact') return 36
    if (message.kind === 'artifact') return 72
    return 44
  }
  const text = message.text.trim()
  const lines = estimateTextLines(text)
  const fences = Math.floor((text.match(/```/g)?.length ?? 0) / 2)
  const images = Math.min(message.images?.length ?? 0, 4)
  const pad = message.role === 'user' ? 32 : 24
  const raw = pad + lines * LINE_HEIGHT_PX + fences * 28 + images * 150
  return round8(Math.max(44, Math.min(2400, raw)))
}

/**
 * First absolute message index to mount synchronously when a conversation
 * opens. Walks backward from the newest item until estimated height covers
 * `targetHeight` (clamped between MIN_FIRST_ITEMS and MAX_FIRST_ITEMS), or
 * returns `-Infinity` when the whole loaded page fits in the initial slice.
 */
export function computeInitialFloor(
  items: Array<Item>,
  start: number,
  targetHeight = INITIAL_VIEWPORT_PX,
): number {
  if (items.length <= MIN_FIRST_ITEMS) return -Infinity
  let height = 0
  let count = 0
  for (let i = items.length - 1; i >= 0 && count < MAX_FIRST_ITEMS; i -= 1) {
    height += estimateItemHeight(items[i]) + 8 // +8px grid gap
    count += 1
    if (count >= MIN_FIRST_ITEMS && height >= targetHeight) break
  }
  if (count >= items.length) return -Infinity
  return start + items[items.length - count].index
}
