// covers: web/src/lib/local-events.ts web/src/lib/client-trace.ts
// covers: web/src/lib/runtime-client.ts
import { chromium } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser } from '@playwright/test'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const runtime = 'http://127.0.0.1:35791'

describe('local Web events', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('batches safe events locally and sends none in forced remote mode', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const batches: Array<{
      events: Array<{ kind: string; data: Record<string, unknown> }>
    }> = []
    await page.route(`${runtime}/**`, async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const headers = {
        'access-control-allow-origin': base,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-private-network': 'true',
      }
      if (request.method() === 'OPTIONS')
        return route.fulfill({ status: 204, headers })
      if (path === '/api/v1/health')
        return route.fulfill({
          headers,
          contentType: 'application/json',
          body: JSON.stringify({
            api_version: 'v1',
            instance_id: 'test',
            ready: true,
            capabilities: ['web.events', 'remote.read', 'remote.write'],
            observed_at: new Date().toISOString(),
          }),
        })
      if (path === '/api/v1/web-events') {
        batches.push(request.postDataJSON())
        return route.fulfill({
          headers,
          contentType: 'application/json',
          body: '{"accepted":1}',
        })
      }
      return route.fulfill({
        status: 404,
        headers,
        contentType: 'application/json',
        body: '{}',
      })
    })
    await page.goto(`${base}/zh/console/me`)
    await page.evaluate(() =>
      window.dispatchEvent(
        new ErrorEvent('error', { message: 'private payload' }),
      ),
    )
    await expect
      .poll(
        () =>
          batches.some((batch) =>
            batch.events.some((event) => event.kind === 'boot'),
          ),
        { timeout: 12_000 },
      )
      .toBe(true)
    expect(JSON.stringify(batches)).not.toContain('private payload')

    batches.length = 0
    await page.goto(`${base}/zh/console/me?remote=1`)
    await page.waitForTimeout(3_500)
    expect(batches).toHaveLength(0)
    await context.close()
  })
})
