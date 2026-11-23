import { describe, expect, it } from 'vitest'

import { parseBody } from '#/features/chat-diff'
import { langOf } from '#/lib/highlight'

describe('tool body parsing', () => {
  it('unified hunks number lines: old side for removed, new side otherwise', () => {
    const { rows, code } = parseBody(
      '@@ -10,3 +10,4 @@\n keep\n-old\n+new\n+more\n keep2\n@@ -40,1 +41,1 @@\n-x\n+y\n… (+3 lines)',
    )
    expect(code).toBe(true)
    expect(rows.map((r) => [r.kind, r.no ?? null, r.text])).toEqual([
      ['hunk', null, '@@ -10,3 +10,4 @@'],
      ['ctx', 10, 'keep'],
      ['del', 11, 'old'],
      ['add', 11, 'new'],
      ['add', 12, 'more'],
      ['ctx', 13, 'keep2'],
      ['hunk', null, '@@ -40,1 +41,1 @@'],
      ['del', 40, 'x'],
      ['add', 41, 'y'],
      ['note', null, '… (+3 lines)'],
    ])
  })

  it('the pre-result "- / + " form keeps red / green rows, no numbers', () => {
    const { rows, code } = parseBody('- a\n+ b')
    expect(code).toBe(true)
    expect(rows).toEqual([
      { kind: 'del', text: 'a' },
      { kind: 'add', text: 'b' },
    ])
  })

  it('anything else is plain', () => {
    const { rows, code } = parseBody('ls -la\n-rw file')
    expect(code).toBe(false)
    expect(rows.every((r) => r.kind === 'ctx' && r.no === undefined)).toBe(true)
  })

  it('languages by extension', () => {
    expect(langOf('/r/a.tsx')).toBe('tsx')
    expect(langOf('/r/relay.go')).toBe('go')
    expect(langOf('/r/Makefile')).toBe(null)
    expect(langOf(undefined)).toBe(null)
  })
})

describe('highlighting', () => {
  it('colours a line with both themes', async () => {
    const { highlightLines } = await import('#/lib/highlight')
    const out = await highlightLines(
      ['const a = 1 // note', 'func x() {}'],
      'typescript',
    )
    expect(out).toHaveLength(2)
    const keyword = out?.[0]?.find((t) => t.content === 'const')
    expect(keyword?.style?.['--shiki-dark']).toMatch(/^#/)
    expect(keyword?.style?.['--shiki-light']).toMatch(/^#/)
    expect(await highlightLines(['x'], 'nope')).toBe(null)
  })
})
