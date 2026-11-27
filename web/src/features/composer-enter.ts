// Decide whether Enter in the session composer sends vs inserts a newline.
// Touch-only phones keep Enter = newline (no Shift+Enter on soft keyboards),
// while desktops and tablets with a hardware keyboard (with or without a
// trackpad) use Enter = send and Shift+Enter = newline.

export type HardwareKeyEvent = {
  code?: string
  key?: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

export type EnterSendInput = {
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

/** True for keys that only come from a physical keyboard (never a phone IME). */
export function isHardwareOnlyKey(event: HardwareKeyEvent): boolean {
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)
    return true
  if (event.code && HARDWARE_CODES.test(event.code)) return true
  return (
    event.key === 'Shift' ||
    event.key === 'Control' ||
    event.key === 'Alt' ||
    event.key === 'Meta' ||
    event.key === 'Tab' ||
    event.key === 'Escape' ||
    event.key === 'ArrowUp' ||
    event.key === 'ArrowDown' ||
    event.key === 'ArrowLeft' ||
    event.key === 'ArrowRight'
  )
}

/** True when an on-screen virtual keyboard visibly shrinks the viewport. */
export function isSoftKeyboardOpen(): boolean {
  if (typeof window === 'undefined') return false
  const vk = (
    navigator as Navigator & {
      virtualKeyboard?: { boundingRect?: { height?: number } }
    }
  ).virtualKeyboard
  if ((vk?.boundingRect?.height ?? 0) > 0) return true
  const vv = window.visualViewport
  if (vv && window.innerHeight - vv.height > 150) return true
  return false
}

export function shouldEnterSend(input: EnterSendInput): boolean {
  if (input.key !== 'Enter') return false
  // IME candidate confirmation (拼音 → 汉字) must never send
  if (input.isComposing || input.keyCode === 229) return false
  // Shift+Enter / Alt+Enter always insert a newline
  if (input.shiftKey || input.altKey) return false
  // Ctrl/⌘+Enter sends everywhere
  if (input.ctrlKey || input.metaKey) return true
  // Desktop, or tablet keyboard case with trackpad / mouse
  if (!input.coarsePrimary || input.anyFinePointer) return true
  // On-screen touch keyboard open → keep Enter as newline
  if (input.softKeyboardOpen) return false
  // Tablet / phone with a hardware keyboard (even without a trackpad):
  // - once any physical-only key (Shift, Arrow, Tab, Esc, …) is seen, or
  // - on a tablet (≥768 px) when Enter carries a physical key code
  if (input.sawHardwareKey) return true
  if (input.wide && (input.code === 'Enter' || input.code === 'NumpadEnter'))
    return true
  return false
}
