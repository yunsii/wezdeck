// covers: web/src/features/copy-reference.tsx web/src/lib/clipboard.ts
// covers: native/wezdeck-wsl/remote_reference.go
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium, devices } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 复制引用 from the session list (copy-reference.tsx): a row's copy key on a
// phone — for a session never opened here, so the relay's one-message
// `session` read supplies the block — and y beside the open session on a
// wide screen. The ticket list's side is in collab.cdp.test.ts. Runs
// against remote-test-stack.sh only (throwaway attention file, tmux panes
// made here).
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''

describe.runIf(attention)('Session references from the list', () => {
  let browser: Browser
  const socket = join(mkdtempSync(join(tmpdir(), 'wd-ref-')), 'sock')
  const tmux = (...args: Array<string>) =>
    execFileSync('tmux', ['-S', socket, ...args])
      .toString()
      .trim()

  beforeAll(async () => {
    const entries: Record<string, unknown> = {}
    for (const id of ['nav-b', 'nav-c']) {
      const cwd = join(dirname(socket), id)
      mkdirSync(cwd)
      tmux(
        'new-session',
        '-d',
        '-s',
        id,
        '-c',
        cwd,
        '-x',
        '100',
        '-y',
        '20',
        'cat',
      )
      entries[id] = {
        session_id: id,
        tmux_socket: socket,
        tmux_session: id,
        tmux_pane: tmux('display-message', '-p', '-t', id, '#{pane_id}'),
        status: 'waiting',
        waiting_kind: 'question',
        agent_name: 'claude',
        tmux_window_name: id,
        last_user_prompt: `prompt ${id}`,
        ts: Date.now(),
      }
    }
    writeFileSync(attention, JSON.stringify({ entries }))
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser.close()
    tmux('kill-server')
  })

  const openList = async (page: Page) => {
    await page.goto(`${base}/zh/console/sessions?remote=1#pair=${token}`)
    await page.locator('[data-session=nav-c]').waitFor({ timeout: 20_000 })
  }

  it('复制引用 from the list (phone) and y beside the open one (wide)', async () => {
    const phone = await browser.newContext({
      ...devices['Pixel 7'],
      locale: 'zh-CN',
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    const page = await phone.newPage()
    await openList(page)
    // a session never opened here: the relay's one-message read carries it
    await page
      .locator('[data-session=nav-b]')
      .locator('..')
      .getByTestId('row-copy-reference')
      .click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toMatch(/^\[wezdeck 会话\] .*\nsession_id: nav-b\n/)
    // the row stays: copying does not open the session
    expect(page.url()).not.toContain('nav-b')
    await phone.close()

    const wide = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    const desk = await wide.newPage()
    await openList(desk)
    await desk.locator('[data-session=nav-c]').click()
    await desk.waitForURL('**/console/sessions/nav-c')
    await desk.getByTestId('session-title').waitFor()
    await desk.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    )
    await desk.keyboard.press('y')
    await expect
      .poll(() => desk.evaluate(() => navigator.clipboard.readText()))
      .toContain('session_id: nav-c')
    await wide.close()
  })
})
