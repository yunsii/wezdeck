// covers: web/src/features/device-state.ts
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// A browser on the host that asked while the local Runtime was down (it
// restarts on a runtime sync) took the remote path and kept showing
// 这台设备还没获批 until reloaded (2026-11-25). While not approved the page
// looks for the Runtime again, so it turns into 本机已启用 once it is back.
// The Runtime here is a stand-in: page.route answers 127.0.0.1:35791 — down
// first, then healthy with remote.write — and refuses everything else, so
// the real Runtime on the machine is never read.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Device access on the host', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('turns approved once the local Runtime is back', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    })
    let up = false
    await context.route('http://127.0.0.1:35791/**', async (route) => {
      const url = new URL(route.request().url())
      if (!up || url.pathname !== '/api/v1/health') return route.abort()
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          api_version: '1',
          instance_id: 'stand-in',
          ready: true,
          capabilities: ['remote.read', 'remote.write'],
          observed_at: new Date().toISOString(),
        }),
      })
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/writing`)
    const enabled = page.getByText('本机已启用')
    // the Runtime is down: not approved on this computer
    await page.getByRole('button', { name: '申请授权' }).waitFor({
      timeout: 20_000,
    })
    expect(await enabled.count()).toBe(0)
    // back: within one recheck (10 s) plus the probe cache (15 s)
    up = true
    await enabled.waitFor({ timeout: 30_000 })
    await context.close()
  }, 60_000)
})
