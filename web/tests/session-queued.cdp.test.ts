// covers: web/src/features/session-send.ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// A message the host queued (not in the transcript until the agent takes
// it) stays on screen across a switch: the faded bubble used to live in the
// session page's state, which remounts on every switch, so after switching
// away and back the message was nowhere in the web console (2026-11-24).
// remote-test-stack.sh only (throwaway attention / devices files, tmux
// panes made here).
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''
const devicesFile = process.env.WEZDECK_TEST_DEVICES ?? ''
const repo = join(import.meta.dirname, '..', '..')

describe.runIf(attention && devicesFile)(
  'Queued messages across a switch',
  () => {
    let browser: Browser
    const socket = join(mkdtempSync(join(tmpdir(), 'wd-q-')), 'sock')
    const tmux = (...args: Array<string>) =>
      execFileSync('tmux', ['-S', socket, ...args])
        .toString()
        .trim()

    beforeAll(async () => {
      const entries: Record<string, unknown> = {}
      for (const id of ['q-a', 'q-b']) {
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
          '20',
          'cat',
        )
        entries[id] = {
          session_id: id,
          tmux_socket: socket,
          tmux_session: id,
          tmux_pane: tmux('display-message', '-p', '-t', id, '#{pane_id}'),
          status: 'done',
          agent_name: 'claude',
          tmux_window_name: id,
          last_user_prompt: `prompt ${id}`,
          ts: Date.now() - 600_000,
        }
      }
      writeFileSync(attention, JSON.stringify({ entries }))
      writeFileSync(devicesFile, JSON.stringify({ approved: [], pending: [] }))
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser.close()
      tmux('kill-server')
    })

    const approve = async (page: Page) => {
      await page.goto(`${base}/zh/console/me/writing?remote=1#pair=${token}`)
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

    it('the faded bubble is still there after switching away and back', async () => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        locale: 'zh-CN',
      })
      const page = await context.newPage()
      await approve(page)
      await page.goto(`${base}/zh/console/sessions/q-a`)
      await page.locator('[data-session=q-b]').waitFor({ timeout: 20_000 })
      const box = page.getByLabel('发给 Agent 的消息')
      await box.click()
      await box.fill('排队中的消息 q-a')
      await page.keyboard.press('Enter')
      const bubble = page.locator('[data-pending]', {
        hasText: '排队中的消息 q-a',
      })
      await bubble.waitFor({ timeout: 15_000 })
      // away and back: the page remounts for each session
      await page.locator('[data-session=q-b]').click()
      await page.waitForURL('**/console/sessions/q-b')
      expect(await page.locator('[data-pending]').count()).toBe(0)
      await page.locator('[data-session=q-a]').click()
      await page.waitForURL('**/console/sessions/q-a')
      await bubble.waitFor({ timeout: 5_000 })
      await context.close()
    }, 90_000)
  },
)
