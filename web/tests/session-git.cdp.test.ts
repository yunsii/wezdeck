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
    // nothing to commit reads as a word, not a lone ✓
    expect(
      (await page.getByTestId('git-clean-tags').innerText()).replace(
        /\s+/g,
        ' ',
      ),
    ).toContain('已同步 无改动')
    // the header's tag is a button: it opens the sheet
    const tag = page.getByTestId('git-status-button')
    await tag.waitFor({ timeout: 20_000 })
    expect(await tag.innerText()).toBe('+1 ~2 ?3 ↑2 ↓1')
    await tag.click()
    await page.getByTestId('git-sheet').waitFor({ timeout: 5_000 })
    const detail = page.getByTestId('git-detail')
    await detail.waitFor({ timeout: 20_000 })
    const text = (await detail.innerText()).replace(/\s+/g, ' ')
    expect(text).toContain('master → origin/master')
    expect(text).toContain('已暂存 1 个，已修改 2 个，未跟踪 3 个')
    expect(text).toContain('有 2 个提交待推送，1 个待拉取')
    // changes first (there are some): files by state, commits a tab away
    expect(await detail.getAttribute('data-tab')).toBe('changes')
    for (const [group, n] of [
      ['staged', 1],
      ['modified', 2],
      ['untracked', 3],
    ] as const)
      expect(
        await detail.locator(`[data-git-group=${group}] li`).count(),
        group,
      ).toBe(n)
    expect(text).toContain('已修改 · 2')
    expect(text).toContain('变更6')
    expect(text).toContain('提交↑2 ↓1')
    expect(await detail.locator('[data-git-commits]').count()).toBe(0)
    // → switches to 提交: not pushed / not pulled first, then recent; the
    // tab body keeps its height (the sheet holds still)
    const body = page.getByTestId('git-tab-body')
    const before = (await body.boundingBox())?.height
    await detail.locator('[role=radio][data-value=changes]').focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => detail.getAttribute('data-tab')).toBe('commits')
    const after = (await body.boundingBox())?.height ?? 0
    expect(Math.abs(after - (before ?? 0))).toBeLessThan(1)
    const order = await detail
      .locator('[data-git-commits]')
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-git-commits')),
      )
    expect(order).toEqual(['ahead', 'behind', 'recent'])
    const commits = (await detail.innerText()).replace(/\s+/g, ' ')
    expect(commits).toContain('未推送 · 2')
    expect(commits).toContain('未拉取 · 1')
    expect(commits).toContain('最近提交 · 3')
    await page.keyboard.press('Escape')
    await page.getByTestId('git-sheet').waitFor({ state: 'hidden' })
    await context.close()
  })

  it('wide: the list never runs over the detail', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#claude-ask-review`)
    const detail = page.getByTestId('interaction-detail')
    await detail.waitFor({ timeout: 20_000 })
    const [list, box] = await Promise.all([
      page.locator('nav[aria-label=交互列表]').boundingBox(),
      detail.boundingBox(),
    ])
    expect(list && box && list.x + list.width <= box.x).toBe(true)
    // every row's tag stays inside the list
    const overflow = await page
      .locator('nav[aria-label=交互列表] button[data-interaction]')
      .evaluateAll((rows) =>
        rows.some((row) => row.scrollWidth > row.clientWidth + 1),
      )
    expect(overflow).toBe(false)
    await context.close()
  })
})
