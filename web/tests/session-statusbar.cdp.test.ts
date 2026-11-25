// covers: web/src/features/session-statusbar.tsx
// covers: web/src/features/session-header.tsx web/src/features/console-sessions.tsx
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The status bar under the composer (交互调试 › 底部状态栏): one line like
// the terminal's; worktrees and background tasks open upward.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Status bar', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('one line; worktrees and background tasks open upward', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
      hasTouch: true,
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#status-bar`)
    const bar = page.getByTestId('session-statusbar')
    await bar.waitFor({ timeout: 20_000 })
    // the rows that show (inside the line's clip)
    const rows = await bar.evaluate((el) => {
      const box = el.getBoundingClientRect()
      return new Set(
        [...el.querySelectorAll<HTMLElement>('.session-tag')]
          .map((t) => t.getBoundingClientRect())
          .filter((r) => r.bottom <= box.bottom + 1)
          .map((r) => Math.round(r.top)),
      ).size
    })
    expect(rows).toBe(1)
    const opensUp = async (testId: string, list: string) => {
      const button = page.getByTestId(testId)
      if (!(await button.isVisible())) {
        // folded away: it lives in the +N panel
        await page.getByTestId('session-statusbar-more').click()
      }
      const top = (await page.getByTestId(testId).last().boundingBox())?.y ?? 0
      await page.getByTestId(testId).last().click()
      const popup = page.getByTestId(list)
      await popup.waitFor({ timeout: 3_000 })
      const box = await popup.boundingBox()
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(top + 1)
      await page.keyboard.press('Escape')
      await popup.waitFor({ state: 'hidden' })
      await page.keyboard.press('Escape')
    }
    await opensUp('status-worktrees', 'status-worktree-list')
    await opensUp('status-background', 'background-tasks')
    expect(await page.getByTestId('status-worktree-list').count()).toBe(0)
    await context.close()
  })
})
