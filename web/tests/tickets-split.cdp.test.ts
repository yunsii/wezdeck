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
          .getByText(now ?? '')
          .count(),
      )
      .toBeGreaterThan(0)
    await context.close()
  })
})
