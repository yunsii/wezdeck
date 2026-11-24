// covers: web/src/features/session-composer.tsx web/src/features/chat-scroll.ts
// covers: web/src/features/console-sessions.tsx
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The composer and thread on a desktop browser: a new session with no
// messages yet (only the pane's screen) lands at the bottom; Enter sends,
// Shift+Enter breaks the line, an IME's Enter does neither; a pasted
// screenshot joins the picked images. On a touch phone Enter is a new line.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''
const devicesFile = process.env.WEZDECK_TEST_DEVICES ?? ''
const repo = join(import.meta.dirname, '..', '..')
const room = process.env.WEZDECK_REMOTE_ROOM ?? ''
const roomQuery = room ? `&room=${room}` : ''

describe.runIf(attention && devicesFile)('Composer on a desktop', () => {
  let browser: Browser
  const socket = join(mkdtempSync(join(tmpdir(), 'wd-tmux-')), 'sock')
  const tmux = (...args: Array<string>) =>
    execFileSync('tmux', ['-S', socket, ...args]).toString()

  beforeAll(async () => {
    // a tall screen and no transcript: the page shows the screen only
    tmux('new-session', '-d', '-s', 'fresh', '-x', '120', '-y', '80', 'cat')
    for (let i = 1; i <= 70; i++)
      tmux('send-keys', '-t', 'fresh', '-l', `line ${i}\n`)
    const pane = tmux(
      'display-message',
      '-p',
      '-t',
      'fresh',
      '#{pane_id}',
    ).trim()
    writeFileSync(
      attention,
      JSON.stringify({
        entries: {
          'fresh-session': {
            session_id: 'fresh-session',
            tmux_socket: socket,
            tmux_session: 'fresh',
            tmux_pane: pane,
            status: 'done',
            agent_name: 'fresh-agent',
            ts: Date.now(),
          },
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
    await page
      .locator('[data-testid=remote-badge-compact]')
      .first()
      .waitFor({ timeout: 20_000 })
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

  const fromBottom = (page: Page) =>
    page.evaluate(() => {
      const scroller = document
        .querySelector('#session-composer')
        ?.closest('.overflow-y-auto')
      if (!scroller) return -1
      return Math.round(
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      )
    })

  it('lands at the bottom, Enter sends, Shift+Enter breaks, paste adds an image', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await approve(page)
    await page.goto(`${base}/zh/console/sessions/fresh-session`)
    await page.getByText('line 70').waitFor({ timeout: 15_000 })
    // the screen is taller than the window: the page must sit at its end
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const s = document
              .querySelector('#session-composer')
              ?.closest('.overflow-y-auto')
            return s ? s.scrollHeight > s.clientHeight + 100 : false
          }),
        { timeout: 5_000 },
      )
      .toBe(true)
    await expect
      .poll(() => fromBottom(page), { timeout: 5_000 })
      .toBeLessThan(4)

    const box = page.getByLabel('发给 Agent 的消息')
    await box.click()
    await box.pressSequentially('第一行')
    await page.keyboard.press('Shift+Enter')
    await box.pressSequentially('第二行')
    expect(await box.inputValue()).toBe('第一行\n第二行')
    // an IME's Enter confirms a candidate, it does not send
    await box.evaluate((el) =>
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    )
    expect(await box.inputValue()).toBe('第一行\n第二行')

    // a screenshot pasted into the box joins the images
    await box.evaluate((el) => {
      const png = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        ),
        (c) => c.charCodeAt(0),
      )
      const data = new DataTransfer()
      data.items.add(new File([png], 'shot.png', { type: 'image/png' }))
      el.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    await expect
      .poll(() => page.locator('[data-testid=composer-images] img').count())
      .toBe(1)
    await page.getByRole('button', { name: '移除图片' }).click()

    await box.press('Enter')
    await expect.poll(() => box.inputValue(), { timeout: 2_000 }).toBe('')
    const deadline = Date.now() + 8_000
    while (!tmux('capture-pane', '-p', '-t', 'fresh').includes('第二行')) {
      if (Date.now() > deadline)
        throw new Error('message never reached the pane')
      await page.waitForTimeout(200)
    }
    await context.close()
  })

  it('on a touch phone Enter is a new line', async () => {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await approve(page)
    await page.goto(`${base}/zh/console/sessions/fresh-session`)
    const box = page.getByLabel('发给 Agent 的消息')
    await box.waitFor({ timeout: 15_000 })
    await box.click()
    await box.pressSequentially('甲')
    await page.keyboard.press('Enter')
    await box.pressSequentially('乙')
    expect(await box.inputValue()).toBe('甲\n乙')
    expect(await box.getAttribute('enterkeyhint')).toBe('enter')
    await context.close()
  })
})
