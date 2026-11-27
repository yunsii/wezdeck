// covers: web/src/features/chat-height.ts
import { describe, expect, it } from 'vitest'

import {
  MAX_FIRST_ITEMS,
  MIN_FIRST_ITEMS,
  computeInitialFloor,
  estimateItemHeight,
} from '#/features/chat-height'
import type { Item } from '#/features/chat-thread'

const msg = (
  index: number,
  role: 'user' | 'assistant',
  text: string,
): Item => ({
  kind: 'message',
  index,
  message: { role, text },
})

const tools = (index: number): Item => ({
  kind: 'tools',
  index,
  tools: [{ role: 'tool', text: 'read', tool: 'Read' }],
})

describe('estimateItemHeight', () => {
  it('assigns compact heights to collapsed tools and short messages', () => {
    expect(estimateItemHeight(tools(0))).toBe(44)
    expect(estimateItemHeight(msg(1, 'user', 'ok'))).toBeLessThanOrEqual(64)
  })

  it('scales up for long multiline Markdown and code fences', () => {
    const longReply = [
      '## Summary',
      ...Array.from(
        { length: 24 },
        (_, i) => `第 ${i + 1} 行中文详细分析内容，说明每个阶段的耗时分布`,
      ),
      '```ts',
      'const x = 1',
      'const y = 2',
      '```',
    ].join('\n')
    expect(estimateItemHeight(msg(0, 'assistant', longReply))).toBeGreaterThan(
      600,
    )
  })
})

describe('computeInitialFloor', () => {
  it('mounts up to MAX_FIRST_ITEMS when recent messages are short so the screen stays full', () => {
    const items = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? msg(i, 'user', '收到') : tools(i),
    )
    const floor = computeInitialFloor(items, 100)
    // 18 short items (~50px each) fill the mobile viewport without flashing empty.
    expect(floor).toBe(100 + (30 - MAX_FIRST_ITEMS))
  })

  it('stops at MIN_FIRST_ITEMS when recent replies are long Markdown', () => {
    const longText = Array.from(
      { length: 20 },
      (_, i) =>
        `Line ${i}: detailed architectural explanation with wrapped text`,
    ).join('\n')
    const items = Array.from({ length: 30 }, (_, i) =>
      msg(i, i % 2 === 0 ? 'user' : 'assistant', longText),
    )
    const floor = computeInitialFloor(items, 0)
    expect(floor).toBe(30 - MIN_FIRST_ITEMS)
  })

  it('returns -Infinity when all items fit within the initial slice', () => {
    const shortItems = Array.from({ length: 12 }, (_, i) =>
      msg(i, 'user', 'hi'),
    )
    expect(computeInitialFloor(shortItems, 0)).toBe(-Infinity)
  })
})
