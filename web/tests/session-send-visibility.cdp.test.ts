// covers: web/src/features/session-send.ts web/src/features/session-send-helpers.ts
// covers: web/src/features/session-detail-read.ts web/src/features/chat-thread.tsx
import { chromium } from '@playwright/test'
import { it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const id = 'send-visibility'
const text = 'message stays visible while the transcript catches up'

function gate() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}

it('keeps the message visible after the send replies and before detail catches up', async () => {
  const browser = await chromium.launch()
  const read = gate()
  const send = gate()
  try {
    const page = await browser.newPage({
      locale: 'zh-CN',
      viewport: { width: 412, height: 850 },
    })
    page.setDefaultTimeout(5_000)
    let submitting = false
    const row = {
      id,
      name: id,
      cwd: '/tmp/send-visibility',
      worktree: '',
      window: id,
      branch: 'main',
      last_prompt: '',
      transcript: true,
      desk_idle_s: 60,
      status: 'done',
      agent: 'codex',
      ts: Date.now(),
    }
    await page.route('http://127.0.0.1:35791/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const headers = {
        'access-control-allow-origin': base,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-private-network': 'true',
      }
      const reply = (json: unknown) => route.fulfill({ headers, json })
      if (request.method() === 'OPTIONS')
        return route.fulfill({ status: 204, headers })
      if (path === '/api/v1/health')
        return reply({
          api_version: 'v1',
          instance_id: 'test',
          ready: true,
          capabilities: ['remote.read', 'remote.write'],
          observed_at: new Date().toISOString(),
        })
      if (path === '/api/v1/remote/sessions') return reply({ sessions: [row] })
      if (path === '/api/v1/remote/session.skills') return reply({ skills: [] })
      if (path === '/api/v1/remote/send') {
        submitting = true
        await send.pending
        return reply({ ok: true })
      }
      if (path === '/api/v1/remote/session') {
        const afterSend = submitting
        if (afterSend) await read.pending
        return reply({
          ...row,
          start: 0,
          outbox: [],
          messages: afterSend ? [{ role: 'user', text }] : [],
        })
      }
      return reply({})
    })

    const detail = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/remote/session',
    )
    await page.goto(`${base}/zh/console/sessions/${id}`)
    await detail
    const composer = page.getByLabel('发给 Agent 的消息')
    await composer.fill(text)
    await composer.press('Control+Enter')
    const thread = page.getByTestId('session-thread-scroll')
    await thread
      .locator('[data-pending="sending"]')
      .filter({ hasText: text })
      .waitFor()
    send.release()
    await thread
      .locator('[data-pending="queued"]')
      .filter({ hasText: text })
      .waitFor({ timeout: 3_000 })
    read.release()
    await thread
      .locator('[data-pending]')
      .filter({ hasText: text })
      .waitFor({ state: 'detached' })
    await thread.getByText(text, { exact: true }).waitFor()
  } finally {
    send.release()
    read.release()
    await browser.close()
  }
}, 25_000)
