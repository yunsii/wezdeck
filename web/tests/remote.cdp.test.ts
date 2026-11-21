import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Remote access (docs/remote-access.md): the collab page with no loopback
// Runtime reaches the host through the HostRelay Durable Object. Needs
//   vite dev with VITE_WEZDECK_RUNTIME_URL pointing at a dead port (.dev.vars
//   holds RELAY_HOST_TOKEN / RELAY_CLIENT_TOKEN), and
//   `wezdeck-wsl relay` connected to it (WEZDECK_RELAY_URL=ws://…/relay/host).
// Launches its own headless Chromium so WebRTC host candidates are local.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'

// Headless Chromium under WSL sometimes reports ERR_NETWORK_CHANGED while
// interfaces (IPv6 / tunnel) settle right after launch; retry that once.
async function open(page: Page, url: string) {
  try {
    await page.goto(url)
  } catch (error) {
    if (!String(error).includes('ERR_NETWORK_CHANGED')) throw error
    await page.waitForTimeout(1_000)
    await page.goto(url)
  }
}

async function badge(page: Page, mode: string) {
  const el = page.getByTestId('remote-badge')
  await page.waitForFunction(
    ([m]) => {
      const b = document.querySelector('[data-testid="remote-badge"]')
      return b?.getAttribute('data-mode') === m && b.getAttribute('data-rtt')
    },
    [mode],
    { timeout: 30_000 },
  )
  return {
    text: (await el.textContent()) ?? '',
    path: await el.getAttribute('data-path'),
    rtt: Number(await el.getAttribute('data-rtt')),
  }
}

describe('Remote collab over WebRTC with WebSocket fallback', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser.close()
  })

  it('prefers a WebRTC DataChannel and shows path + latency', async () => {
    const page = await browser.newPage()
    await open(page, `${base}/console/collab?remote=1#pair=${token}`)
    const b = await badge(page, 'webrtc')
    expect(b.text).toContain('WebRTC')
    // Direct either way; which one depends on the interfaces this machine
    // exposes (a public IPv6 host candidate counts as "internet").
    expect(['lan', 'internet']).toContain(b.path)
    expect(b.rtt).toBeGreaterThanOrEqual(0)
    const list = page.getByRole('listbox', { name: 'Collab tickets' })
    await list.getByRole('option').first().waitFor({ timeout: 20_000 })
    expect(await list.getByRole('option').count()).toBeGreaterThan(0)
    // Requests issued after the DataChannel opened must use it: open a
    // ticket that is not loaded yet (falls back to the 30 s idle poll).
    await list.getByRole('option').last().click()
    await page.waitForFunction(
      () =>
        Number(
          document
            .querySelector('[data-testid="remote-badge"]')
            ?.getAttribute('data-rpc-webrtc'),
        ) > 0,
      undefined,
      { timeout: 40_000 },
    )
    await page.close()
  }, 90_000)

  it('falls back to the WebSocket relay when WebRTC is off', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await open(
      page,
      `${base}/console/collab?remote=1&transport=websocket#pair=${token}`,
    )
    const b = await badge(page, 'websocket')
    expect(b.text).toContain('WebSocket')
    const list = page.getByRole('listbox', { name: 'Collab tickets' })
    await list.getByRole('option').first().waitFor({ timeout: 20_000 })
    await context.close()
  }, 60_000)

  it('rejects a wrong client token', async () => {
    const page = await browser.newPage()
    await open(page, `${base}/console/collab`)
    const code = await page.evaluate(
      (url) =>
        new Promise<number>((resolve) => {
          const ws = new WebSocket(url, ['wezdeck.v1', 'token.wrong'])
          ws.onopen = () => resolve(0)
          ws.onclose = (e) => resolve(e.code)
        }),
      `${base.replace(/^http/, 'ws')}/relay/client`,
    )
    expect(code).not.toBe(0)
    await page.close()
  })
})
