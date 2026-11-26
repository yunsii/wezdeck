// covers: web/src/features/pwa-boot.tsx web/src/lib/host-diag.ts
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// A release reloads open pages onto the new build (`wezdeck-wsl diag
// --reload`, host-diag.ts): a short pre-reload toast carries `--reason`;
// the new page says 已更新到新版本 once, with the same reason as description.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Reloaded onto a new build', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('says it once on the new page, with the host reason', async () => {
    const context = await browser.newContext({ locale: 'zh-CN' })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me`)
    await page.locator('#console-main').waitFor({ timeout: 20_000 })
    const toast = page.getByText('已更新到新版本')
    // reloaded from an older build: announced, then forgotten
    await page.evaluate(() => {
      sessionStorage.setItem('wezdeck.updated-from', 'older-build')
      sessionStorage.setItem('wezdeck.updated-reason', '发布网页 abc123')
    })
    await page.reload()
    await toast.waitFor({ timeout: 10_000 })
    await page.getByText('发布网页 abc123').waitFor({ timeout: 5_000 })
    expect(
      await page.evaluate(() => ({
        from: sessionStorage.getItem('wezdeck.updated-from'),
        reason: sessionStorage.getItem('wezdeck.updated-reason'),
      })),
    ).toEqual({ from: null, reason: null })
    // a plain reload says nothing
    await page.reload()
    await page.locator('#console-main').waitFor({ timeout: 20_000 })
    await page.waitForTimeout(1_000)
    expect(await toast.count()).toBe(0)
    await context.close()
  })
})
