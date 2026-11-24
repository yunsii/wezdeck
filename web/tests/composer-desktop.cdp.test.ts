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
    // Space anywhere on the page puts the caret in the composer, no space typed
    await page.evaluate(() => (document.activeElement as HTMLElement).blur())
    await page.keyboard.press('Space')
    expect(await box.evaluate((el) => el === document.activeElement)).toBe(true)
    expect(await box.inputValue()).toBe('')
    // on a button Space still presses it (opens 快捷), focus stays there
    const keys = page.getByRole('button', { name: '快捷键', exact: true })
    await keys.focus()
    await page.keyboard.press('Space')
    await page.getByTestId('session-quick-keys').waitFor({ timeout: 2_000 })
    expect(await box.evaluate((el) => el === document.activeElement)).toBe(
      false,
    )
    await keys.click()
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
    // the image leaves [图片1] at the caret; removing it takes the token too
    await expect.poll(() => box.inputValue()).toBe('第一行\n第二行 [图片1] ')
    // the thumbnail is labelled 图片1; its label puts the token in again
    const label = page
      .getByTestId('composer-images')
      .getByRole('button', { name: '图片1', exact: true })
    await label.click()
    await expect
      .poll(() => box.inputValue())
      .toBe('第一行\n第二行 [图片1] [图片1] ')
    await box.fill('第一行\n第二行 [图片1] ')
    await page.getByRole('button', { name: '移除图片' }).click()
    await expect.poll(() => box.inputValue()).toBe('第一行\n第二行')

    await box.press('Enter')
    await expect.poll(() => box.inputValue(), { timeout: 2_000 }).toBe('')
    const deadline = Date.now() + 8_000
    while (!tmux('capture-pane', '-p', '-t', 'fresh').includes('第二行')) {
      if (Date.now() > deadline)
        throw new Error('message never reached the pane')
      await page.waitForTimeout(200)
    }

    // shortcuts: `?` and the sidebar entry open the list
    await page.evaluate(() => (document.activeElement as HTMLElement).blur())
    await page.keyboard.press('Shift+Slash')
    const keysSheet = page.getByTestId('keys-sheet')
    await keysSheet.waitFor({ timeout: 2_000 })
    expect(await keysSheet.innerText()).toContain('Alt+J')
    await page.keyboard.press('Escape')
    await keysSheet.waitFor({ state: 'hidden', timeout: 2_000 })
    await page.getByTestId('keys-entry').click()
    await keysSheet.waitFor({ timeout: 2_000 })
    await page.keyboard.press('Escape')
    await keysSheet.waitFor({ state: 'hidden', timeout: 2_000 })
    // focus came back to the entry; Esc lets go of it, then Space reaches
    // the composer instead of pressing the entry again
    await page.keyboard.press('Escape')
    expect(
      await page.evaluate(() => document.activeElement === document.body),
    ).toBe(true)
    await page.keyboard.press('Space')
    expect(await box.evaluate((el) => el === document.activeElement)).toBe(true)
    expect(await keysSheet.isVisible()).toBe(false)

    // Ctrl+N from inside the composer opens 新会话
    await box.click()
    await page.keyboard.press('Control+KeyN')
    const newSheet = page.getByTestId('new-session-sheet')
    await newSheet.waitFor({ timeout: 2_000 })
    await page.keyboard.press('Escape')
    await newSheet.waitFor({ state: 'hidden', timeout: 2_000 })

    // Alt+/ (the desk's pending overlay) opens the session picker
    await page.evaluate(() => (document.activeElement as HTMLElement).blur())
    await page.keyboard.press('Alt+Slash')
    const picker = page.getByTestId('session-switcher')
    await picker.waitFor({ timeout: 2_000 })
    await page.keyboard.press('Escape')

    await caretFollowsPreference(page)
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

/**
 * The caret: a block by default (the desk's terminal), a bar once picked in
 * 我的 › 外观, kept across a reload.
 */
async function caretFollowsPreference(page: Page) {
  const box = page.getByLabel('发给 Agent 的消息')
  const caret = () =>
    box.evaluate((el) => getComputedStyle(el).getPropertyValue('caret-shape'))
  expect(await caret()).toBe('block')
  await page.goto(`${base}/zh/console/me/appearance`)
  await page
    .getByRole('radiogroup', { name: '输入光标' })
    .getByRole('radio', { name: '细线' })
    .click()
  await page.goto(`${base}/zh/console/sessions/fresh-session`)
  await box.waitFor({ timeout: 15_000 })
  expect(await caret()).toBe('bar')
}
