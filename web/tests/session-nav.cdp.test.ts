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
    // the agent's own name shows beside the window title
    await expect
      .poll(() => page.getByTestId('session-agent-name').textContent())
      .toBe('claude')
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

  it('the switcher sheet closes by swiping down, not by a small drag', async () => {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await openList(page)
    await page.locator('[data-session=nav-a]').click()
    await page.waitForURL('**/console/sessions/nav-a')
    const sheet = page.getByTestId('session-switcher')
    const cdp = await context.newCDPSession(page)
    const drag = async (dy: number) => {
      const box = await sheet.boundingBox()
      if (!box) throw new Error('sheet has no box')
      const x = box.x + box.width / 2
      const y = box.y + 12 // the grab handle
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y }],
      })
      for (let step = 1; step <= 10; step++)
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: y + (dy * step) / 10 }],
        })
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      })
    }
    // a small drag springs back
    await page.getByTestId('session-title').click()
    await sheet.waitFor()
    await page.waitForTimeout(400)
    await drag(20)
    await page.waitForTimeout(600)
    expect(await sheet.count()).toBe(1)
    // a real swipe down dismisses it
    await drag(320)
    await expect.poll(() => sheet.count(), { timeout: 3_000 }).toBe(0)
    // and a tap on the backdrop above it does too
    await page.getByTestId('session-title').click()
    await sheet.waitFor()
    await page.waitForTimeout(400)
    await page.mouse.click(20, 40)
    await expect.poll(() => sheet.count(), { timeout: 3_000 }).toBe(0)
    await context.close()
  })

  it('wide screen: list and conversation side by side, j moves on', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await openList(page)
    await page.locator('[data-session=nav-c]').click()
    await page.waitForURL('**/console/sessions/nav-c')
    // the list stays beside the open conversation, its row marked
    await expect
      .poll(() =>
        page.locator('[data-session=nav-c]').getAttribute('aria-current'),
      )
      .toBe('page')
    expect(await page.getByTestId('session-pane').count()).toBe(1)
    await expect
      .poll(() => page.getByTestId('session-title').textContent())
      .toContain('nav-c')
    await page.keyboard.press('j')
    await expect.poll(() => page.url().split('/').at(-1)).not.toBe('nav-c')
    await context.close()
  })
  it('an unpaired browser says so at once instead of timing out', async () => {
    const context = await browser.newContext({ locale: 'zh-CN' })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/sessions?remote=1`)
    // well under the 10 s RPC timeout: the missing token is known up front
    await page.getByText(/这台设备还没配对/).waitFor({ timeout: 4_000 })
    await context.close()
  })
})
