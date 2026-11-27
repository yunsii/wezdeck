// covers: web/src/features/chat-scroll.ts web/src/features/chat-sticky.tsx
// covers: web/src/lib/view-transition.ts web/src/router.tsx
// covers: web/src/features/console-collab.tsx web/src/lib/collab-query.ts
// covers: web/src/components/deck/split-column.tsx web/src/features/console-me.tsx
// covers: web/src/features/session-split.tsx web/src/styles/motion.css
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

/** sample every frame for `ms` after `act`; key = the pane's session id, else its title */
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
        key:
          document.querySelector(sel)?.getAttribute('data-session-id') ??
          document.querySelector(sel)?.textContent ??
          '',
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

/** two tmux panes in the stack's attention file and a browser, per describe */
function splitStack() {
  const split = {} as { browser: Browser }
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
    split.browser = await chromium.launch()
  })

  afterAll(async () => {
    await split.browser.close()
    tmux('kill-server')
  })
  return split
}

describe.runIf(attention)('Wide split: switching does not flash', () => {
  const split = splitStack()

  it('the list stays in view beside a tall conversation', async () => {
    const page = await (
      await split.browser.newContext({ viewport: { width: 1280, height: 700 } })
    ).newPage()
    await page.goto(`${base}/console/sessions/sw-tall?remote=1#pair=${token}`)
    const row = page.locator('[data-session=sw-short]')
    await row.waitFor({ timeout: 20_000 })
    await page.waitForTimeout(1500)
    // the page sits at the tall thread's bottom: the list is still in view
    // (a list-high wrapper let the page scroll carry it off the top)
    const inView = () =>
      row.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return r.top >= 0 && r.bottom <= window.innerHeight
      })
    expect(await inView()).toBe(true)
    await page.evaluate(() => {
      const scroller = document
        .querySelector('[data-testid=session-pane]')
        ?.closest('.overflow-y-auto')
      if (scroller) scroller.scrollTop = 0
    })
    await page.waitForTimeout(300)
    expect(await inView()).toBe(true)
  }, 30_000)

  it('a session lands at its bottom on its first frame, no transition', async () => {
    const page = await (
      await split.browser.newContext({ viewport: { width: 1280, height: 700 } })
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
        await split.browser.newContext({
          viewport: { width: 1280, height: 700 },
        })
      ).newPage()
      // a ticket with runs, taller than the window (the list's first one
      // changes with the ticket store and may be short)
      await page.goto(
        `${base}/console/collab/req-20261123-090146-a3af56?remote=1#pair=${token}`,
      )
      const other = page.locator(
        '[data-ticket]:not([data-ticket=req-20261123-090146-a3af56])',
      )
      await other.first().waitFor({ timeout: 20_000 })
      const pane = page.getByTestId('ticket-pane')
      await expect
        .poll(() => pane.locator('h1').first().textContent())
        .not.toMatch(/^Loading/)
      // the ticket's runs load after its title: wait until the page is tall
      // enough to stand 400 px down (scrolling early stopped at 7 px)
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const el = document.querySelector('.vt-page')
              return el ? el.scrollHeight - el.clientHeight : 0
            }),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(400)
      await page.waitForTimeout(800)
      await page.evaluate(() => {
        const el = document.querySelector('.vt-page')
        if (el) el.scrollTop = 400
      })
      const f = await frames(page, '[data-testid=ticket-pane] h1', () =>
        other.first().click(),
      )
      const after = f.slice(f.findIndex((x) => x.scroll !== 400 || x.busy))
      expect(f.some((x) => x.key.startsWith('Loading'))).toBe(false)
      expect(after.every((x) => x.scroll === 0)).toBe(true)
      expect(f.every((x) => x.vt === 0)).toBe(true)
    },
    60_000,
  )

  it.runIf(stack)(
    "wheeling past the list's top leaves the pane where it is",
    async () => {
      const page = await (
        await split.browser.newContext({
          viewport: { width: 1280, height: 480 },
        })
      ).newPage()
      // a ticket with runs: its pane is taller than the window
      await page.goto(
        `${base}/console/collab/req-20261123-090146-a3af56?remote=1#pair=${token}`,
      )
      await page.locator('[data-ticket]').first().waitFor({ timeout: 20_000 })
      await page.getByTestId('ticket-pane').locator('h1').first().waitFor()
      await page.waitForTimeout(1500)
      const pageScroll = () =>
        page.evaluate(() => document.querySelector('.vt-page')?.scrollTop ?? -1)
      await page.evaluate(() => {
        const el = document.querySelector('.vt-page')
        if (el) el.scrollTop = 300
      })
      const before = await pageScroll()
      expect(before).toBeGreaterThan(0)
      // the list column's own scroller sits at its top: wheel up over it
      const box = await page.locator('[data-ticket]').first().boundingBox()
      if (!box) throw new Error('no ticket row')
      await page.mouse.move(box.x + 40, box.y + 10)
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, -400)
        await page.waitForTimeout(60)
      }
      await page.waitForTimeout(300)
      expect(await pageScroll()).toBe(before)
    },
    60_000,
  )
})

