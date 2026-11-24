// covers: web/src/features/chat-scroll.ts web/src/features/chat-sticky.tsx
// covers: web/src/lib/view-transition.ts web/src/router.tsx
// covers: web/src/features/console-collab.tsx web/src/lib/collab-query.ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Switching items in a wide split must not flash (2026-11-24): no view
// transition, the router does not carry the old item's scroll offset onto
// the new one, a conversation lands at its bottom on its first frame, a
// ticket at its top with the previous one held (no Loading… in between).
// Every animation frame after the click is sampled in the page. Sessions:
// two tmux panes, the taller one opened second, so a frame drawn at the old
// offset would sit far from its bottom. remote-test-stack.sh only.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''
const stack = process.env.WEZDECK_TEST_STACK_DIR ?? ''

type Frame = {
  rowShadow: string
  t: number
  key: string
  scroll: number
  bottom: number
  busy: number
  sticky: number
  vt: number
}

/** sample every frame for `ms` after `act`; key = the pane's title */
async function frames(page: Page, title: string, act: () => Promise<void>) {
  await page.evaluate((sel) => {
    const w = window as unknown as { f: Array<Frame>; vt: number }
    w.f = []
    w.vt = 0
    const start = document.startViewTransition.bind(document)
    document.startViewTransition = ((arg: never) => {
      w.vt += 1
      return start(arg)
    }) as typeof document.startViewTransition
    const t0 = performance.now()
    const tick = () => {
      const el = document.querySelector<HTMLElement>('.vt-page')
      w.f.push({
        t: performance.now() - t0,
        key: document.querySelector(sel)?.textContent ?? '',
        scroll: el?.scrollTop ?? -1,
        bottom: el ? el.scrollHeight - el.clientHeight : -1,
        busy: document.querySelector('[aria-busy=true]') ? 1 : 0,
        sticky: document.querySelector('[data-testid=sticky-prompt]') ? 1 : 0,
        vt: w.vt,
        rowShadow: getComputedStyle(
          document.querySelector('.vt-split-list .row-selected') ??
            document.body,
        ).boxShadow,
      })
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, title)
  await act()
  await page.waitForTimeout(1700)
  return page.evaluate(() => (window as unknown as { f: Array<Frame> }).f)
}

describe.runIf(attention)('Wide split: switching does not flash', () => {
  let browser: Browser
  const socket = join(mkdtempSync(join(tmpdir(), 'wd-sw-')), 'sock')
  const tmux = (...args: Array<string>) =>
    execFileSync('tmux', ['-S', socket, ...args])
      .toString()
      .trim()

  beforeAll(async () => {
    const entries: Record<string, unknown> = {}
    const panes: Record<string, string> = {
      // scrolls a little: its offset is what the router used to carry over
      'sw-short': 'sh -c "seq 1 40; exec cat"',
      // a tall screen: the thread is far taller than the short one's
      'sw-tall': 'sh -c "seq 1 400; exec cat"',
    }
    for (const [id, cmd] of Object.entries(panes)) {
      // the title is the cwd basename: one directory each
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
        '120',
        cmd,
      )
      entries[id] = {
        session_id: id,
        tmux_socket: socket,
        tmux_session: id,
        tmux_pane: tmux('display-message', '-p', '-t', id, '#{pane_id}'),
        status: 'idle',
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

  it('a session lands at its bottom on its first frame, no transition', async () => {
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 700 } })
    ).newPage()
    await page.goto(`${base}/console/sessions/sw-short?remote=1#pair=${token}`)
    await page.locator('[data-session=sw-tall]').waitFor({ timeout: 20_000 })
    await page.waitForTimeout(1500)
    const tall = page.locator('[data-session=sw-tall]')
    const short = page.locator('[data-session=sw-short]')
    const check = (f: Array<Frame>) => {
      const shown = f.filter((x) => x.key.includes('sw-tall'))
      expect(shown.length).toBeGreaterThan(0)
      // tall enough that the old offset would be far from this bottom
      expect(shown[0].bottom).toBeGreaterThan(400)
      for (const x of shown) expect(x.bottom - x.scroll).toBeLessThan(4)
      // no Loading… frame, no transition, no sticky prompt flashing by
      expect(f.some((x) => x.key.startsWith('Loading'))).toBe(false)
      expect(f.every((x) => x.vt === 0 && x.sticky === 0)).toBe(true)
      // the open row never paints an accent box-shadow: easing from the
      // press veil (999 px spread) into one filled the row solid blue
      expect(f.filter((x) => /rgb\(31, 127, 230/.test(x.rowShadow))).toEqual([])
    }
    // never opened here: hovering the row warms it, so no Loading… frame
    await tall.hover()
    await page.waitForTimeout(800)
    // a real press (down, a beat, up): the veil is on while it is held
    const press = async () => {
      await page.mouse.down()
      await page.waitForTimeout(120)
      await page.mouse.up()
    }
    check(await frames(page, '[data-testid=session-title]', press))
    // cached now: the router used to carry sw-short's offset onto it
    await short.click()
    await page.waitForTimeout(1500)
    await tall.hover()
    check(await frames(page, '[data-testid=session-title]', press))
  }, 60_000)

  it.runIf(stack)(
    'a ticket starts at its top, the last one held meanwhile',
    async () => {
      const page = await (
        await browser.newContext({ viewport: { width: 1280, height: 700 } })
      ).newPage()
      await page.goto(`${base}/console/collab?remote=1#pair=${token}`)
      const rows = page.locator('[data-ticket]')
      await rows.nth(1).waitFor({ timeout: 20_000 })
      await rows.nth(0).click()
      const pane = page.getByTestId('ticket-pane')
      await expect
        .poll(() => pane.locator('h1').first().textContent())
        .not.toMatch(/^Loading/)
      await page.waitForTimeout(800)
      await page.evaluate(() => {
        const el = document.querySelector('.vt-page')
        if (el) el.scrollTop = 400
      })
      const f = await frames(page, '[data-testid=ticket-pane] h1', () =>
        rows.nth(1).click(),
      )
      const after = f.slice(f.findIndex((x) => x.scroll !== 400 || x.busy))
      expect(f.some((x) => x.key.startsWith('Loading'))).toBe(false)
      expect(after.every((x) => x.scroll === 0)).toBe(true)
      expect(f.every((x) => x.vt === 0)).toBe(true)
    },
    60_000,
  )
})
