// covers: web/src/components/deck/session-tags.tsx web/src/styles/deck.css
// covers: web/src/features/session-header.tsx web/src/features/session-list.tsx
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Session tags (交互调试 › 会话标签): the list row and the header render the
// same tag line — it wraps, the agent tag is never squeezed, a long branch
// takes at most one whole line, and a neutral tag keeps its fill on the
// header's deck as on the row's surface.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Session tags', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('same tag line in the list and the header, long branch on its own line', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
      colorScheme: 'dark',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#session-tags`)
    await page.getByTestId('tags-head').waitFor({ timeout: 20_000 })
    for (const id of ['tags-list', 'tags-head']) {
      const line = await page.getByTestId(id).evaluate((el) => {
        const tags = [...el.querySelectorAll<HTMLElement>('.session-tag')]
        const agent = tags.find((t) => t.dataset.tone === 'claude')!
        const branch = tags.find((t) => t.textContent.startsWith('feat/'))!
        const width = el.getBoundingClientRect().width
        return {
          wraps: getComputedStyle(el).flexWrap,
          // the agent tag shows its whole name
          agentWhole: agent.scrollWidth <= agent.clientWidth + 1,
          // the branch fills at most the line
          branchFits: branch.getBoundingClientRect().width <= width + 1,
          branchFill: getComputedStyle(branch).backgroundColor,
        }
      })
      expect(line.wraps, id).toBe('wrap')
      expect(line.agentWhole, id).toBe(true)
      expect(line.branchFits, id).toBe(true)
      // a visible fill, not transparent, on both grounds
      expect(line.branchFill, id).not.toBe('rgba(0, 0, 0, 0)')
    }
    await context.close()
  })

  it('one line first: a long branch truncates beside the others, wraps only when cramped', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#session-tags`)
    const head = page.getByTestId('tags-head')
    await head.waitFor({ timeout: 20_000 })
    const layout = (width?: number) =>
      head.evaluate((el, w) => {
        if (w) el.style.width = `${w}px`
        const tags = [...el.querySelectorAll<HTMLElement>('.session-tag')]
        const tops = tags.map((t) => Math.round(t.getBoundingClientRect().top))
        const branch = tags.find((t) => t.textContent.startsWith('feat/'))!
        const text = branch.querySelector('span:last-child')!
        return {
          lines: new Set(tops).size,
          truncated: text.scrollWidth > text.clientWidth,
          branch: branch.getBoundingClientRect().width,
          line: el.getBoundingClientRect().width,
          others: tags
            .filter((t) => t !== branch)
            .every((t) => t.scrollWidth <= t.clientWidth + 1),
        }
      }, width)
    // phone width: agent, branch and git status share one line
    const wide = await layout()
    expect(wide.lines).toBe(1)
    expect(wide.truncated).toBe(true)
    expect(wide.others).toBe(true)
    // too little room for the branch: it takes a line of its own, at most
    const narrow = await layout(200)
    expect(narrow.lines).toBeGreaterThan(1)
    expect(narrow.branch).toBeLessThanOrEqual(narrow.line + 1)
    expect(narrow.others).toBe(true)
    // a truncated tag shows its text in a tip: nothing in the line moves
    await head.evaluate((el) => el.style.removeProperty('width'))
    const lineHeight = async () => (await head.boundingBox())?.height ?? 0
    const before = await lineHeight()
    await head.locator('button.session-tag').first().click()
    const tip = page.getByTestId('tag-tip')
    await tip.waitFor({ timeout: 3_000 })
    expect(await tip.innerText()).toContain('long-branch-name')
    expect(Math.abs((await lineHeight()) - before)).toBeLessThan(1)
    // the tip's focus guards are no row of their own: no +N appears
    await page.waitForTimeout(200)
    expect(await head.getAttribute('data-folded')).toBe(null)
    await page.keyboard.press('Escape')
    await tip.waitFor({ state: 'hidden' })
    // even on two full rows (the limit), opening a tip folds nothing
    await head.evaluate((el) => {
      el.style.width = '240px'
    })
    await expect
      .poll(() =>
        head.evaluate(
          (el) =>
            new Set(
              [...el.querySelectorAll('.session-tag')].map((t) =>
                Math.round(t.getBoundingClientRect().top),
              ),
            ).size,
        ),
      )
      .toBe(2)
    await head.locator('button.session-tag').first().click()
    await tip.waitFor({ timeout: 3_000 })
    await page.waitForTimeout(200)
    expect(await head.getAttribute('data-folded')).toBe(null)
    await page.keyboard.press('Escape')
    await tip.waitFor({ state: 'hidden' })
    // the list row (a link) has no tag buttons
    expect(await page.getByTestId('tags-list').locator('button').count()).toBe(
      0,
    )
    await context.close()
  })

  it('the header keeps two lines, the rest behind +N; 会话信息 has no limit', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#session-tags`)
    const crowded = page.getByTestId('tags-crowded')
    await crowded.waitFor({ timeout: 20_000 })
    const rows = (testId: string) =>
      page.getByTestId(testId).evaluate((el) => {
        const box = el.getBoundingClientRect()
        // rows that show (inside the line's clip)
        const tops = [...el.querySelectorAll<HTMLElement>('.session-tag')]
          .map((t) => t.getBoundingClientRect())
          .filter((r) => r.bottom <= box.bottom + 1)
          .map((r) => Math.round(r.top))
        return new Set(tops).size
      })
    await expect
      .poll(() => crowded.getAttribute('data-folded'))
      .toMatch(/^\d+$/)
    expect(await rows('tags-crowded')).toBeLessThanOrEqual(2)
    const height = (await crowded.boundingBox())?.height ?? 0
    const more = page.getByTestId('tags-crowded-more')
    await more.click()
    const panel = page.getByTestId('tags-crowded-panel')
    await panel.waitFor({ timeout: 3_000 })
    // only the folded tags in the panel (the rest is in view), the line
    // itself unchanged
    expect(await panel.locator('.session-tag').count()).toBe(
      Number(await crowded.getAttribute('data-folded')),
    )
    expect(await panel.innerText()).not.toContain('claude')
    expect(
      Math.abs(((await crowded.boundingBox())?.height ?? 0) - height),
    ).toBeLessThan(1)
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached' })
    // 会话信息: no fold
    expect(
      await page.getByTestId('tags-info').getAttribute('data-folded'),
    ).toBe(null)
    await context.close()
  })
})
