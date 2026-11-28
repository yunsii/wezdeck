// covers: web/src/features/session-pin.tsx web/src/features/session-list.tsx
// covers: web/src/features/session-chat-row.tsx web/src/features/session-chat-group.tsx web/src/features/session-chats.ts
import { chromium } from '@playwright/test'
import { expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

it('pins one grouped session inside its own repository and restores it on unpin', async () => {
  const browser = await chromium.launch()
  try {
    const root = '/fixture/first/shared'
    const other = '/fixture/second/shared'
    const pins = new Map<string, number>()
    let reject = false
    const row = (id: string, repo: string, index: number) => ({
      id,
      title: id,
      name: 'codex',
      agent: 'codex',
      status: 'running',
      window: id,
      branch: 'main',
      cwd: repo,
      repo_root: repo,
      worktree: repo,
      repo: 'shared',
      ts: index,
      pane_index: index,
      last_prompt: '',
      transcript: true,
      desk_idle_s: 60,
    })
    const rows = [
      row('first', root, 1),
      row('second', root, 2),
      row('other', other, 3),
    ]
    const open = async () => {
      const page = await browser.newPage({
        locale: 'zh-CN',
        viewport: { width: 412, height: 850 },
      })
      await page.route('http://127.0.0.1:35791/**', async (route) => {
        const request = route.request()
        const path = new URL(request.url()).pathname
        const headers = {
          'access-control-allow-origin': base,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-allow-private-network': 'true',
        }
        const reply = (json: unknown, status = 200) =>
          route.fulfill({ headers, json, status })
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
        if (path === '/api/v1/remote/sessions')
          return reply({
            sessions: rows.map((session) => ({
              ...session,
              pinned_at: pins.get(session.id),
            })),
          })
        if (path === '/api/v1/remote/session.pin') {
          if (reject) return reply({ error: 'fixture' }, 500)
          const { id, pinned } = request.postDataJSON() as {
            id: string
            pinned: boolean
          }
          if (pinned) pins.set(id, Date.now())
          else pins.delete(id)
          return reply({ id, pinned_at: pins.get(id) ?? 0 })
        }
        return reply({})
      })
      await page.goto(`${base}/zh/console/sessions`)
      return page
    }
    const page = await open()
    const first = page.locator('[data-session="first"]')
    await first.focus({ timeout: 10_000 })
    await first.press('Shift+F10')
    const action = page.getByTestId('session-row-pin')
    await action.waitFor({ timeout: 5_000 })
    await action.focus()
    await page.keyboard.press('Enter')
    const section = page.locator(`[data-repo-key="${root}"]`)
    await section.locator('[data-session="first"][data-pinned]').waitFor()
    expect(await page.locator('[data-session="first"]').count()).toBe(1)
    expect(
      await page.locator(`[data-repo-key="${other}"] [data-pinned]`).count(),
    ).toBe(0)
    await section.getByTestId('chat-group-toggle').click()
    expect(await section.locator('[data-session="second"]').count()).toBe(0)
    expect(await first.isVisible()).toBe(true)
    await expect.poll(() => pins.has('first')).toBe(true)

    const otherDevice = await open()
    await otherDevice.locator('[data-session="first"][data-pinned]').waitFor()
    reject = true
    await first.click({ button: 'right' })
    await action.click()
    await first.and(page.locator('[data-pinned]')).waitFor()
    await page.locator('[data-sonner-toast][data-type="error"]').waitFor()
    reject = false
    await first.click({ button: 'right' })
    await action.click()
    await expect.poll(() => pins.has('first')).toBe(false)
    await section.getByTestId('chat-group-toggle').click()
    await section.locator('[data-group] [data-session="first"]').waitFor()
  } finally {
    await browser.close()
  }
}, 35_000)
