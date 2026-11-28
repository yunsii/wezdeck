// covers: web/src/features/foreground-sync.tsx web/src/features/console-shell.tsx
// covers: web/src/features/session-list.tsx web/src/features/session-header.tsx
// covers: web/src/features/console-sessions.tsx web/src/features/session-while-shown.ts
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium, devices } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''

async function wake(page: Page) {
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  )
}

describe('foreground sync status', () => {
  let browser: Browser
  let savedAttention = ''
  beforeAll(async () => {
    if (attention) {
      savedAttention = readFileSync(attention, 'utf8')
      writeFileSync(attention, JSON.stringify({ entries: {} }))
    }
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
    if (attention) writeFileSync(attention, savedAttention)
  })

  it('shows a brief list hint on wake and keeps the last time through failure', async () => {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/sessions?remote=1#pair=${token}`)
    await page.getByTestId('sticky-bar').waitFor()
    await page
      .getByText('现在没有正在运行的 Agent 会话。')
      .waitFor({ timeout: 20_000 })
    await expect
      .poll(() => page.getByTestId('foreground-sync-list').count())
      .toBe(0)
    expect(
      await page
        .locator('main[data-deck] > [data-testid=foreground-sync]')
        .count(),
    ).toBe(0)

    await wake(page)
    const status = page.getByTestId('foreground-sync-list')
    await expect
      .poll(() => status.getAttribute('data-state'), { timeout: 20_000 })
      .toBe('synced')
    expect(await status.innerText()).toMatch(/已同步 \d{2}:\d{2}/)
    await expect.poll(() => status.count(), { timeout: 5_000 }).toBe(0)

    await context.setOffline(true)
    await wake(page)
    await expect.poll(() => status.getAttribute('data-state')).toBe('failed')
    expect(await status.innerText()).toContain('上次成功')
    await expect.poll(() => status.count(), { timeout: 5_000 }).toBe(0)

    await context.setOffline(false)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect
      .poll(() => status.getAttribute('data-state'), { timeout: 20_000 })
      .toBe('synced')
    await context.close()
  }, 50_000)

  it('shows the list hint below the desktop split header', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/sessions?remote=1#pair=${token}`)
    await page.getByTestId('split-head').waitFor()
    await page
      .getByText('现在没有正在运行的 Agent 会话。')
      .waitFor({ timeout: 20_000 })
    const phases = await page.evaluate(async () => {
      const seen: Array<string> = []
      const observer = new MutationObserver(() => {
        const state = document
          .querySelector('[data-testid=foreground-sync-list]')
          ?.getAttribute('data-state')
        if (state && seen.at(-1) !== state) seen.push(state)
      })
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-state'],
      })
      document.dispatchEvent(new Event('visibilitychange'))
      await new Promise((resolve) => setTimeout(resolve, 500))
      observer.disconnect()
      return seen
    })
    expect(phases).toContain('loading')
    const status = page.getByTestId('foreground-sync-list')
    await expect
      .poll(() => status.getAttribute('data-state'), { timeout: 20_000 })
      .toBe('synced')
    const gap = await page.evaluate(() => {
      const head = document.querySelector('[data-testid=split-head]')!
      const hint = document.querySelector('[data-testid=foreground-sync-list]')!
      return (
        hint.getBoundingClientRect().top - head.getBoundingClientRect().bottom
      )
    })
    expect(gap).toBeGreaterThanOrEqual(-1)
    await context.close()
  }, 30_000)

  it.runIf(attention)(
    'shows detail status below the header without moving the thread',
    async () => {
      const socket = join(mkdtempSync(join(tmpdir(), 'wd-sync-')), 'sock')
      const tmux = (...args: Array<string>) =>
        execFileSync('tmux', ['-S', socket, ...args])
          .toString()
          .trim()
      const previous = readFileSync(attention, 'utf8')
      try {
        tmux(
          'new-session',
          '-d',
          '-s',
          'sync-demo',
          '-c',
          dirname(socket),
          'cat',
        )
        writeFileSync(
          attention,
          JSON.stringify({
            entries: {
              'sync-demo': {
                session_id: 'sync-demo',
                tmux_socket: socket,
                tmux_session: 'sync-demo',
                tmux_pane: tmux(
                  'display-message',
                  '-p',
                  '-t',
                  'sync-demo',
                  '#{pane_id}',
                ),
                status: 'running',
                agent_name: 'claude',
                last_user_prompt: 'sync status fixture',
                ts: Date.now(),
              },
            },
          }),
        )
        for (const width of [390, 1280]) {
          const context = await browser.newContext({
            viewport: { width, height: 800 },
            locale: 'zh-CN',
          })
          const page = await context.newPage()
          await page.goto(`${base}/zh/console/sessions?remote=1#pair=${token}`)
          await page
            .locator('[data-session=sync-demo]')
            .waitFor({ timeout: 20_000 })
          await page.locator('[data-session=sync-demo]').click()
          await page.getByTestId('session-header').waitFor()
          await expect
            .poll(() =>
              page.getByTestId('session-title').getAttribute('data-session-id'),
            )
            .toBe('sync-demo')
          await expect
            .poll(() => page.getByTestId('foreground-sync-detail').count())
            .toBe(0)
          const measure = () =>
            page.evaluate(() => {
              const header = document.querySelector(
                '[data-testid=session-header]',
              )!
              const thread = document.querySelector(
                '[data-testid=session-thread-scroll]',
              )!
              const composer = document.getElementById('session-composer')!
              return {
                headerHeight: header.getBoundingClientRect().height,
                threadTop: thread.getBoundingClientRect().top,
                composerTop: composer.getBoundingClientRect().top,
              }
            })
          const before = await measure()
          await wake(page)
          const status = page.getByTestId('foreground-sync-detail')
          await expect
            .poll(() => status.getAttribute('data-state'), { timeout: 20_000 })
            .toBe('synced')
          const during = await measure()
          expect(during).toEqual(before)
          const positions = await page.evaluate(() => {
            const header = document.querySelector(
              '[data-testid=session-header]',
            )!
            const hint = document.querySelector(
              '[data-testid=foreground-sync-detail]',
            )!
            return (
              hint.getBoundingClientRect().top -
              header.getBoundingClientRect().bottom
            )
          })
          expect(positions).toBeGreaterThanOrEqual(-1)
          expect(await page.getByTestId('foreground-sync-list').count()).toBe(0)
          await expect.poll(() => status.count(), { timeout: 5_000 }).toBe(0)
          await context.close()
        }
      } finally {
        writeFileSync(attention, previous)
        tmux('kill-server')
      }
    },
    70_000,
  )
})
