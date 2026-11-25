// covers: web/src/features/console-interactions.tsx
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 交互调试 on a desk: the case list and the detail each scroll on their own,
// pinned in view; the list's group headings and the detail's title stick.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Interaction debugging layout', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('wide: columns scroll on their own, headings stick', async () => {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#status-bar`)
    const list = page.getByTestId('interaction-list-scroll')
    await list.waitFor({ timeout: 20_000 })
    // the list is taller than the window: it scrolls, the page barely does
    const sizes = await page.evaluate(() => {
      const column = document.querySelector<HTMLElement>(
        '[data-testid=interaction-list-scroll]',
      )!
      const scroller = column.closest('.vt-page') as HTMLElement
      return {
        listScrolls: column.scrollHeight > column.clientHeight,
        pageRoom: scroller.scrollHeight - scroller.clientHeight,
      }
    })
    expect(sizes.listScrolls).toBe(true)
    // the columns fill the window exactly: the page itself never scrolls
    expect(sizes.pageRoom).toBeLessThanOrEqual(1)
    // whatever the detail holds (short, long, a live demo)
    for (const id of ['claude-ask', 'stream', 'git-status', 'tool-toggle']) {
      await page.goto(`${base}/zh/console/me/interactions#${id}`)
      await page.getByTestId('interaction-detail').waitFor()
      await page.waitForTimeout(400)
      const room = await page.evaluate(() => {
        const scroller = document
          .querySelector('[data-testid=interaction-list-scroll]')
          ?.closest('.vt-page') as HTMLElement
        return scroller.scrollHeight - scroller.clientHeight
      })
      expect(room, `${id}: page room`).toBeLessThanOrEqual(1)
    }
    // scroll the list: its first group heading stays at the list's top
    const stuck = await list.evaluate((el) => {
      el.scrollTop = 400
      const heading = el.querySelector('h2')!
      return Math.abs(
        heading.getBoundingClientRect().top - el.getBoundingClientRect().top,
      )
    })
    expect(stuck).toBeLessThan(2)
    await context.close()
  })
})
