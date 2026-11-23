// `g` + letter jumps between console sections and `/` focuses search
// (keyboard-first stance); the sidebar shows the letters from JUMP_KEYS.
import { useEffect } from 'react'

import type { Section } from './console-shell'

/** `g` + letter jumps (keyboard-first stance); shown in sidebar titles. */
export const JUMP_KEYS: Partial<Record<string, Section>> = {
  x: 'diagnostics',
  c: 'collab',
  s: 'sessions',
  a: 'activity',
  m: 'me',
}

let armedAt = 0

/** `g` was just pressed: the next key is a jump, not a page's own shortcut */
export const jumpPending = () => Date.now() - armedAt < 1200

export function useJumpKeys(go: (section: Section) => void) {
  useEffect(() => {
    let armed = 0
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]')
      )
        return
      if (event.key === '/') {
        const box = document.querySelector<HTMLInputElement>('[data-search]')
        if (box) {
          event.preventDefault()
          box.focus()
        }
        return
      }
      if (event.key === 'g') {
        armed = Date.now()
        armedAt = armed
        return
      }
      const section = JUMP_KEYS[event.key]
      if (armed && Date.now() - armed < 1200 && section) {
        event.preventDefault()
        go(section)
      }
      armed = 0
      // let page shortcuts (c / n) see the key first, then disarm
      setTimeout(() => (armedAt = 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])
}
