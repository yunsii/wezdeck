// Session composer keys outside the text box itself (session-composer.tsx
// handles Enter / Shift+Enter inside it).
import { useEffect } from 'react'

/**
 * Space anywhere on the session page puts the caret in the composer (the
 * page is for talking to the agent; Space scrolling it was never wanted).
 * Not while typing, nor on a control Space already presses (button, link,
 * checkbox), nor with a sheet or dialog open.
 */
export function useSpaceToFocus() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== ' ' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return
      const target = event.target as HTMLElement | null
      if (
        target?.closest(
          'input, textarea, select, button, a[href], summary, [role=button], [role=checkbox], [role=switch], [role=option], [role=tab], [role=menuitem], [contenteditable="true"]',
        ) ||
        document.querySelector('[role=dialog], [role=alertdialog]')
      )
        return
      const box = document.getElementById('session-composer')
      if (!(box instanceof HTMLTextAreaElement) || box.disabled) return
      event.preventDefault()
      box.focus()
      // caret at the end of a kept draft, not before it
      box.setSelectionRange(box.value.length, box.value.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
