// Decide whether Enter in the session composer sends vs inserts a newline.
// Touch-only phones keep Enter = newline (no Shift+Enter on soft keyboards),
// while desktops and tablets with a hardware keyboard (with or without a
// trackpad) use Enter = send and Shift+Enter = newline. A per-device preference
// (`auto` | `newline` | `send`) can override plain Enter explicitly.
import type { EnterMode } from '#/lib/enter-pref'

export type HardwareKeyEvent = {
  code?: string
  key?: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

export type EnterSendInput = {
  /** per-device preference override (`auto` by default) */
  mode?: EnterMode
  /** `(hover: none) and (pointer: coarse)` */
  coarsePrimary: boolean
  /** `(any-pointer: fine) or (any-hover: hover)` — mouse / trackpad attached */
  anyFinePointer: boolean
  /** viewport ≥ 768 px (desktop or tablet) */
  wide: boolean
  /** a hardware-only key (Shift/Ctrl/Alt/Meta/Arrows/Tab/Esc) was observed */
  sawHardwareKey: boolean
  /** on-screen virtual keyboard is occupying the viewport */
  softKeyboardOpen: boolean
  key: string
  code?: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  isComposing: boolean
  keyCode?: number
}

const HARDWARE_CODES =
  /^(Shift|Control|Alt|Meta)(Left|Right)$|^Arrow(Up|Down|Left|Right)$|^(Tab|Escape)$/

/**
 * True for keys that only come from a physical keyboard (never a phone IME).
 * Bare `shiftKey` / `key: 'Shift'` / `Arrow*` without a physical `event.code`
 * are excluded because mobile soft keyboards emit them for uppercase letters,
 * shifted punctuation (e.g. `?` / `？`), and soft cursor toolbars.
 */
export function isHardwareOnlyKey(event: HardwareKeyEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return true
  if (event.shiftKey && event.key === 'Enter') return true
  if (event.code && HARDWARE_CODES.test(event.code)) return true
  return (
    event.key === 'Control' ||
    event.key === 'Alt' ||
    event.key === 'Meta' ||
    event.key === 'Tab' ||
    event.key === 'Escape'
  )
}

/**
 * Pure soft-keyboard detection that handles both `interactive-widget=resizes-visual`
 * (iOS Safari: `innerHeight - vvHeight > 150`) and `interactive-widget=resizes-content`
 * (Android Chrome / PWA, used in `__root.tsx`: `innerHeight` and `vvHeight` shrink
 * together against the full-height baseline for the current width).
 */
export function detectSoftKeyboardOpen({
  vkHeight = 0,
  innerHeight,
  vvHeight,
  baselineHeight,
}: {
  vkHeight?: number
  innerHeight: number
  vvHeight?: number
  baselineHeight?: number
}): boolean {
  if (vkHeight > 0) return true
  if (vvHeight !== undefined && innerHeight - vvHeight > 150) return true
  const current =
    vvHeight !== undefined ? Math.min(innerHeight, vvHeight) : innerHeight
  if (baselineHeight !== undefined && baselineHeight - current > 150)
    return true
  return false
}

let baselineWidth = 0
let baselineHeight = 0

function syncViewportBaseline() {
  if (typeof window === 'undefined') return
  const width = window.innerWidth
  const height = Math.max(
    window.innerHeight,
    window.visualViewport?.height ?? 0,
  )
  if (!baselineWidth || Math.abs(width - baselineWidth) > 40) {
    baselineWidth = width
    baselineHeight = height
  } else if (height > baselineHeight) {
    baselineHeight = height
  }
}

if (typeof window !== 'undefined') {
  syncViewportBaseline()
  window.addEventListener('resize', syncViewportBaseline, { passive: true })
  window.visualViewport?.addEventListener('resize', syncViewportBaseline, {
    passive: true,
  })
}

/** True when an on-screen virtual keyboard visibly shrinks the viewport. */
export function isSoftKeyboardOpen(): boolean {
  if (typeof window === 'undefined') return false
  syncViewportBaseline()
  const vk = (
    navigator as Navigator & {
      virtualKeyboard?: { boundingRect?: { height?: number } }
    }
  ).virtualKeyboard
  return detectSoftKeyboardOpen({
    vkHeight: vk?.boundingRect?.height ?? 0,
    innerHeight: window.innerHeight,
    vvHeight: window.visualViewport?.height,
    baselineHeight,
  })
}

export function resolveEnterKeyHint({
  mode = 'auto',
  coarsePrimary,
  anyFinePointer,
  wide,
  sawHardwareKey,
}: {
  mode?: EnterMode
  coarsePrimary: boolean
  anyFinePointer: boolean
  wide: boolean
  sawHardwareKey: boolean
}): 'enter' | 'send' {
  if (mode === 'newline') return 'enter'
  if (mode === 'send') return 'send'
  const breaksLine =
    coarsePrimary && (!wide || (!anyFinePointer && !sawHardwareKey))
  return breaksLine ? 'enter' : 'send'
}

export function shouldEnterSend(input: EnterSendInput): boolean {
  if (input.key !== 'Enter') return false
  // IME candidate confirmation (拼音 → 汉字) must never send
  if (input.isComposing || input.keyCode === 229) return false
  // Shift+Enter / Alt+Enter always insert a newline
  if (input.shiftKey || input.altKey) return false
  // Ctrl/⌘+Enter sends everywhere
  if (input.ctrlKey || input.metaKey) return true
  // Per-device explicit override (e.g. phone with a physical keyboard, or
  // desktop user who prefers Enter = newline)
  if (input.mode === 'newline') return false
  if (input.mode === 'send') return true
  // Desktop / laptop (fine / hover primary pointer)
  if (!input.coarsePrimary) return true
  // Touch-primary phone (<768 px): plain Enter always inserts a newline even
  // when a stylus, virtual remote pointer (e.g. OPPO 互联), or floating soft
  // keyboard is active.
  if (!input.wide) return false
  // Touch-primary tablet (≥768 px) with on-screen soft keyboard open → newline
  // even if a trackpad/stylus reports anyFinePointer.
  if (input.softKeyboardOpen) return false
  // Tablet keyboard case with trackpad / mouse
  if (input.anyFinePointer) return true
  // Tablet with Bluetooth keyboard (no trackpad):
  // - once any physical-only key (Ctrl/Alt/Meta/Tab/Esc/Shift-code/Shift+Enter) is seen, or
  // - when Enter carries a physical key code
  if (input.sawHardwareKey) return true
  if (input.code === 'Enter' || input.code === 'NumpadEnter') return true
  return false
}
