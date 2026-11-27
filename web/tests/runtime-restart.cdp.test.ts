// covers: web/src/features/runtime-restart.ts web/src/features/console-data.tsx
// covers: web/src/features/console-shell.tsx
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The local Runtime restarting under an open page (2026-11-25: a runtime
// sync took it down for 68 s) left no trace once it was back: while gone the
// band kept the last sample's 就绪 (or the page dropped to the remote mode),
// afterwards nothing said it happened. Now a missed Runtime reads 离线, a
// new instance_id brings a toast with how long it was gone, and a Runtime
// younger than 5 minutes is marked 刚重启. The Runtime is a stand-in
// (page.route answers 127.0.0.1:35791 health; everything else is refused).
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Local Runtime restart in the status band', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('says it restarted, how long it was gone, and marks it', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    })
    let runtime: { instance: string; uptime: number } | null = {
      instance: 'first',
      uptime: 3_600_000,
    }
    let failedReads = 0
    await context.route('http://127.0.0.1:35791/**', async (route) => {
      const url = new URL(route.request().url())
      if (!runtime || url.pathname !== '/api/v1/health') {
        if (!runtime && url.pathname === '/api/v1/health') failedReads += 1
        return route.abort()
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          api_version: '1',
          instance_id: runtime.instance,
          ready: true,
          uptime_ms: runtime.uptime,
          capabilities: [],
          observed_at: new Date().toISOString(),
        }),
      })
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/sessions`)
    const band = page.getByText('运行时长').locator('..')
    const recent = page.getByTestId('runtime-recent-start')
    await expect
      .poll(async () => (await band.innerText()).includes('1h'), {
        timeout: 20_000,
      })
      .toBe(true)
    expect(await recent.count()).toBe(0)

    // it goes away: wait for the missed health polls before bringing it back
    runtime = null
    await expect
      .poll(() => failedReads, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(3)

    // a new one: a toast with how long it was gone, and 刚重启
    runtime = { instance: 'second', uptime: 2_000 }
    await page
      .getByText(/本地运行时刚重启过（断开约 \d+ 秒）/)
      .waitFor({ timeout: 30_000 })
    await recent.waitFor({ timeout: 5_000 })
    expect(await recent.innerText()).toBe('刚重启')
    await context.close()
  }, 90_000)
})
