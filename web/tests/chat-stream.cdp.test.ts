// covers: web/src/features/chat-stream.ts web/src/features/chat-thread.tsx
// covers: web/src/features/chat-scroll.ts web/src/features/chat-markdown.tsx
// covers: web/src/features/chat-turn.tsx
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// A long reply streaming in (交互调试 › 长回复流式写出), measured every
// frame: the reply's box grows smoothly and the turn line under it (运行中)
// stays where it is — it used to drop a line and glide back on every wrap.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Streaming reply', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('a long reply grows smoothly while the turn line stays put', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#stream`)
    const demo = page.getByTestId('stream-demo')
    await demo.waitFor({ timeout: 20_000 })
    // every frame for 3.5 s from the reply's arrival: where the turn line
    // sits in the scroller, and how much of the reply is laid out
    const frames = await demo.evaluate(
      (root) =>
        new Promise<Array<{ line: number; reply: number }>>((done) => {
          const el = root.querySelector<HTMLElement>('.overflow-y-auto')!
          const out: Array<{ line: number; reply: number }> = []
          let start = 0
          const tick = (now: number) => {
            const line = root.querySelector('[data-activity]')
            const reply = root.querySelector('[data-msg="5"]')
            if (line && reply) {
              start ||= now
              out.push({
                line:
                  line.getBoundingClientRect().top -
                  el.getBoundingClientRect().top,
                reply: reply.getBoundingClientRect().height,
              })
            }
            if (!start || now - start < 3_500) requestAnimationFrame(tick)
            else done(out)
          }
          requestAnimationFrame(tick)
        }),
    )
    // once the reply has started growing past a screen's worth of motion
    const settled = frames.slice(20)
    const lines = settled.map((f) => f.line)
    const spread = Math.max(...lines) - Math.min(...lines)
    const grew = (settled.at(-1)?.reply ?? 0) - (settled[0]?.reply ?? 0)
    console.log(
      `stream: frames=${frames.length} turn-line spread=${spread.toFixed(1)}px reply grew=${grew.toFixed(0)}px`,
    )
    expect(grew).toBeGreaterThan(100)
    expect(spread).toBeLessThan(2)
    // the reply's height steps: no single frame jumps a whole line
    const steps = settled
      .slice(1)
      .map((f, i) => f.reply - (settled[i]?.reply ?? 0))
    expect(Math.max(...steps)).toBeLessThan(14)
    await context.close()
  })
})
