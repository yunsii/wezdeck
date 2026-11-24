// The text caret's shape in every text box of the console (CSS caret-shape,
// Chrome 144+; elsewhere it stays the browser's thin bar). A per-device
// choice like the theme (我的 › 外观), applied before first paint by
// themeBootstrapScript as <html data-caret>. Block by default: the desk's
// WezTerm cursor is a blinking block (wezterm-x/lua/ui.lua).
import { useState } from 'react'

export const CARET_SHAPES = ['block', 'bar', 'underscore'] as const
export type CaretShape = (typeof CARET_SHAPES)[number]

const KEY = 'wezdeck-caret'

export const caretBootstrap = `var c=localStorage.getItem('${KEY}');if(c!=='bar'&&c!=='underscore')c='block';document.documentElement.dataset.caret=c;`

const read = (): CaretShape => {
  if (typeof document === 'undefined') return 'block'
  const shape = document.documentElement.dataset.caret
  return CARET_SHAPES.includes(shape as CaretShape)
    ? (shape as CaretShape)
    : 'block'
}

export function useCaretShape() {
  const [shape, setShape] = useState<CaretShape>(read)
  const set = (next: CaretShape) => {
    document.documentElement.dataset.caret = next
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // storage blocked: this page keeps it until reload
    }
    setShape(next)
  }
  return [shape, set] as const
}
