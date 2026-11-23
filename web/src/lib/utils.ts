import { clsx } from 'clsx'
import type { ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// The type scale's names (styles/tokens.css) are font sizes. Unknown to
// tailwind-merge, `text-meta` read as a text colour, so cn('text-meta',
// 'text-brand-label') dropped the size as a "conflict" and the text fell back
// to the inherited 16 px.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        { text: ['meta', 'caption', 'body', 'title', 'heading', 'display'] },
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
