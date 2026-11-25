// covers: web/src/features/session-composer.tsx web/src/features/chat-scroll.ts
// covers: web/src/features/console-sessions.tsx
// covers: web/src/lib/use-draft.ts web/src/features/composer-images.ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from '@playwright/test'
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test'
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
  /** (re)register the fresh session; viewing a done one acks it into recent */
  let seed = (_status = 'done') => {}

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
    seed = (status = 'done') =>
      writeFileSync(
        attention,
        JSON.stringify({
          entries: {
            'fresh-session': {
              session_id: 'fresh-session',
              tmux_socket: socket,
              tmux_session: 'fresh',
              tmux_pane: pane,
              status,
              agent_name: 'fresh-agent',
              ts: Date.now(),
            },
          },
        }),
      )
    seed()
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
    await pickSurvivesReload(page)
    // the thumbnail is labelled 图片1; its label puts the token in again
    const label = page
      .getByTestId('composer-images')
      .getByRole('button', { name: '图片1', exact: true })
    await label.click()
    await expect
      .poll(() => box.inputValue())
      .toBe('第一行\n第二行 [图片1] [图片1] ')
    await caretAtEnd(box)
    await box.fill('第一行\n第二行 [图片1] ')
    // Backspace takes the space, then the whole token in one press
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    expect(await box.inputValue()).toBe('第一行\n第二行 ')
    await box.fill('第一行\n第二行 [图片1] ')
    await page.getByRole('button', { name: '移除图片' }).click()
    await expect.poll(() => box.inputValue()).toBe('第一行\n第二行')

    await box.press('Enter')
    await expect.poll(() => box.inputValue(), { timeout: 2_000 }).toBe('')
    // working shows at once (optimistic), not after the host's next poll
    await page.locator('[data-activity=working]').waitFor({ timeout: 1_500 })
    const deadline = Date.now() + 8_000
    while (!tmux('capture-pane', '-p', '-t', 'fresh').includes('第二行')) {
      if (Date.now() > deadline)
        throw new Error('message never reached the pane')
      await page.waitForTimeout(200)
    }

    await shortcutsSheet(page)

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

  it('clear: × with undo, Esc Esc; a send left mid-upload keeps no draft', async () => {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      locale: 'zh-CN',
    })
    await holdUploads(context)
    seed('running') // not acked away while the page shows it
    const page = await context.newPage()
    await approve(page)
    await clearThenLeaveMidUpload(page)
    await context.close()
  }, 45_000)

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
 * The caret: the browser's bar by default, a block once picked in 我的 › 外观,
 * kept across a reload.
 */
async function caretFollowsPreference(page: Page) {
  const box = page.getByLabel('发给 Agent 的消息')
  const caret = () =>
    box.evaluate((el) => getComputedStyle(el).getPropertyValue('caret-shape'))
  expect(await caret()).toBe('bar')
  await page.goto(`${base}/zh/console/me/appearance`)
  await page
    .getByRole('radiogroup', { name: '输入光标' })
    .getByRole('radio', { name: '方块' })
    .click()
  await page.goto(`${base}/zh/console/sessions/fresh-session`)
  await box.waitFor({ timeout: 15_000 })
  expect(await caret()).toBe('block')
}

/**
 * The caret lands after an inserted token on the next frame: wait for it,
 * or a following fill's select-all is undone by it and the text doubles.
 */
async function caretAtEnd(box: Locator) {
  await expect
    .poll(() =>
      box.evaluate(
        (el: HTMLTextAreaElement) =>
          el === document.activeElement &&
          el.selectionStart === el.value.length,
      ),
    )
    .toBe(true)
}

/** a reload keeps the picture with the draft, not only its [图片1] */
async function pickSurvivesReload(page: Page) {
  const box = page.getByLabel('发给 Agent 的消息')
  await page.reload()
  await box.waitFor({ timeout: 15_000 })
  await expect
    .poll(() => page.locator('[data-testid=composer-images] img').count(), {
      timeout: 5_000,
    })
    .toBe(1)
  expect(await box.inputValue()).toBe('第一行\n第二行 [图片1] ')
  await box.click()
}

