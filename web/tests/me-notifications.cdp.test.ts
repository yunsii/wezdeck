// covers: web/src/features/me-notifications.tsx web/src/lib/push-client.ts
// covers: web/src/relay/relay-fetch.ts web/src/relay/host-push.ts
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const stack = process.env.WEZDECK_TEST_STACK_DIR ?? ''
const room = process.env.WEZDECK_REMOTE_ROOM ?? ''
const roomQuery = room ? `&room=${room}` : ''

describe.runIf(stack)('Me › Notifications & /relay/push/* endpoints', () => {
  let browser: Browser | undefined

  beforeAll(async () => {
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('gates /relay/push/* with Bearer token, supports subscribe/prefs/unsubscribe, and renders Notifications settings', async () => {
    // 1. Unauthenticated probe is rejected
    const unauth = await fetch(`${base}/relay/push/config`)
    expect(unauth.status).toBe(401)

    const authHeaders = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    }
    const devId = `cdp-push-${Date.now().toString(36)}`

    // 2. Subscribe → status → update prefs → unsubscribe lifecycle on DO storage
    const subRes = await fetch(
      `${base}/relay/push/subscribe${room ? `?room=${room}` : ''}`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          device_id: devId,
          subscription: {
            endpoint: 'https://push.example.com/sub/cdp-test',
            keys: { p256dh: 'BTestPubKey', auth: 'TestAuthSecret' },
          },
          prefs: { session_done: true, session_done_min_s: 180 },
        }),
      },
    )
    expect(subRes.status).toBe(200)

    const statusRes = await fetch(
      `${base}/relay/push/status?device_id=${encodeURIComponent(devId)}${roomQuery}`,
      { headers: authHeaders },
    )
    expect(statusRes.status).toBe(200)
    const statusJson = (await statusRes.json()) as {
      subscribed: boolean
      prefs: { session_done: boolean; session_done_min_s: number }
    }
    expect(statusJson.subscribed).toBe(true)
    expect(statusJson.prefs.session_done).toBe(true)
    expect(statusJson.prefs.session_done_min_s).toBe(180)

    const unsubRes = await fetch(
      `${base}/relay/push/unsubscribe${room ? `?room=${room}` : ''}`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ device_id: devId }),
      },
    )
    expect(unsubRes.status).toBe(200)

    // 3. Notifications page renders cleanly under 我的 › 通知
    if (!browser) throw new Error('browser not launched')
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(
      `${base}/zh/console/me/notifications?remote=1#pair=${encodeURIComponent(token)}${roomQuery}`,
    )
    const panel = page.getByTestId('notifications-page')
    await panel.waitFor({ timeout: 20_000 })
    const text = await panel.innerText()
    expect(text).toContain('等待确认或回复')
    expect(text).toContain('拆单提案待批')
    expect(text).toContain('电脑前活跃时静默弹窗')
    await context.close()
  })
})
