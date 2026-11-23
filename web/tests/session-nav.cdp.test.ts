import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// wezdeck's session keys on the phone (session-switcher.tsx): the header's
// "N more need you" chip and Alt+j jump between sessions waiting on you, the
// title opens the switcher sheet, and switching replaces the history entry
// so back returns to the list. Runs against remote-test-stack.sh only
// (throwaway attention file, tmux panes made here).
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''

describe.runIf(attention)('Session keys on the phone', () => {
  let browser: Browser
  const socket = join(mkdtempSync(join(tmpdir(), 'wd-nav-')), 'sock')
  const tmux = (...args: Array<string>) =>
    execFileSync('tmux', ['-S', socket, ...args])
      .toString()
      .trim()

  beforeAll(async () => {
    const sessions: Record<string, [string, string?]> = {
      'nav-a': ['waiting', 'permission'],
      'nav-b': ['waiting', 'question'],
      'nav-c': ['running'],
    }
    const entries: Record<string, unknown> = {}
    for (const [id, [status, waiting]] of Object.entries(sessions)) {
      tmux('new-session', '-d', '-s', id, '-x', '100', '-y', '20', 'cat')
      entries[id] = {
        session_id: id,
        tmux_socket: socket,
        tmux_session: id,
        tmux_pane: tmux('display-message', '-p', '-t', id, '#{pane_id}'),
        status,
        waiting_kind: waiting ?? '',
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

  it('chip and Alt+j cycle the waiting ones; back returns to the list', async () => {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await openList(page)
    await page.locator('[data-session=nav-c]').click()
    await page.waitForURL('**/console/sessions/nav-c')
    // nav-c is running: the header offers the two waiting ones
    const chip = page.getByTestId('next-waiting')
    await expect.poll(() => chip.textContent()).toContain('还有 2 个等你')
    await chip.click()
    await page.waitForURL(/\/console\/sessions\/nav-[ab]$/)
    const first = page.url().split('/').at(-1) ?? ''
    // the page swaps in after the URL (view transition): press once the
    // header shows the new session, as a person would
    await expect
      .poll(() => page.getByTestId('session-title').textContent())
      .toContain(first)
    await page.keyboard.press('Alt+j')
    await expect
      .poll(() => page.url().split('/').at(-1))
      .toBe(first === 'nav-a' ? 'nav-b' : 'nav-a')
    // the jumps replaced history: back goes to the list, not nav-c
    await page.goBack()
    await page.waitForURL(/\/console\/sessions(\?[^/]*)?$/)
    await context.close()
  })

  it('the title opens the switcher; picking a session goes there', async () => {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await openList(page)
    await page.locator('[data-session=nav-a]').click()
    await page.waitForURL('**/console/sessions/nav-a')
    await page.getByTestId('session-title').click()
    const sheet = page.getByTestId('session-switcher')
    await sheet.waitFor()
    await expect
      .poll(() => sheet.locator('[aria-current=page]').textContent())
      .toContain('nav-a')
    await sheet.getByRole('button', { name: /nav-c/ }).click()
    await page.waitForURL('**/console/sessions/nav-c')
    await expect.poll(() => sheet.count()).toBe(0)
    await context.close()
  })
})