describe.runIf(attention)('Wide split: layout', () => {
  const split = splitStack()

  it('the flat list rail sits flush between sidebar and divider with symmetric row padding', async () => {
    const page = await (
      await split.browser.newContext({ viewport: { width: 1280, height: 700 } })
    ).newPage()
    await page.goto(`${base}/console/sessions/sw-tall?remote=1#pair=${token}`)
    await page.locator('[data-session=sw-short]').waitFor({ timeout: 20_000 })
    await page.waitForTimeout(800)
    const gaps = await page.evaluate(() => {
      const r = (sel: string) =>
        document.querySelector(sel)!.getBoundingClientRect()
      const main = r('#console-main')
      const repo = r('[data-repo]')
      const row = document.querySelector<HTMLElement>(
        '[data-session=sw-short]',
      )!
      const style = getComputedStyle(row)
      const pane = r('[data-testid=session-pane]')
      return {
        left: Math.round(repo.left - main.left),
        right: Math.round(pane.left - repo.right),
        padLeft: Math.round(parseFloat(style.paddingLeft)),
        padRight: Math.round(parseFloat(style.paddingRight)),
      }
    })
    // Full-bleed flat rail (no card inset), with equal inner gutters on both sides
    expect(gaps.left).toBe(0)
    expect(gaps.right).toBe(0)
    expect(gaps.padLeft).toBeGreaterThan(0)
    expect(Math.abs(gaps.padLeft - gaps.padRight)).toBeLessThanOrEqual(1)
  }, 30_000)

  it('我的 has the split divider, full window height', async () => {
    const page = await (
      await split.browser.newContext({ viewport: { width: 1280, height: 700 } })
    ).newPage()
    await page.goto(`${base}/console/me/connection?remote=1#pair=${token}`)
    const pane = page.locator('.vt-split-pane')
    await pane.waitFor({ timeout: 20_000 })
    const got = await pane.evaluate((el) => {
      const scroller = el.closest('.vt-page') as HTMLElement
      const r = el.getBoundingClientRect()
      const s = scroller.getBoundingClientRect()
      return {
        border: getComputedStyle(el).borderLeftWidth,
        top: r.top - s.top,
        bottom: s.bottom - r.bottom,
      }
    })
    expect(got.border).toBe('1px')
    expect(got.top).toBeLessThanOrEqual(1)
    expect(got.bottom).toBeLessThanOrEqual(1)
  }, 30_000)

  it('a switched-to conversation fades in as a whole, the first one does not', async () => {
    const page = await (
      await split.browser.newContext({ viewport: { width: 1280, height: 700 } })
    ).newPage()
    await page.goto(`${base}/console/sessions/sw-short?remote=1#pair=${token}`)
    await page.locator('[data-session=sw-tall]').waitFor({ timeout: 20_000 })
    await page.waitForTimeout(800)
    const anim = () =>
      page.evaluate(
        () =>
          getComputedStyle(
            document.querySelector('[data-testid=session-detail]')!,
          ).animationName,
      )
    expect(await anim()).toBe('none')
    await page.locator('[data-session=sw-tall]').click()
    await expect
      .poll(() =>
        page.evaluate(() =>
          document
            .querySelector('[data-testid=session-title]')
            ?.getAttribute('data-session-id'),
        ),
      )
      .toBe('sw-tall')
    // opacity only: whole detail, nothing slides on its own
    expect(await anim()).toBe('pane-enter')
    expect(
      await page.evaluate(
        () =>
          [
            ...document.querySelectorAll(
              '[data-testid=session-detail] .chat-in',
            ),
          ].length,
      ),
    ).toBe(0)
  }, 30_000)
})
