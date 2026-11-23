// covers: web/src/features/console-interactions.tsx
// covers: web/src/features/session-permission.tsx
// covers: web/src/features/session-elicitation.tsx
// covers: web/src/features/session-ask-claude.tsx
// covers: web/src/features/console-me.tsx
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 交互调试 (我的 › 交互调试, /console/me/interactions): every
// special interaction rendered from sample data; taps only go to the key
// log, nothing reaches a pane, so no stack state is needed.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Interaction debugging page', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  const IDS = [
    'claude-ask',
    'claude-ask-review',
    'grok-ask',
    'permission-bash',
    'permission-edit',
    'plan-approval',
    'grok-plan',
    'generic-keys',
    'progress',
    'compaction',
    'slash',
    'diff',
  ]

  it('wide: a 我的 page, list beside detail, taps land in the log', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions`)
    const detail = page.getByTestId('interaction-detail')
    await detail.waitFor({ timeout: 20_000 })
    // it belongs to 我的, not to 工单 (the shell's fallback section)
    expect(await page.locator('[data-me-page=interactions]').count()).toBe(1)
    await expect
      .poll(() =>
        page.locator('nav a[aria-current=page]').first().textContent(),
      )
      .toContain('我的')
    for (const id of IDS)
      expect(
        await page.locator(`button[data-interaction=${id}]`).count(),
        id,
      ).toBe(1)
    expect(await detail.getAttribute('data-interaction')).toBe('claude-ask')
    // a click before hydration does nothing: retry until the detail moves
    const item = page.locator('button[data-interaction=permission-bash]')
    await expect
      .poll(async () => {
        await item.click()
        return detail.getAttribute('data-interaction')
      })
      .toBe('permission-bash')
    await detail.getByRole('button', { name: '允许' }).click()
    await expect
      .poll(() => page.getByTestId('interaction-log').textContent())
      .toContain('permission-bash → 1')
    // the selection is in the hash: a link opens that one
    expect(page.url()).toContain('#permission-bash')
    await page.goto(`${base}/zh/console/me/interactions#plan-approval`)
    await expect
      .poll(() =>
        page.getByTestId('interaction-detail').getAttribute('data-interaction'),
      )
      .toBe('plan-approval')
    await context.close()
  })

  it('phone: the list first, an item opens, back returns to the list', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions`)
    const item = page.locator('button[data-interaction=grok-plan]')
    await item.waitFor({ timeout: 20_000 })
    expect(await page.getByTestId('interaction-detail').count()).toBe(0)
    await expect
      .poll(async () => {
        await item.click().catch(() => {})
        return page.getByTestId('interaction-detail').count()
      })
      .toBe(1)
    // the system back returns to the list, still on 交互调试
    await page.goBack()
    await expect
      .poll(() => page.getByTestId('interaction-detail').count())
      .toBe(0)
    expect(await page.locator('[data-me-page=interactions]').count()).toBe(1)
    // and so does the header's back arrow
    await item.click()
    await page.getByTestId('interaction-detail').waitFor()
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect
      .poll(() => page.getByTestId('interaction-detail').count())
      .toBe(0)
    expect(await page.locator('[data-me-page=interactions]').count()).toBe(1)
    await context.close()
  })
})
