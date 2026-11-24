// covers: web/src/features/session-git.tsx
// covers: web/src/components/deck/session-tags.tsx
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The git tag opened (交互调试 › git 状态面板, sample data): one sentence
// says what the counts mean, then files by state and the commit lists.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Git status panel', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('explains the counts and lists files and commits', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#git-status`)
    const detail = page.getByTestId('git-detail')
    await detail.waitFor({ timeout: 20_000 })
    const text = (await detail.innerText()).replace(/\s+/g, ' ')
    expect(text).toContain('master → origin/master')
    expect(text).toContain('已暂存 1 个，已修改 2 个，未跟踪 3 个')
    expect(text).toContain('有 2 个提交待推送，1 个待拉取')
    for (const [group, n] of [
      ['staged', 1],
      ['modified', 2],
      ['untracked', 3],
    ] as const)
      expect(
        await detail.locator(`[data-git-group=${group}] li`).count(),
        group,
      ).toBe(n)
    expect(text).toContain('未推送 · 2')
    expect(text).toContain('未拉取 · 1')
    expect(text).toContain('最近提交 · 3')
    await context.close()
  })
})
