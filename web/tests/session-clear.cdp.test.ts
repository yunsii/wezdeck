// covers: web/src/features/session-clear.tsx web/src/features/session-list.tsx
// covers: native/wezdeck-wsl/remote_clear.go
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Swipe a session row left → 标为已读 (session-clear.tsx): the host archives
// that attention entry like Ctrl+X in Alt+/ (remote_clear.go →
// attention-jump.sh --forget). The test relay must point at the stack's
// throwaway attention file, which is also where the clear has to land.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''
const devicesFile = process.env.WEZDECK_TEST_DEVICES ?? ''
const repo = join(import.meta.dirname, '..', '..')

describe.runIf(attention && devicesFile)('Mark a session read', () => {
  let browser: Browser
  const socket = join(mkdtempSync(join(tmpdir(), 'wd-clear-')), 'sock')
  const tmux = (...args: Array<string>) =>
    execFileSync('tmux', ['-S', socket, ...args])
      .toString()
      .trim()

  beforeAll(async () => {
    tmux('new-session', '-d', '-s', 'done1', '-x', '100', '-y', '20', 'cat')
    writeFileSync(
      attention,
      JSON.stringify({
        entries: {
          'clear-me': {
            session_id: 'clear-me',
            tmux_socket: socket,
            tmux_session: 'done1',
            tmux_pane: tmux(
              'display-message',
              '-p',
              '-t',
              'done1',
              '#{pane_id}',
            ),
            status: 'done',
            agent_name: 'claude',
            tmux_window_name: 'clear-me',
            ts: Date.now(),
          },
        },
      }),
    )
    writeFileSync(devicesFile, JSON.stringify({ approved: [], pending: [] }))
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser.close()
    tmux('kill-server')
  })

  it('swipe left, tap 标为已读: the entry is archived', async () => {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/writing?remote=1#pair=${token}`)
    await page.locator('main[data-remote-mode]').waitFor({ timeout: 20_000 })
    await page.getByRole('button', { name: '申请授权' }).click()
    const command = page.locator('code', { hasText: '--approve' })
    await command.waitFor({ timeout: 20_000 })
    const id = ((await command.textContent()) ?? '').trim().split(' ').at(-1)
    execFileSync(
      join(repo, 'scripts/dev/install-remote-relay.sh'),
      ['--approve', id ?? ''],
      { env: { ...process.env, WEZDECK_REMOTE_DEVICES: devicesFile } },
    )
    await page.getByRole('button', { name: '重新检查' }).click()
    await page.getByText(/^已获批。/).waitFor({ timeout: 15_000 })

    await page.goto(`${base}/zh/console/sessions`)
    const row = page.locator('[data-swipe=clear-me]')
    await row.waitFor({ timeout: 15_000 })
    const box = await row.boundingBox()
    if (!box) throw new Error('row has no box')
    const y = box.y + box.height / 2
    const cdp = await context.newCDPSession(page)
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
      })
    await touch('touchStart', box.x + box.width - 60)
    for (let step = 1; step <= 8; step++)
      await touch('touchMove', box.x + box.width - 60 - step * 20)
    await touch('touchEnd', 0)
    await row.getByRole('button', { name: '标为已读' }).click()
    await expect
      .poll(
        () => {
          const doc = JSON.parse(readFileSync(attention, 'utf8')) as {
            entries?: Record<string, unknown>
            recent?: Array<{ session_id: string }>
          }
          return {
            live: Boolean(doc.entries?.['clear-me']),
            archived: (doc.recent ?? []).some(
              (r) => r.session_id === 'clear-me',
            ),
          }
        },
        { timeout: 10_000 },
      )
      .toEqual({ live: false, archived: true })
    await context.close()
  })
})
