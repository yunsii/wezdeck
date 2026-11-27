import { describe, expect, it } from 'vitest'

import {
  decodeHostFileHash,
  encodeHostFileHash,
  extractMarkdownHeadings,
  formatLineRange,
  parseHostFileHref,
  rehypeHostFileLinks,
} from '#/lib/host-file-link'

describe('host-file-link', () => {
  it('parses valid file:// URLs with optional line ranges and decoding', () => {
    expect(
      parseHostFileHref('file:///home/yuns/docs/my%20plan.md#L12-L30'),
    ).toEqual({
      path: '/home/yuns/docs/my plan.md',
      lineStart: 12,
      lineEnd: 30,
    })

    expect(parseHostFileHref('file://localhost/home/yuns/app.ts#L42')).toEqual({
      path: '/home/yuns/app.ts',
      lineStart: 42,
    })

    expect(parseHostFileHref('file:///home/yuns/README.md')).toEqual({
      path: '/home/yuns/README.md',
    })
  })

  it('rejects non-file protocols and remote file hosts', () => {
    expect(parseHostFileHref('https://example.com/a.md')).toBeNull()
    expect(parseHostFileHref('javascript:alert(1)')).toBeNull()
    expect(parseHostFileHref('file://evil.host/etc/passwd')).toBeNull()
  })

  it('round-trips hash encoding and line range formatting', () => {
    const target = {
      path: '/home/yuns/.gemini/antigravity-cli/brain/id/plan.md',
      lineStart: 5,
      lineEnd: 18,
    }
    const encoded = encodeHostFileHash(target)
    expect(encoded.startsWith('#wd-file:')).toBe(true)
    expect(decodeHostFileHash(encoded)).toEqual(target)
    expect(decodeHostFileHash('#normal-anchor')).toBeNull()
    expect(formatLineRange(5, 18)).toBe('L5–18')
    expect(formatLineRange(5)).toBe('L5')
    expect(formatLineRange()).toBe('')
  })

  it('rewrites file:// anchors in HAST while leaving https and javascript untouched', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'a',
          properties: { href: 'file:///home/yuns/plan.md#L3' },
          children: [],
        },
        {
          type: 'element',
          tagName: 'a',
          properties: { href: 'https://wezdeck.yuns.love' },
          children: [],
        },
        {
          type: 'element',
          tagName: 'a',
          properties: { href: 'javascript:alert(1)' },
          children: [],
        },
      ],
    }
    rehypeHostFileLinks()(tree)
    expect(decodeHostFileHash(tree.children[0].properties.href)).toEqual({
      path: '/home/yuns/plan.md',
      lineStart: 3,
    })
    expect(tree.children[1].properties.href).toBe('https://wezdeck.yuns.love')
    expect(tree.children[2].properties.href).toBe('javascript:alert(1)')
  })

  it('extracts H2 and H3 headings while skipping fenced code blocks', () => {
    const md = [
      '# Top',
      '## 1. Overview',
      '```md',
      '## Fake inside fence',
      '```',
      '### 1.1 [Link](https://x) & `code`',
      '## 2. Rollout',
    ].join('\n')
    expect(extractMarkdownHeadings(md)).toEqual([
      { level: 2, text: '1. Overview', index: 0 },
      { level: 3, text: '1.1 Link & code', index: 1 },
      { level: 2, text: '2. Rollout', index: 2 },
    ])
  })
})
