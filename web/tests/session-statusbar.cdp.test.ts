// covers: web/src/features/session-statusbar.tsx web/src/features/session-usage.tsx
// covers: web/src/features/session-header.tsx web/src/features/console-sessions.tsx
// covers: web/src/features/session-worktree-manager.tsx
// covers: web/src/features/console-interactions-demos.tsx
import { chromium } from '@playwright/test'
import type { Browser, Locator, Page } from '@playwright/test'
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
    expect(all).not.toContain('auto')
    const worktrees = page.getByTestId('status-worktrees')
    if (
      !(await worktrees.first().isVisible()) ||
      (await worktrees.first().getAttribute('inert')) !== null
    ) {
      await page.getByTestId('statusbar-custom-more').click()
    }
    await worktrees.last().click()
    const sheet = page.getByTestId('worktree-manager')
    await sheet.waitFor()
    await sheet.getByTestId('status-worktree-list').waitFor()
    expect(await sheet.getByRole('alert').count()).toBe(0)
    expect(await sheet.getByText('Agent 工具与注意力').count()).toBe(1)
    const sheetBox = await sheet.boundingBox()
    expect((sheetBox?.y ?? 0) + (sheetBox?.height ?? 0)).toBeGreaterThan(840)
    expect(await sheet.getByRole('button', { name: '复制路径' }).count()).toBe(
      3,
    )
    await checkCopyPath(page, sheet)
    if (process.env.WEZDECK_VISUAL_SHOTS) await captureThemePair(page, 'phone')
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'hidden' })
    await page.keyboard.press('Escape')
    const opensUp = async (testId: string, list: string) => {
      const button = page.getByTestId(testId)
      if (
        !(await button.first().isVisible()) ||
        (await button.first().getAttribute('inert')) !== null
      ) {
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
    await opensUp('status-shell', 'background-tasks')
    await opensUp('status-monitor', 'background-tasks')
    expect(await page.getByTestId('worktree-manager').count()).toBe(0)
    await context.close()
  })

  it('opens the worktree overview as one anchored list on wide screens', async () => {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 850 },
      locale: 'zh-CN',
    })
    try {
      await page.goto(`${base}/zh/console/me/interactions#status-bar`)
      const button = page.getByTestId('status-worktrees')
      await button.waitFor()
      if ((await button.getAttribute('inert')) !== null)
        await page.getByTestId('statusbar-custom-more').click()
      await button.last().click()
      const panel = page.getByTestId('worktree-manager')
      await panel.waitFor()
      await expect
        .poll(() => panel.evaluate((el) => getComputedStyle(el).opacity))
        .toBe('1')
      expect(await panel.getAttribute('data-slot')).toBe('popover-content')
      expect(await panel.getByRole('alert').count()).toBe(0)
      expect(
        await panel.getByTestId('status-worktree-list').locator('li').count(),
      ).toBe(3)
      if (process.env.WEZDECK_VISUAL_SHOTS)
        await captureThemePair(page, 'desktop')
      await page.keyboard.press('Escape')
      await panel.waitFor({ state: 'hidden' })
    } finally {
      await page.close()
    }
  })

  it('shows a folded quota alert in the header and clears it when the tag fits', async () => {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 850 },
    })
    try {
      await page.goto(`${base}/console/me/interactions#status-bar`)
      const row = page.getByTestId('statusbar-agent')
      const alert = page.getByTestId('session-usage')
      const quota = row.locator('[data-tag-id="seven-day"]')
      const bar = page.getByTestId('session-statusbar')
      await bar.evaluate((el) => {
        el.style.width = '550px'
      })
      await expect.poll(() => quota.getAttribute('inert')).toBeNull()
      await alert.waitFor({ state: 'detached' })
      expect(await row.locator('[data-tag-id]:not([inert])').count()).toBe(3)
      await bar.evaluate((el) => {
        el.style.width = '235px'
      })
      await alert.waitFor()
      expect(await alert.innerText()).toContain('83%')
      expect(await quota.getAttribute('inert')).not.toBeNull()
      const more = page.getByTestId('statusbar-agent-more')
      await more.focus()
      await page.keyboard.press('Enter')
      const panel = page.getByTestId('statusbar-agent-panel')
      await panel.locator('[data-tag-id="seven-day"]').click()
      await page.getByText('7 d 83% used', { exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await bar.evaluate((el) => {
        el.style.width = '550px'
      })
      await alert.waitFor({ state: 'detached' })
      expect(await quota.getAttribute('inert')).toBeNull()
    } finally {
      await page.close()
    }
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
      // a clean tree (every few ticks): no segment dimmed on the green fill
      await page.waitForFunction(
        () => {
          const git = document.querySelector('[data-testid=git-fixed]')
          return git?.getAttribute('data-tone') === 'done'
        },
        null,
        { timeout: 5_000, polling: 'raf' },
      )
      const dimmed = await page
        .getByTestId('git-fixed')
        .evaluate((el) =>
          [...el.children].some((s) => getComputedStyle(s).opacity !== '1'),
        )
      expect(dimmed).toBe(false)
      await context.close()
    },
  )
})

async function checkCopyPath(page: Page, sheet: Locator) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const firstRow = sheet
    .getByTestId('status-worktree-list')
    .locator('li')
    .first()
  const path = await firstRow
    .locator('p[title^="/"]')
    .last()
    .getAttribute('title')
  await firstRow.getByRole('button', { name: '复制路径' }).click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(path)
}

async function captureThemePair(page: Page, viewport: 'phone' | 'desktop') {
  const original = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  )
  await page.screenshot({ path: `/tmp/wezdeck-worktrees-${viewport}.png` })
  await page.evaluate(() =>
    document.documentElement.setAttribute('data-theme', 'dark'),
  )
  await page.screenshot({ path: `/tmp/wezdeck-worktrees-${viewport}-dark.png` })
  await page.evaluate((theme) => {
    if (theme === null) document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
  }, original)
}
