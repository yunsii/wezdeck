// covers: web/src/features/foreground-sync.tsx web/src/features/console-shell.tsx
import { chromium, devices } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'

describe('foreground sync status', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('keeps the old time through an offline wake and recovers online', async () => {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/sessions?remote=1#pair=${token}`)
    const status = page.getByTestId('foreground-sync')
    await expect
      .poll(() => status.getAttribute('data-state'), { timeout: 20_000 })
      .toBe('synced')
    const first = await status.innerText()
    expect(first).toMatch(/已同步 \d{2}:\d{2}/)
    const mobileGap = await page.evaluate(() => {
      const line = document.querySelector('[data-testid=foreground-sync]')!
      const tabs = document.querySelector('nav.tabbar-vt')!
      return (
        tabs.getBoundingClientRect().top - line.getBoundingClientRect().bottom
      )
    })
    expect(mobileGap).toBeGreaterThanOrEqual(0)

    await context.setOffline(true)
    await page.evaluate(() =>
      document.dispatchEvent(new Event('visibilitychange')),
    )
    await expect.poll(() => status.getAttribute('data-state')).toBe('failed')
    expect(await status.innerText()).toContain('上次成功')

    await context.setOffline(false)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect
      .poll(() => status.getAttribute('data-state'), { timeout: 20_000 })
      .toBe('synced')
    await context.close()

    const desktop = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      locale: 'zh-CN',
    })
    const wide = await desktop.newPage()
    await wide.goto(`${base}/zh/console/sessions?remote=1#pair=${token}`)
    const desktopGap = await wide.evaluate(() => {
      const line = document.querySelector('[data-testid=foreground-sync]')!
      const shell = document.querySelector('main[data-deck]')!
      return (
        shell.getBoundingClientRect().bottom -
        line.getBoundingClientRect().bottom
      )
    })
    expect(desktopGap).toBeGreaterThanOrEqual(0)
    await desktop.close()
  }, 45_000)
})
