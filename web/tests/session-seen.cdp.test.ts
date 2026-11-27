// covers: web/src/features/session-clear.tsx web/src/features/session-while-shown.ts
// covers: native/wezdeck-wsl/remote_clear.go
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Seen on the web = seen at the desk: a done session open on the page for a
// moment is cleared from attention.json (the ✓ badge drops at the desk);
// a waiting one stays until it is answered.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''
const devicesFile = process.env.WEZDECK_TEST_DEVICES ?? ''
const repo = join(import.meta.dirname, '..', '..')
const room = process.env.WEZDECK_REMOTE_ROOM ?? ''
const roomQuery = room ? `&room=${room}` : ''

const live = () =>
  Object.keys(
    (JSON.parse(readFileSync(attention, 'utf8')) as { entries: object })
      .entries,
  )

describe.runIf(attention && devicesFile)('Seen on the web', () => {
  let browser: Browser
  const socket = join(mkdtempSync(join(tmpdir(), 'wd-tmux-')), 'sock')
  const tmux = (...args: Array<string>) =>
    execFileSync('tmux', ['-S', socket, ...args]).toString()

  beforeAll(async () => {
    tmux('new-session', '-d', '-s', 'seen', '-x', '100', '-y', '20', 'cat')
    tmux('split-window', '-t', 'seen', 'cat')
    const panes = tmux('list-panes', '-t', 'seen', '-F', '#{pane_id}')
      .trim()
      .split('\n')
    const entry = (id: string, pane: string, status: string) => ({
      session_id: id,
      tmux_socket: socket,
      tmux_session: 'seen',
      tmux_pane: pane,
      status,
      agent_name: id,
      ts: Date.now() - 5_000,
    })
    writeFileSync(
      attention,
      JSON.stringify({
        entries: {
          'done-session': entry('done-session', panes[0] ?? '', 'done'),
          'waiting-session': entry(
            'waiting-session',
            panes[1] ?? '',
            'waiting',
          ),
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

  const approve = async (page: Page) => {
    await page.goto(
      `${base}/zh/console/me/writing?remote=1${roomQuery}#pair=${token}`,
    )
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
  }

  it('a done session on screen is cleared at the desk, a waiting one is not', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await approve(page)

    await page.goto(`${base}/zh/console/sessions/waiting-session`)
    await page.getByLabel('发给 Agent 的消息').waitFor({ timeout: 15_000 })
    await page.waitForTimeout(3_000)
    expect(live()).toContain('waiting-session')

    await page.goto(`${base}/zh/console/sessions/done-session`)
    await page.getByLabel('发给 Agent 的消息').waitFor({ timeout: 15_000 })
    await expect
      .poll(() => live().includes('done-session'), { timeout: 10_000 })
      .toBe(false)
    expect(live()).toContain('waiting-session')
    await context.close()
  })
})
