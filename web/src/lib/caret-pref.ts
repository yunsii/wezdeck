// The text caret's shape in every text box of the console (CSS caret-shape,
// Chrome 144+; elsewhere it stays the browser's thin bar). A per-device
// choice like the theme (我的 › 外观), applied before first paint by
// themeBootstrapScript as <html data-caret>. The browser's bar by default
// (a block by default read as odd in a text box; it stays a choice).
import { useState } from 'react'

export const CARET_SHAPES = ['bar', 'block', 'underscore'] as const
export type CaretShape = (typeof CARET_SHAPES)[number]

const KEY = 'wezdeck-caret'

export const caretBootstrap = `var c=localStorage.getItem('${KEY}');if(c!=='block'&&c!=='underscore')c='bar';document.documentElement.dataset.caret=c;`

const read = (): CaretShape => {
  if (typeof document === 'undefined') return 'bar'
  const shape = document.documentElement.dataset.caret
  return CARET_SHAPES.includes(shape as CaretShape)
    ? (shape as CaretShape)
    : 'bar'
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
