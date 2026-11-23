import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 交互调试 (/console/interactions, features/console-interactions.tsx): every
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

  it('renders each interaction; taps land in the log', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/interactions`)
    const log = page.getByTestId('interaction-log')
    await log.waitFor({ timeout: 20_000 })
    for (const id of [
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
    ])
      expect(await page.locator(`section#${id}`).count(), id).toBe(1)
    expect(await page.getByTestId('permission-card').count()).toBe(3)
    // clicks only after hydration take effect: retry until the log moves
    const allow = page
      .locator('section#permission-bash')
      .getByRole('button', { name: '允许' })
    await expect
      .poll(async () => {
        await allow.click()
        return log.textContent()
      })
      .toContain('permission-bash → 1')
    await page
      .locator('section#plan-approval')
      .getByRole('button', { name: '继续规划' })
      .click()
    await expect
      .poll(() => log.textContent())
      .toContain('plan-approval → Escape')
    await context.close()
  })
})
