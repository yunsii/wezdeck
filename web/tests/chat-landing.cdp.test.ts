// covers: web/src/features/chat-landing.ts web/src/features/chat-scroll.ts
// covers: web/src/features/chat-sticky.tsx web/src/features/chat-thread.tsx
// covers: web/src/features/console-sessions.tsx
// covers: web/src/features/console-interactions-landing.tsx
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Opening a newly completed (`done`) conversation whose latest reply is taller
// than the viewport (交互调试 › 进入会话的长回复落点): lands at the start of
// that reply (below StickyPrompt) instead of showing only its tail, stays still
// as progressive hydration fills earlier messages above, and tapping 最新 jumps
// to the bottom and re-pins. Later visits (`idle`) with the same long reply
// land directly at the bottom.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Opening a session lands on a long latest reply only when newly done', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('done lands at the start of a tall latest reply; idle lands at the bottom', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#long-reply-land`)
    const doneDemo = page.getByTestId('landing-done-demo')
    const idleDemo = page.getByTestId('landing-idle-demo')
    await doneDemo.waitFor({ timeout: 20_000 })
    // wait past progressive hydration (14 earlier messages) and initial settle
    await page.waitForTimeout(900)

    expect(
      await doneDemo.getAttribute('data-pinned'),
      'newly done tall latest reply starts unpinned',
    ).toBe('false')
    expect(
      await idleDemo.getAttribute('data-pinned'),
      'idle reopen with the same tall reply lands pinned at bottom',
    ).toBe('true')

    const doneBox = await doneDemo.evaluate((root) => {
      const scroller = root.querySelector<HTMLElement>('.overflow-y-auto')
      const msgs = Array.from(root.querySelectorAll<HTMLElement>('[data-msg]'))
      const last = msgs.at(-1)
      if (!scroller || !last) throw new Error('missing scroller or message')
      const sticky = root.querySelector<HTMLElement>(
        '[data-testid=sticky-prompt]',
      )
      const sr = scroller.getBoundingClientRect()
      const lr = last.getBoundingClientRect()
      const str = sticky?.getBoundingClientRect()
      return {
        rendered: msgs.length,
        scrollerTop: Math.round(sr.top),
        lastTop: Math.round(lr.top),
        stickyBottom: str ? Math.round(str.bottom) : null,
        scrollTop: Math.round(scroller.scrollTop),
        maxScroll: Math.round(scroller.scrollHeight - scroller.clientHeight),
      }
    })
    // progressive hydration finished (all 16 messages rendered)
    expect(doneBox.rendered).toBe(16)
    // latest reply's start is in view, not clipped above the viewport
    expect(doneBox.lastTop).toBeGreaterThanOrEqual(doneBox.scrollerTop)
    // and sits cleanly below StickyPrompt without overlap
    expect(doneBox.stickyBottom).not.toBeNull()
    expect(doneBox.lastTop).toBeGreaterThanOrEqual(
      (doneBox.stickyBottom ?? 0) - 2,
    )
    // reply genuinely extends past the bottom (we are not at the tail)
    expect(doneBox.maxScroll - doneBox.scrollTop).toBeGreaterThan(100)

    // tapping 最新 jumps to the bottom and re-pins
    await page.getByTestId('landing-done-demo-jump').click()
    await expect
      .poll(() => doneDemo.getAttribute('data-pinned'), { timeout: 5_000 })
      .toBe('true')
    await expect
      .poll(
        () =>
          doneDemo.evaluate((root) => {
            const scroller = root.querySelector<HTMLElement>('.overflow-y-auto')
            if (!scroller) return -1
            return Math.round(
              scroller.scrollHeight -
                scroller.clientHeight -
                scroller.scrollTop,
            )
          }),
        { timeout: 5_000 },
      )
      .toBeLessThan(8)

    // idle demo sits at its real bottom
    const idleLeft = await idleDemo.evaluate((root) => {
      const scroller = root.querySelector<HTMLElement>('.overflow-y-auto')
      if (!scroller) return -1
      return Math.round(
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      )
    })
    expect(idleLeft).toBeLessThan(8)

    await context.close()
  })
})