/**
 * `?` and the sidebar entry open the shortcut list; Esc closes it, a second
 * Esc lets go of the entry, and Space then reaches the composer.
 */
async function shortcutsSheet(page: Page) {
  const box = page.getByLabel('发给 Agent 的消息')
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
}

/**
 * × clears with an undo, Esc Esc clears; a send with an image left at once
 * (upload still running) keeps no draft — the composer cleared through a
 * state updater that never ran once the page was gone.
 */
async function clearThenLeaveMidUpload(page: Page) {
  await page.goto(`${base}/zh/console/sessions/fresh-session`)
  const box = page.getByLabel('发给 Agent 的消息')
  await box.waitFor({ timeout: 15_000 })
  const clear = page.getByTestId('composer-clear')
  expect(await clear.count()).toBe(0)
  await box.fill('要清掉的草稿')
  await clear.click()
  expect(await box.inputValue()).toBe('')
  expect(
    await page.evaluate(() =>
      localStorage.getItem('wezdeck.draft.fresh-session'),
    ),
  ).toBeNull()
  // the toast drops in under the session's top bar, not over its back
  // button (polled: it slides in from above)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const toast = document.querySelector('[data-sonner-toast]')
        const head = document.querySelector('[data-testid=session-header]')
        return toast && head
          ? toast.getBoundingClientRect().top >=
              head.getBoundingClientRect().bottom - 1
          : null
      }),
    )
    .toBe(true)
  await page.getByRole('button', { name: '撤销' }).click()
  await expect.poll(() => box.inputValue()).toBe('要清掉的草稿')
  // Esc Esc (a keyboard on the phone): one Esc keeps it, two clear it
  await box.press('Escape')
  expect(await box.inputValue()).toBe('要清掉的草稿')
  await box.press('Escape')
  await expect.poll(() => box.inputValue()).toBe('')

  // the clear toasts sit over the header: let them go before the send
  await page.locator('[data-sonner-toast]').first().waitFor({
    state: 'detached',
    timeout: 10_000,
  })
  // send with an image and leave at once (the upload still running):
  // coming back finds an empty composer, not the sent message
  await box.fill('带图的消息 ')
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
  const back = page.getByRole('button', { name: '会话', exact: true })
  await page.evaluate(() => {
    const send = document.querySelector<HTMLButtonElement>(
      'button[type=submit][aria-label="发送"]',
    )
    send?.click()
  })
  await back.click()
  // and straight back in while the upload is still held (in-app, no reload)
  await page.locator('[data-session=fresh-session]').click()
  await page.waitForURL('**/console/sessions/fresh-session')
  await box.waitFor({ timeout: 15_000 })
  await page.waitForTimeout(500) // saved picks load from IndexedDB
  const empty = async (when: string) => {
    expect(await box.inputValue(), when).toBe('')
    expect(
      await page.locator('[data-testid=composer-images] img').count(),
      when,
    ).toBe(0)
    expect(
      await page.evaluate(() =>
        localStorage.getItem('wezdeck.draft.fresh-session'),
      ),
      when,
    ).toBeNull()
  }
  await empty('back in mid-upload')
  await page.waitForTimeout(3_000) // the upload and send finish meanwhile
  await empty('after the send')
  // a fresh load reads only what was stored
  await page.reload()
  await box.waitFor({ timeout: 15_000 })
  await page.waitForTimeout(800)
  await empty('after a reload')
}

/** hold every upload frame 1.5 s, so the page can be left while one runs */
async function holdUploads(context: BrowserContext) {
  await context.addInitScript(() => {
    type Send = (this: unknown, data: unknown) => void
    for (const proto of [WebSocket.prototype, RTCDataChannel.prototype]) {
      const target = proto as unknown as { send: Send }
      const send = target.send
      target.send = function (data) {
        if (typeof data === 'string' && data.includes('"upload"'))
          setTimeout(() => send.call(this, data), 1_500)
        else send.call(this, data)
      }
    }
  })
}
