// covers: web/src/features/chat-scroll.ts web/src/features/chat-tools.tsx
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Opening and closing a call at the bottom of a live thread (交互调试 ›
// 展开收起工具调用): the tapped row keeps its place, closing keeps up to half
// a screen of the room it gave up and stays at the bottom (no 回到最新);
// more than that glides away with the row still on screen.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

const measure = (page: Page) =>
  page.getByTestId('toggle-demo').evaluate((root) => {
    const el = root.querySelector<HTMLElement>('.overflow-y-auto')!
    const end = root.querySelector<HTMLElement>(
      '[data-testid=toggle-demo-end]',
    )!
    const row = [...root.querySelectorAll<HTMLElement>('button[aria-expanded]')]
      .filter((b) => b.textContent.includes('web-affected-tests'))
      .at(-1)!
    const box = el.getBoundingClientRect()
    const r = row.getBoundingClientRect()
    return {
      row: r.top - box.top,
      visible: r.top >= box.top && r.bottom <= box.bottom,
      borrowed: parseFloat(end.style.height) || 0,
      half: el.clientHeight / 2,
      left: Math.round(
        el.scrollHeight -
          (parseFloat(end.style.height) || 0) -
          el.clientHeight -
          el.scrollTop,
      ),
    }
  })

describe('Opening and closing a call', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('the row stays, closing keeps the bottom without 回到最新', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#tool-toggle`)
    const demo = page.getByTestId('toggle-demo')
    await demo.waitFor({ timeout: 20_000 })
    await page.waitForTimeout(800)
    const row = demo
      .locator('button[aria-expanded]', { hasText: 'web-affected-tests' })
      .last()
    const before = await measure(page)
    await row.click()
    await page.waitForTimeout(700)
    const opened = await measure(page)
    expect(Math.abs(opened.row - before.row), 'open: row stays').toBeLessThan(2)
    await row.click()
    await page.waitForTimeout(900)
    const closed = await measure(page)
    console.log('toggle', JSON.stringify({ before, opened, closed }))
    expect(closed.visible, 'closed: row on screen').toBe(true)
    expect(
      closed.borrowed,
      'closed: at most half a screen of room',
    ).toBeLessThanOrEqual(closed.half + 1)
    // pinned: the session page shows no 回到最新
    expect(await demo.getAttribute('data-pinned'), 'still at the bottom').toBe(
      'true',
    )
    await context.close()
  })
})
