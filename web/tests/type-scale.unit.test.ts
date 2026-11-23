import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The console speaks one type scale (text-meta / caption / body / title /
// heading / display in styles/tokens.css), three weights and Tailwind's radius
// steps. ~20 hand-picked pixel sizes (12 / 12.5 / 13 / 13.5…) and a dozen
// radii were what made the pages feel slightly off; this keeps them out.
const src = join(import.meta.dirname, '..', 'src')
// marketing pages keep their hero sizes
const EXEMPT = [
  'features/landing-page.tsx',
  'features/architecture/architecture-page.tsx',
]
const RULES: Array<[string, RegExp]> = [
  [
    'arbitrary font size (use text-meta … text-display)',
    /(?<![\w-])text-\[\d+(?:\.\d+)?px\]/g,
  ],
  [
    'arbitrary radius (use rounded-lg / xl / 2xl / 3xl / full)',
    /(?<![\w-])rounded-\[\d+px\]/g,
  ],
  [
    'font-bold (weights are normal / medium / semibold)',
    /(?<![\w-])font-bold(?![\w-])/g,
  ],
]

const files = (readdirSync(src, { recursive: true }) as Array<string>).filter(
  (file) =>
    /\.tsx?$/.test(file) &&
    !file.endsWith('routeTree.gen.ts') &&
    !EXEMPT.includes(file),
)

describe('type scale (one set of sizes, weights and radii)', () => {
  for (const [rule, pattern] of RULES)
    it(`no ${rule}`, () => {
      const hits = files.flatMap((file) =>
        [...readFileSync(join(src, file), 'utf8').matchAll(pattern)].map(
          (m) => `${file}: ${m[0]}`,
        ),
      )
      expect(hits).toEqual([])
    })
})
