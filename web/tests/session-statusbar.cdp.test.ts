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
    // rows that show (inside each line's clip), a few px of slack
    const rows = (testId: string) =>
      page.getByTestId(testId).evaluate((el) => {
        const box = el.getBoundingClientRect()
        const tops = [...el.querySelectorAll<HTMLElement>('.session-tag')]
          .map((t) => t.getBoundingClientRect())
          .filter((r) => r.bottom <= box.bottom + 1)
          .map((r) => r.top)
          .sort((a, b) => a - b)
        return tops.filter((top, k) => k === 0 || top - tops[k - 1] > 6).length
      })
    expect(await rows('statusbar-agent')).toBeLessThanOrEqual(2)
    expect(await rows('statusbar-custom')).toBeLessThanOrEqual(2)
    const agentText = (
      await page.getByTestId('statusbar-agent').innerText()
    ).replace(/\s+/g, ' ')
    expect(agentText).toContain('Opus 5.5')
    expect(agentText).toContain('ctx 52%')
    expect(agentText).toContain('7d 47%')
    // 5h stays hidden until it is close to full (23% here)
    expect(agentText).not.toContain('5h')
    expect(agentText).toContain('auto')
    const opensUp = async (testId: string, list: string) => {
      const button = page.getByTestId(testId)
      if (!(await button.first().isVisible())) {
        // folded away: it lives in the +N panel
        await page.getByTestId('statusbar-agent-more').click()
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
    await opensUp('status-context', 'status-context-detail')
    await opensUp('status-worktrees', 'status-worktree-list')
    await opensUp('status-background', 'background-tasks')
    expect(await page.getByTestId('status-worktree-list').count()).toBe(0)
    await context.close()
  })
})
