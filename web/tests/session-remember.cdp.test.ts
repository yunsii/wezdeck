// covers: web/src/lib/last-opened.tsx web/src/features/session-split.tsx
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 会话 with no session in the URL (wide): the session last opened under the
// current filter; else the one last opened at all, switching to 全部; else
// the top of the list (lib/last-opened.ts pickLast). remote-test-stack.sh
// only (throwaway attention file, tmux panes made here).
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''

describe.runIf(attention)('The split reopens the right session', () => {
  let browser: Browser
  const socket = join(mkdtempSync(join(tmpdir(), 'wd-rm-')), 'sock')
  const tmux = (...args: Array<string>) =>
    execFileSync('tmux', ['-S', socket, ...args])
      .toString()
      .trim()
  const entries: Record<string, Record<string, unknown>> = {}
  const write = () => writeFileSync(attention, JSON.stringify({ entries }))

  beforeAll(async () => {
    const sessions: Record<string, [string, string?]> = {
      'r-a': ['waiting', 'question'],
      'r-b': ['waiting', 'permission'],
      'r-c': ['running'],
    }
    for (const [id, [status, waiting]] of Object.entries(sessions)) {
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
        status,
        waiting_kind: waiting ?? '',
        agent_name: 'claude',
        tmux_window_name: id,
        last_user_prompt: `prompt ${id}`,
        ts: Date.now(),
      }
    }
    write()
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser.close()
    tmux('kill-server')
  })

  const filter = (page: Page, name: RegExp) =>
    page.getByRole('radio', { name }).click()
  const openList = async (page: Page) => {
    await page.goto(`${base}/zh/console/sessions?remote=1#pair=${token}`)
    await page.locator('[data-session]').first().waitFor({ timeout: 20_000 })
  }
  const opened = (page: Page) =>
    page.url().split('?')[0].split('/').at(-1) ?? ''

  it('per filter first, then the last one from 全部, then the top', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await openList(page)
    await filter(page, /^等你/)
    // the first visit already opened the top one (maybe r-b): move away and
    // back so opening r-b happens under 等你
    await page.locator('[data-session=r-a]').click()
    await page.waitForURL('**/console/sessions/r-a')
    await page.locator('[data-session=r-b]').click()
    await page.waitForURL('**/console/sessions/r-b')
    await filter(page, /^全部/)
    await page.locator('[data-session=r-c]').click()
    await page.waitForURL('**/console/sessions/r-c')
    // back on 等你, the page opens 等你's own last, not the overall last
    await filter(page, /^等你/)
    await openList(page)
    await expect.poll(() => opened(page)).toBe('r-b')
    // r-b answered: 等你 no longer lists it → the overall last (r-b, just
    // reopened), shown under 全部
    entries['r-b'] = { ...entries['r-b'], status: 'running', waiting_kind: '' }
    write()
    // a fresh page with only the remembered choices: the persisted session
    // cache would still list r-b under 等你 for the first render
    const saved = await page.evaluate(() => ({ ...localStorage }))
    await context.close()
    const fresh = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      locale: 'zh-CN',
    })
    await fresh.addInitScript((items: Record<string, string>) => {
      for (const [key, value] of Object.entries(items))
        if (key.startsWith('wezdeck-')) localStorage.setItem(key, value)
    }, saved)
    const again = await fresh.newPage()
    await openList(again)
    await expect.poll(() => opened(again)).toBe('r-b')
    await expect
      .poll(() =>
        again
          .getByRole('radio', { name: /^全部/ })
          .getAttribute('aria-checked'),
      )
      .toBe('true')
    await fresh.close()
  }, 90_000)
})
