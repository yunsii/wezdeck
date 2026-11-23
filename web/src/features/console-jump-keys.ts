// `g` + letter jumps between console sections and `/` focuses search
// (keyboard-first stance); the sidebar shows the letters from JUMP_KEYS.
import { useEffect, useRef } from 'react'

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
  // One listener for the page's life: when it re-registered on every new
  // `go` (a poll re-renders the shell every 1–2.5 s), a re-render between
  // g and the letter reset the armed state and the jump was lost — a slow
  // second key, or a loaded test run, hit it.
  const goRef = useRef(go)
  goRef.current = go
  useEffect(() => {
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
        armedAt = Date.now()
        return
      }
      const section = JUMP_KEYS[event.key]
      if (jumpPending() && section) {
        event.preventDefault()
        goRef.current(section)
      }
      // let page shortcuts (c / n) see the key first, then disarm
      setTimeout(() => (armedAt = 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
