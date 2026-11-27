// covers: web/src/features/console-sessions.tsx web/src/features/session-split.tsx
// covers: web/src/features/session-delete-state.ts web/src/lib/last-opened.tsx
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''

// When a wide-split device (tablet / desktop) has a deleted or ended session
// still in its cached sessions list and localStorage last-opened key,
// `useLeaveMissingSession` and `usePickDefault` used to ping-pong
// `/console/sessions` <-> `/console/sessions/<dead-id>` in a tight infinite
// loop, freezing the JS main thread so clicks stopped working while the
// compositor still scrolled both panes (2026-11-27).
describe.runIf(attention)('Wide split: missing session does not loop', () => {
  let browser: Browser
  const socket = join(mkdtempSync(join(tmpdir(), 'wd-miss-')), 'sock')
  const tmux = (...args: Array<string>) =>
    execFileSync('tmux', ['-S', socket, ...args])
      .toString()
      .trim()

  let goodPane = ''
  const now = Date.now()

  beforeAll(async () => {
    const cwd1 = join(dirname(socket), 'repo-a', 'good')
    const cwd2 = join(dirname(socket), 'repo-a', 'ghost')
    mkdirSync(cwd1, { recursive: true })
    mkdirSync(cwd2, { recursive: true })
    tmux(
      'new-session',
      '-d',
      '-s',
      'ms-good',
      '-c',
      cwd1,
      '-x',
      '100',
      '-y',
      '120',
      'sh -c "seq 1 80; exec cat"',
    )
    tmux(
      'new-session',
      '-d',
      '-s',
      'ms-ghost',
      '-c',
      cwd2,
      '-x',
      '100',
      '-y',
      '120',
      'sh -c "seq 1 80; exec cat"',
    )
    goodPane = tmux('display-message', '-p', '-t', 'ms-good', '#{pane_id}')
    const ghostPane = tmux(
      'display-message',
      '-p',
      '-t',
      'ms-ghost',
      '#{pane_id}',
    )
    writeFileSync(
      attention,
      JSON.stringify({
        entries: {
          'ms-ghost': {
            session_id: 'ms-ghost',
            tmux_socket: socket,
            tmux_session: 'ms-ghost',
            tmux_pane: ghostPane,
            status: 'idle',
            agent_name: 'claude',
            tmux_window_name: 'ms-ghost',
            session_title: 'Ghost Session',
            last_user_prompt: 'about to vanish',
            ts: now,
          },
          'ms-good': {
            session_id: 'ms-good',
            tmux_socket: socket,
            tmux_session: 'ms-good',
            tmux_pane: goodPane,
            status: 'idle',
            agent_name: 'claude',
            tmux_window_name: 'ms-good',
            session_title: 'Good Session',
            last_user_prompt: 'still alive',
            ts: now - 60_000,
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

  it('evicts the vanished session, lands on a healthy one, and keeps clicks responsive', async () => {
    const context = await browser.newContext({
      viewport: { width: 1292, height: 866 },
      deviceScaleFactor: 2.625,
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.addInitScript(() => {
      const w = window as unknown as { __replaceCount: number }
      w.__replaceCount = 0
      const orig = history.replaceState.bind(history)
      history.replaceState = function (...args) {
        w.__replaceCount += 1
        return orig(...args)
      }
    })

    await page.goto(
      `${base}/zh/console/sessions/ms-ghost?remote=1#pair=${token}`,
    )
    await page.locator('[data-session=ms-good]').waitFor({ timeout: 20_000 })
    await page.waitForTimeout(600)

    // Remove ms-ghost on host so `session` RPC (every 2.5s) fails with
    // "session not found" while `sessions` cache (every 5s) still holds it.
    writeFileSync(
      attention,
      JSON.stringify({
        entries: {
          'ms-good': {
            session_id: 'ms-good',
            tmux_socket: socket,
            tmux_session: 'ms-good',
            tmux_pane: goodPane,
            status: 'idle',
            agent_name: 'claude',
            tmux_window_name: 'ms-good',
            session_title: 'Good Session',
            last_user_prompt: 'still alive',
            ts: now - 60_000,
          },
        },
      }),
    )
    tmux('kill-session', '-t', 'ms-ghost')

    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 10_000 })
      .toBe('/zh/console/sessions/ms-good')

    const replaceCount = await page.evaluate(
      () => (window as unknown as { __replaceCount: number }).__replaceCount,
    )
    expect(replaceCount).toBeLessThan(15)

    // Main thread must stay responsive: clicking sidebar navigation works
    await page.locator('aside a', { hasText: '我的' }).click({ timeout: 3_000 })
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 5_000 })
      .toMatch(/\/zh\/console\/me/)

    await context.close()
  }, 45_000)
})
