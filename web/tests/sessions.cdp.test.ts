import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Phone writes end to end (docs/remote-access.md "Writes"): enable writing,
// approve the device on the host, open a session, send a message, and see it
// arrive in the session's tmux pane. NEVER point this at real sessions: the
// relay under test must run with
//   WEZDECK_ATTENTION_FILE=$WEZDECK_TEST_ATTENTION
//   WEZDECK_REMOTE_DEVICES=$WEZDECK_TEST_DEVICES
// so the only session it knows is the throwaway tmux pane made here.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''
const devicesFile = process.env.WEZDECK_TEST_DEVICES ?? ''
// the relay under test runs with WEZDECK_REMOTE_UPLOADS=$WEZDECK_TEST_UPLOADS
const uploadsDir = process.env.WEZDECK_TEST_UPLOADS ?? ''
const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const repo = join(import.meta.dirname, '..', '..')
// A relay room keeps the throwaway host + browser off the real relay; start
// the test relay with WEZDECK_RELAY_URL=…/relay/host?room=$WEZDECK_REMOTE_ROOM.
const room = process.env.WEZDECK_REMOTE_ROOM ?? ''
const roomQuery = room ? `&room=${room}` : ''

describe.runIf(attention && devicesFile)('Phone writes into a session', () => {
  let browser: Browser
  const socket = join(mkdtempSync(join(tmpdir(), 'wd-tmux-')), 'sock')
  const tmux = (...args: Array<string>) =>
    execFileSync('tmux', ['-S', socket, ...args]).toString()
  const setStatus = (status: string) => {
    const pane = tmux(
      'display-message',
      '-p',
      '-t',
      'demo',
      '#{pane_id}',
    ).trim()
    writeFileSync(
      attention,
      JSON.stringify({
        entries: {
          'demo-session': {
            session_id: 'demo-session',
            tmux_socket: socket,
            tmux_session: 'demo',
            tmux_pane: pane,
            status,
            agent_name: 'demo-agent',
            last_user_prompt: '整理移动端交互',
            ts: Date.now(),
          },
        },
      }),
    )
  }

  beforeAll(async () => {
    tmux('new-session', '-d', '-s', 'demo', '-x', '120', '-y', '20', 'cat')
    writeFileSync(devicesFile, JSON.stringify({ approved: [], pending: [] }))
    setStatus('done')
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser.close()
    tmux('kill-server')
  })

  it('enable → approve → send arrives in the pane, also mid-turn', async () => {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me?remote=1${roomQuery}#pair=${token}`)
    // the compact link badge renders only after hydration: clicks land
    await page
      .locator('[data-testid=remote-badge-compact]')
      .waitFor({ timeout: 20_000 })
    await page.getByRole('button', { name: '启用写入' }).click()
    const command = page.locator('code', { hasText: '--approve' })
    await command.waitFor({ timeout: 20_000 })
    const id = ((await command.textContent()) ?? '').trim().split(' ').at(-1)
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    execFileSync(
      join(repo, 'scripts/dev/install-remote-relay.sh'),
      ['--approve', id ?? ''],
      {
        env: { ...process.env, WEZDECK_REMOTE_DEVICES: devicesFile },
      },
    )
    await page.getByRole('button', { name: '重新检查' }).click()
    await page.getByText('已启用').waitFor({ timeout: 15_000 })

    await page.goto(`${base}/zh/console/sessions`)
    await page.locator('[data-session=demo-session]').click()
    await page.waitForURL('**/console/sessions/demo-session')
    const box = page.getByLabel('发给 Agent 的消息')
    await box.fill('来自手机的消息')
    await page.getByRole('button', { name: '发送' }).click()
    await page.getByText(/条已送达/).waitFor({ timeout: 15_000 })
    const deadline = Date.now() + 5_000
    while (
      !tmux('capture-pane', '-p', '-t', 'demo').includes('来自手机的消息')
    ) {
      if (Date.now() > deadline)
        throw new Error('message never reached the pane')
      await page.waitForTimeout(200)
    }

    // the sticky composer rests flush with the scroller bottom, so starting
    // a drag never makes it jump down by the page padding
    const gap = await page.evaluate(() => {
      const form = document.querySelector('#session-composer')?.closest('form')
      const scroller = form?.closest('.overflow-y-auto')
      if (!form || !scroller) return -1
      return Math.round(
        scroller.getBoundingClientRect().bottom -
          form.getBoundingClientRect().bottom,
      )
    })
    expect(gap).toBe(0)

    // every hosted agent takes input mid-turn (queued / steered by its TUI)
    setStatus('running')
    await page.waitForTimeout(3_000) // let the page poll the new status
    await box.fill('运行中也能发')
    await page.getByRole('button', { name: '发送' }).click()
    const busyDeadline = Date.now() + 8_000
    while (!tmux('capture-pane', '-p', '-t', 'demo').includes('运行中也能发')) {
      if (Date.now() > busyDeadline)
        throw new Error('mid-turn message never reached the pane')
      await page.waitForTimeout(200)
    }

    // back from the background: the page refetches at once and says so
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page
      .locator('[data-testid=session-sync]')
      .waitFor({ timeout: 10_000 })
    // report a problem: diagnostics + a screenshot ride along as attachments
    if (uploadsDir) {
      await page.getByRole('button', { name: '诊断' }).click()
      expect(
        await page
          .getByRole('button', { name: '诊断' })
          .getAttribute('aria-pressed'),
      ).toBe('true')
      await page
        .locator('[data-testid=composer-tools] input[type=file]')
        .setInputFiles({
          name: 'shot.png',
          mimeType: 'image/png',
          buffer: onePixelPng,
        })
      await box.fill('键盘弹出时消息没跟上')
      await page.getByRole('button', { name: '发送' }).click()
      const fileDeadline = Date.now() + 20_000
      let screen = ''
      while (
        !(screen = tmux(
          'capture-pane',
          '-p',
          '-J',
          '-S',
          '-60',
          '-t',
          'demo',
        )).includes('图片: ')
      ) {
        if (Date.now() > fileDeadline)
          throw new Error(`attachments never reached the pane:\n${screen}`)
        await page.waitForTimeout(250)
      }
      expect(screen).toContain('[手机附件]')
      expect(screen).toContain('客户端诊断: ')
      const files = readdirSync(uploadsDir)
      const diag = files.find((name) => name.startsWith('diagnostics-'))
      expect(files.some((name) => /^img-.*\.jpg$/.test(name))).toBe(true)
      const snapshot = JSON.parse(
        readFileSync(join(uploadsDir, diag ?? ''), 'utf8'),
      ) as { viewport: unknown; events: Array<unknown>; page: string }
      expect(snapshot.viewport).toBeTruthy()
      expect(snapshot.events.length).toBeGreaterThan(0)
      expect(snapshot.page).not.toContain('#')
    }
    await context.close()
  }, 120_000)
})
