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
    // two lines, one row each: the agent, then the checkout
    const rowsOf = (testId: string) =>
      page.getByTestId(testId).evaluate((el) => {
        const box = el.getBoundingClientRect()
        const tops = [...el.querySelectorAll<HTMLElement>('.session-tag')]
          .map((t) => t.getBoundingClientRect())
          .filter((r) => r.bottom <= box.bottom + 1)
          .map((r) => r.top)
          .sort((a, b) => a - b)
        return tops.filter((top, k) => k === 0 || top - (tops[k - 1] ?? 0) > 6)
          .length
      })
    expect(await rowsOf('statusbar-agent')).toBe(1)
    expect(await rowsOf('statusbar-custom')).toBe(1)
    const agent = (
      await page.getByTestId('statusbar-agent').innerText()
    ).replace(/\s+/g, ' ')
    expect(agent).toContain('Opus 5.5')
    // background tasks by kind: a Bash (shell) and a Monitor
    expect(agent).toContain('shell 1')
    expect(agent).toContain('monitor 1')
    const all = (await bar.innerText()).replace(/\s+/g, ' ')
    // ctx and limits live in the header (only near full); no mode, no node
    expect(all).not.toContain('ctx')
    expect(all).not.toContain('auto')
    const opensUp = async (testId: string, list: string) => {
      const button = page.getByTestId(testId)
      if (!(await button.first().isVisible())) {
        // folded away: it lives in the +N panel
        await page
          .getByTestId(
            `${testId === 'status-worktrees' ? 'statusbar-custom' : 'statusbar-agent'}-more`,
          )
          .click()
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
    await opensUp('status-shell', 'background-tasks')
    await opensUp('status-monitor', 'background-tasks')
    expect(await page.getByTestId('status-worktree-list').count()).toBe(0)
    await context.close()
  })

  it(
    'churning git counts move neither the bar nor the composer',
    { timeout: 60_000 },
    async () => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        locale: 'zh-CN',
      })
      const page = await context.newPage()
      await page.goto(`${base}/zh/console/me/interactions#git-churn`)
      const demo = page.getByTestId('git-churn')
      await demo.waitFor({ timeout: 20_000 })
      await page.waitForTimeout(600)
      // 2 s of frames: the git tag's width and the bar's height hold
      const frames = await demo.evaluate(
        (root) =>
          new Promise<Array<{ git: number; bar: number }>>((done) => {
            const out: Array<{ git: number; bar: number }> = []
            const begin = performance.now()
            const tick = (now: number) => {
              const git = root.querySelector('[data-testid=git-fixed]')
              const bar = root.querySelector('[data-testid=session-statusbar]')
              if (git && bar)
                out.push({
                  git: Math.round(git.getBoundingClientRect().width),
                  bar: Math.round(bar.getBoundingClientRect().height),
                })
              if (now - begin < 2_000) requestAnimationFrame(tick)
              else done(out)
            }
            requestAnimationFrame(tick)
          }),
      )
      expect(frames.length).toBeGreaterThan(20)
      expect(new Set(frames.map((f) => f.git)).size, 'git tag width').toBe(1)
      expect(new Set(frames.map((f) => f.bar)).size, 'bar height').toBe(1)
      await context.close()
    },
  )
})
