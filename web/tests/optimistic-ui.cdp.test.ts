// covers: web/src/lib/optimistic-state.ts web/src/features/session-send.ts
// covers: web/src/features/session-permission.tsx web/src/features/session-elicitation.tsx
// covers: web/src/features/session-detail-read.ts web/src/features/session-delete-state.ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Verifies 0ms optimistic state transitions in a real browser against a
// throwaway relay stack whose pane runs `cat` (so the host NEVER clears
// waiting / flips attention.json to running on its own):
//   1. Sending a message flips thread TurnLine + list row to `running` at once.
//   2. Allowing a waiting prompt dismisses the card, switches to `running`,
//      and clears the list unread badge at once.
//   3. Denying a waiting prompt dismisses the card and unlocks the composer.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''
const devicesFile = process.env.WEZDECK_TEST_DEVICES ?? ''
const repo = join(import.meta.dirname, '..', '..')

describe.runIf(attention && devicesFile)('Optimistic session UI', () => {
  let browser: Browser
  const socket = join(mkdtempSync(join(tmpdir(), 'wd-opt-')), 'sock')
  const tmux = (...args: Array<string>) =>
    execFileSync('tmux', ['-S', socket, ...args])
      .toString()
      .trim()

  const panes: Record<string, string> = {}

  const writeEntries = (entries: Record<string, unknown>) =>
    writeFileSync(attention, JSON.stringify({ entries }))

  beforeAll(async () => {
    const agent = join(dirname(socket), 'claude')
    symlinkSync(execFileSync('which', ['cat']).toString().trim(), agent)
    const entries: Record<string, unknown> = {}
    for (const id of ['opt-send', 'opt-allow', 'opt-deny']) {
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
        agent,
      )
      panes[id] = tmux('display-message', '-p', '-t', id, '#{pane_id}')
    }
    const now = Date.now()
    entries['opt-send'] = {
      session_id: 'opt-send',
      tmux_socket: socket,
      tmux_session: 'opt-send',
      tmux_pane: panes['opt-send'],
      status: 'done',
      agent_name: 'claude',
      tmux_window_name: 'opt-send',
      last_user_prompt: 'earlier task',
      ts: now - 60_000,
    }
    entries['opt-allow'] = {
      session_id: 'opt-allow',
      tmux_socket: socket,
      tmux_session: 'opt-allow',
      tmux_pane: panes['opt-allow'],
      status: 'waiting',
      waiting_kind: 'permission_prompt',
      agent_name: 'claude',
      tmux_window_name: 'opt-allow',
      last_user_prompt: 'run tests',
      ts: now - 30_000,
    }
    entries['opt-deny'] = {
      session_id: 'opt-deny',
      tmux_socket: socket,
      tmux_session: 'opt-deny',
      tmux_pane: panes['opt-deny'],
      status: 'waiting',
      waiting_kind: 'permission_prompt',
      agent_name: 'claude',
      tmux_window_name: 'opt-deny',
      last_user_prompt: 'delete files',
      ts: now - 20_000,
    }
    writeEntries(entries)
    writeFileSync(devicesFile, JSON.stringify({ approved: [], pending: [] }))
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser.close()
    tmux('kill-server')
  })

  const approve = async (page: Page) => {
    await page.goto(`${base}/zh/console/me/writing?remote=1#pair=${token}`)
    await page.locator('main[data-remote-mode]').waitFor({ timeout: 20_000 })
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

  it('switches list tone and thread working state optimistically on send, allow, and deny', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await approve(page)

    // 1. Send message on a `done` session -> list row + thread switch to `running` immediately
    await page.goto(`${base}/zh/console/sessions/opt-send`)
    const sendRow = page.locator('[data-session=opt-send]')
    await sendRow.waitFor({ timeout: 20_000 })
    const box = page.getByLabel('发给 Agent 的消息')
    await box.click()
    await box.fill('乐观更新测试消息')
    await page.keyboard.press('Enter')

    await expect
      .poll(
        () => sendRow.getByTestId('chat-preview').getAttribute('data-tone'),
        {
          timeout: 3_000,
        },
      )
      .toBe('running')
    await expect
      .poll(() => sendRow.getByTestId('chat-preview').textContent(), {
        timeout: 3_000,
      })
      .toContain('乐观更新测试消息')
    await expect
      .poll(
        () => page.locator('[data-activity]').getAttribute('data-activity'),
        { timeout: 3_000 },
      )
      .toBe('working')

    // 2. Waiting prompt Allow (`1`) -> card dismisses, list tone flips waiting -> running
    await page.locator('[data-session=opt-allow]').click()
    await page.waitForURL('**/console/sessions/opt-allow')
    const allowRow = page.locator('[data-session=opt-allow]')
    const keysCard = page.getByTestId('session-permission-keys')
    await keysCard.waitFor({ timeout: 15_000 })
    expect(
      await allowRow.getByTestId('chat-preview').getAttribute('data-tone'),
    ).toBe('waiting')

    await keysCard.getByRole('button', { name: '1', exact: true }).click()
    await expect.poll(() => keysCard.count(), { timeout: 2_000 }).toBe(0)
    await expect
      .poll(
        () => allowRow.getByTestId('chat-preview').getAttribute('data-tone'),
        { timeout: 2_000 },
      )
      .toBe('running')
    expect(await allowRow.getByTestId('chat-unread').count()).toBe(0)

    // 3. Waiting prompt Deny (`Esc`) -> card dismisses AND composer unlocks immediately
    await page.locator('[data-session=opt-deny]').click()
    await page.waitForURL('**/console/sessions/opt-deny')
    const denyRow = page.locator('[data-session=opt-deny]')
    const denyCard = page.getByTestId('session-permission-keys')
    await denyCard.waitFor({ timeout: 15_000 })
    const sendBtn = page.getByRole('button', { name: '发送' })
    const denyBox = page.getByLabel('发给 Agent 的消息')
    await denyBox.fill('改用安全方案')
    // Blocked while waiting confirmation
    expect(await sendBtn.isDisabled()).toBe(true)

    await denyCard.getByRole('button', { name: 'Esc' }).click()
    await expect.poll(() => denyCard.count(), { timeout: 2_000 }).toBe(0)
    await expect
      .poll(() => sendBtn.isDisabled(), { timeout: 2_000 })
      .toBe(false)
    await expect
      .poll(
        () => denyRow.getByTestId('chat-preview').getAttribute('data-tone'),
        { timeout: 2_000 },
      )
      .toBe('idle')

    await context.close()
  }, 90_000)
})
