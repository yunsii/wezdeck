// covers: web/src/features/pwa-boot.tsx web/src/lib/host-diag.ts
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// A release reloads open pages onto the new build (`wezdeck-wsl diag
// --reload`, host-diag.ts): no toast before the reload any more (it
// vanished half-read); the new page says 已更新到新版本 once.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Reloaded onto a new build', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('says it once on the new page, not for the same build', async () => {
    const context = await browser.newContext({ locale: 'zh-CN' })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me`)
    await page.locator('#console-main').waitFor({ timeout: 20_000 })
    const toast = page.getByText('已更新到新版本')
    // reloaded from an older build: announced, then forgotten
    await page.evaluate(() =>
      sessionStorage.setItem('wezdeck.updated-from', 'older-build'),
    )
    await page.reload()
    await toast.waitFor({ timeout: 10_000 })
    expect(
      await page.evaluate(() => sessionStorage.getItem('wezdeck.updated-from')),
    ).toBeNull()
    // a plain reload says nothing
    await page.reload()
    await page.locator('#console-main').waitFor({ timeout: 20_000 })
    await page.waitForTimeout(1_000)
    expect(await toast.count()).toBe(0)
    await context.close()
  })
})
