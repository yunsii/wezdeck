// covers: web/src/features/tickets-view.tsx web/src/lib/turn-progress.ts
// covers: web/src/features/session-list.tsx web/src/features/console-sessions.tsx
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Layout stability (docs/web-pwa.md "Layout stability"): with nothing
// happening on the host, the page must not change under the reader. The
// shell re-renders every 1–2.5 s (polls); a seconds count ("7秒前" →
// "12秒前") rewrote its line each time and shifted the words after it.
// Snapshot every element's text and box in the main column, wait, compare.
// Only elements inside [data-live] (a ticking turn timer, live counters)
// may change, and they sit at the end of their line with tabular digits.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''
const room = process.env.WEZDECK_REMOTE_ROOM ?? ''
const roomQuery = room ? `&room=${room}` : ''

type Box = { key: string; text: string; x: number; y: number; w: number }

const snapshot = (page: Page) =>
  page.evaluate(() => {
    const root = document.getElementById('console-main')
    if (!root) return [] as Array<Box>
    const out: Array<Box> = []
    root.querySelectorAll<HTMLElement>('*').forEach((el, i) => {
      if (el.closest('[data-live]')) return
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? '')
        .join('')
        .trim()
      const r = el.getBoundingClientRect()
      if (!r.width && !r.height) return
      out.push({
        key: `${i}:${el.tagName}`,
        text: own,
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
      })
    })
    return out
  })

describe.runIf(attention)('Layout stability', () => {
  let browser: Browser
  const socket = join(mkdtempSync(join(tmpdir(), 'wd-tmux-')), 'sock')
  const tmux = (...args: Array<string>) =>
    execFileSync('tmux', ['-S', socket, ...args]).toString()

  beforeAll(async () => {
    tmux('new-session', '-d', '-s', 'still', '-x', '100', '-y', '20', 'cat')
    const pane = tmux('display-message', '-p', '-t', 'still', '#{pane_id}')
    // changed 7 s ago: a seconds count would read 7 now and 12 below
    writeFileSync(
      attention,
      JSON.stringify({
        entries: {
          'still-session': {
            session_id: 'still-session',
            tmux_socket: socket,
            tmux_session: 'still',
            tmux_pane: pane.trim(),
            status: 'done',
            agent_name: 'still-agent',
            last_user_prompt: '页面不应该自己动',
            ts: Date.now() - 7_000,
          },
        },
      }),
    )
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser.close()
    tmux('kill-server')
  })

  it('the session list and page do not move on their own', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(
      `${base}/zh/console/sessions?remote=1${roomQuery}#pair=${token}`,
    )
    await page
      .locator('[data-session=still-session]')
      .waitFor({ timeout: 20_000 })
    // let the first loads settle, then watch through several poll renders
    await page.waitForTimeout(2_000)
    const before = await snapshot(page)
    await page.waitForTimeout(5_000)
    const after = await snapshot(page)
    const moved = after.filter((box) => {
      const was = before.find((b) => b.key === box.key)
      return (
        was &&
        (was.text !== box.text ||
          was.x !== box.x ||
          was.y !== box.y ||
          was.w !== box.w)
      )
    })
    expect(
      moved.map((box) => {
        const was = before.find((b) => b.key === box.key)!
        return `${box.key} "${was.text}"→"${box.text}" x ${was.x}→${box.x} w ${was.w}→${box.w}`
      }),
    ).toEqual([])
    expect(after.length).toBe(before.length)
    await context.close()
  })
})
