// Core pre-deploy availability smoke test (L0 release gate).
// Covers the minimal invariant that must NEVER break in production:
//   1. Open Web console with zero uncaught pageerror
//   2. Connect to HostRelay over WS + approve device key
//   3. Load session list + open a live session
//   4. Send a message through the composer and verify it reaches the tmux pane
//   5. Send an interactive key while the session waits on a prompt
// Intentionally excludes slow / visual-animation assertions so the release gate
// finishes in ~15-25 s and never flakes on unrelated layout checks.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3019'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''
const devicesFile = process.env.WEZDECK_TEST_DEVICES ?? ''
const repo = join(import.meta.dirname, '..', '..')
const room = process.env.WEZDECK_REMOTE_ROOM ?? ''
const roomQuery = room ? `&room=${room}` : ''

describe.runIf(attention && devicesFile)(
  'Release L0 smoke: core conversation availability',
  () => {
    let browser: Browser
    const socket = join(mkdtempSync(join(tmpdir(), 'wd-smoke-tmux-')), 'sock')
    const tmux = (...args: Array<string>) =>
      execFileSync('tmux', ['-S', socket, ...args]).toString()

    const writeSession = (status: string, waitingKind = '') => {
      const pane = tmux(
        'display-message',
        '-p',
        '-t',
        'smoke',
        '#{pane_id}',
      ).trim()
      writeFileSync(
        attention,
        JSON.stringify({
          entries: {
            'smoke-session': {
              session_id: 'smoke-session',
              tmux_socket: socket,
              tmux_session: 'smoke',
              tmux_pane: pane,
              status,
              waiting_kind: waitingKind,
              agent_name: 'smoke-agent',
              last_user_prompt: '核心对话可用性冒烟检查',
              ts: Date.now(),
            },
          },
        }),
      )
    }

    beforeAll(async () => {
      const bin = mkdtempSync(join(tmpdir(), 'wd-smoke-bin-'))
      symlinkSync(
        execFileSync('which', ['cat']).toString().trim(),
        join(bin, 'claude'),
      )
      tmux(
        'new-session',
        '-d',
        '-s',
        'smoke',
        '-x',
        '120',
        '-y',
        '20',
        join(bin, 'claude'),
      )
      writeFileSync(devicesFile, JSON.stringify({ approved: [], pending: [] }))
      writeSession('done')
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser.close()
      try {
        tmux('kill-server')
      } catch {
        // already stopped
      }
    })

    it('connects, authenticates, reads sessions, and sends a conversation message', async () => {
      const context = await browser.newContext({
        ...devices['iPhone 13'],
        locale: 'zh-CN',
      })
      const page = await context.newPage()
      const pageErrors: Array<string> = []
      page.on('pageerror', (err) => pageErrors.push(err.message))

      // 1. Connect over relay WS & approve device write key
      await page.goto(
        `${base}/zh/console/me/writing?remote=1${roomQuery}#pair=${token}`,
      )
      await page.locator('main[data-remote-mode]').waitFor({ timeout: 20_000 })
      await page.getByRole('button', { name: '申请授权' }).click()
      const command = page.locator('code', { hasText: '--approve' })
      await command.waitFor({ timeout: 20_000 })
      const id = ((await command.textContent()) ?? '').trim().split(' ').at(-1)
      expect(id).toMatch(/^[0-9a-f]{16}$/)
      execFileSync(
        join(repo, 'scripts/dev/install-remote-relay.sh'),
        ['--approve', id ?? ''],
        { env: { ...process.env, WEZDECK_REMOTE_DEVICES: devicesFile } },
      )
      await page.getByRole('button', { name: '重新检查' }).click()
      await page.getByText(/^已获批。/).waitFor({ timeout: 15_000 })

      // 2. Load session list & open the smoke session
      await page.goto(`${base}/zh/console/sessions`)
      await page.locator('[data-session=smoke-session]').click()
      await page.waitForURL('**/console/sessions/smoke-session')

      // 3. Send a message & verify it reaches the host tmux pane
      const marker = `SMOKE_OK_${Date.now()}`
      const box = page.getByLabel('发给 Agent 的消息')
      await box.fill(marker)
      await page.getByRole('button', { name: '发送' }).click()
      await expect.poll(() => box.inputValue(), { timeout: 2_000 }).toBe('')
      const bubble = page.locator('[data-pending]', { hasText: marker })
      await bubble.waitFor({ timeout: 2_000 })
      await expect
        .poll(() => bubble.getAttribute('data-pending'), { timeout: 15_000 })
        .toBe('queued')

      const deadline = Date.now() + 8_000
      while (!tmux('capture-pane', '-p', '-t', 'smoke').includes(marker)) {
        if (Date.now() > deadline) {
          throw new Error('smoke message never reached tmux pane')
        }
        await page.waitForTimeout(200)
      }

      // 4. Verify interactive prompt key write path works when waiting
      writeSession('waiting', 'permission_prompt')
      const allowBtn = page.getByRole('button', { name: /允许|1/ }).first()
      await allowBtn.waitFor({ timeout: 10_000 })
      await allowBtn.click()
      const keyDeadline = Date.now() + 8_000
      while (!tmux('capture-pane', '-p', '-t', 'smoke').includes('1')) {
        if (Date.now() > keyDeadline) {
          throw new Error('smoke interactive key never reached tmux pane')
        }
        await page.waitForTimeout(200)
      }

      expect(pageErrors).toEqual([])
      await context.close()
    })
  },
)
