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
    // the growing box clips only its bottom: list markers hang to its left
    await expect
      .poll(
        () =>
          demo.evaluate((root) => {
            const box = root.querySelector<HTMLElement>('[data-growing]')
            return box ? getComputedStyle(box).overflowX : 'none yet'
          }),
        { timeout: 5_000 }, // the reply arrives 1.8 s in, after the landing
      )
      .toBe('visible')
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
                // what shows: the easing box around the thread's items
                reply: (
                  reply.parentElement?.parentElement ?? reply
                ).getBoundingClientRect().height,
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
    // 重放 streams it again (a remounted thread used to show it whole)
    await page.getByTestId('stream-replay').click()
    await expect
      .poll(
        () =>
          page
            .getByTestId('stream-demo')
            .evaluate((root) => root.querySelector('[data-growing]') !== null),
        { timeout: 5_000 },
      )
      .toBe(true)
    await context.close()
  })

  it('tool calls arriving leave the turn line where it is', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#tools-arriving`)
    const demo = page.getByTestId('tools-demo')
    await demo.waitFor({ timeout: 20_000 })
    // the first screen lands without easing (a call arrives 0.7 s in): the
    // open used to reveal the bottom of a running session like a scroll
    const easedEarly = await demo.evaluate(
      (root) =>
        new Promise<boolean>((done) => {
          const begin = performance.now()
          const tick = (now: number) => {
            if (root.querySelector('[data-growing]')) return done(true)
            if (now - begin < 1_200) requestAnimationFrame(tick)
            else done(false)
          }
          requestAnimationFrame(tick)
        }),
    )
    expect(easedEarly, 'no easing while the first screen lands').toBe(false)
    // every frame while the calls arrive (8 × 700 ms)
    const lines = await demo.evaluate(
      (root) =>
        new Promise<Array<number>>((done) => {
          const el = root.querySelector<HTMLElement>('.overflow-y-auto')!
          const out: Array<number> = []
          const begin = performance.now()
          const tick = (now: number) => {
            const line = root.querySelector('[data-activity]')
            if (line)
              out.push(
                line.getBoundingClientRect().top -
                  el.getBoundingClientRect().top,
              )
            if (now - begin < 6_500) requestAnimationFrame(tick)
            else done(out)
          }
          requestAnimationFrame(tick)
        }),
    )
    // after the first call pushed the thread past the screen
    const settled = lines.slice(Math.floor(lines.length / 4))
    const spread = Math.max(...settled) - Math.min(...settled)
    console.log(
      `tools: frames=${lines.length} turn-line spread=${spread.toFixed(1)}px`,
      lines
        .map((v) => Math.round(v))
        .filter((v, i, a) => v !== a[i - 1])
        .join(','),
    )
    expect(spread).toBeLessThan(2)
    await context.close()
  })
})
