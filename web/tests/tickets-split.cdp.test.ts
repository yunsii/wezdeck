// covers: web/src/features/tickets-view.tsx web/src/features/ticket-keys.tsx
// covers: web/src/features/ticket-autosync.ts web/src/features/ticket-header.tsx
// covers: web/src/features/ticket-info.tsx web/src/features/ticket-runs.tsx
// covers: web/src/features/ticket-thread-view.tsx
// covers: web/src/features/ticket-reply.tsx
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 工单 on a desk-sized window (tickets-view.tsx): a split like 会话 — the
// list beside the open ticket, j / k move through it and the URL follows.
// Reads only: the stack serves a copy of the ticket store.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const stack = process.env.WEZDECK_TEST_STACK_DIR ?? ''

describe.runIf(stack)('Tickets split on a wide screen', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('list and ticket side by side; j moves on and marks the row', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 860 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/collab?remote=1#pair=${token}`)
    await page.getByTestId('ticket-pane').waitFor({ timeout: 20_000 })
    const rows = page.locator('a[data-ticket]')
    await expect
      .poll(() => rows.count(), { timeout: 15_000 })
      .toBeGreaterThan(0)
    if ((await rows.count()) < 2) return // a store with one ticket: nothing to move to
    // rows are real links: each has an address
    expect(await rows.first().getAttribute('href')).toMatch(
      /\/console\/collab\/req-/,
    )
    const marked = () =>
      page
        .locator('a[data-ticket][aria-current=page]')
        .getAttribute('data-ticket')
    const first = await marked()
    await page.mouse.click(900, 500)
    await page.keyboard.press('j')
    await expect.poll(() => page.url().split('/').at(-1)).not.toBe('collab')
    const now = page.url().split('/').at(-1)
    expect(now).not.toBe(first)
    // TanStack's Link marks the new address at once, the row highlight
    // follows a render later: wait for the one mark to settle
    await expect
      .poll(() => page.locator('a[data-ticket][aria-current=page]').count())
      .toBe(1)
    expect(await marked()).toBe(now)
    // the pane shows the ticket the URL names
    await expect
      .poll(() =>
        page
          .getByTestId('ticket-pane')
          .getByTestId('ticket-title')
          .getAttribute('data-ticket-id'),
      )
      .toBe(now)
    await context.close()
  })

  // 2026-11-24: the filter row (four counted segments + 搜索 + 新建) set the
  // page grid's width on a 360 px phone and every row ran off the right edge
  it('fits a narrow phone: nothing runs past the screen edge', async () => {
    for (const width of [320, 360]) {
      const context = await browser.newContext({
        viewport: { width, height: 760 },
        locale: 'zh-CN',
        isMobile: true,
        hasTouch: true,
      })
      const page = await context.newPage()
      await page.goto(`${base}/zh/console/collab?remote=1#pair=${token}`)
      await page.locator('a[data-ticket]').first().waitFor({ timeout: 20_000 })
      for (const filter of ['active', 'all']) {
        await page.locator(`[role=radio][data-value=${filter}]`).click()
        const past = await page.evaluate(() =>
          [...document.querySelectorAll('main *')]
            .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
            // the sticky bar itself bleeds into the page gutters on purpose;
            // what it holds must fit
            .filter((el) => !el.matches('.sticky'))
            .map((el) => `${el.tagName}.${String(el.className).slice(0, 60)}`)
            .slice(0, 3),
        )
        expect(past, `${width}px, ${filter}`).toEqual([])
      }
      await context.close()
    }
  })
})
