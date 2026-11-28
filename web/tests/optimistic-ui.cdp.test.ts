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

async function installPermissionSettleWatch(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    const stats = {
      promptFlashes: 0,
      listWaitingBounces: 0,
      statusbarShifts: 0,
    }
    w.__permSettleStats = stats
    const observer = new MutationObserver(() => {
      if (
        document.querySelector(
          '[data-testid="session-permission-keys"], [data-testid="permission-card"]',
        )
      ) {
        stats.promptFlashes += 1
      }
      const tone = document
        .querySelector(
          '[data-session="opt-allow"] [data-testid="chat-preview"]',
        )
        ?.getAttribute('data-tone')
      if (tone === 'waiting') {
        stats.listWaitingBounces += 1
      }
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-tone'],
    })
    const po = new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const entry = raw as PerformanceEntry & {
          value: number
          hadRecentInput: boolean
          sources?: Array<{ node?: Node | null }>
        }
        if (entry.hadRecentInput || entry.value < 0.001) continue
        const hit = (entry.sources ?? []).some(
          (src) =>
            src.node instanceof HTMLElement &&
            Boolean(src.node.closest('[data-testid="session-statusbar"]')),
        )
        if (hit) stats.statusbarShifts += 1
      }
    })
    po.observe({ type: 'layout-shift', buffered: false })
    w.__stopPermSettleWatch = () => {
      observer.disconnect()
      po.disconnect()
    }
  })
}

async function readPermissionSettleWatch(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    ;(w.__stopPermSettleWatch as (() => void) | undefined)?.()
    return w.__permSettleStats as {
      promptFlashes: number
      listWaitingBounces: number
      statusbarShifts: number
    }
  })
}

function buildFixtureEntries(
  socket: string,
  panes: Record<string, string>,
  now: number,
  allowRunning = false,
): Record<string, unknown> {
  return {
    'opt-send': {
      session_id: 'opt-send',
      tmux_socket: socket,
      tmux_session: 'opt-send',
      tmux_pane: panes['opt-send'],
      status: 'done',
      agent_name: 'claude',
      tmux_window_name: 'opt-send',
      last_user_prompt: 'earlier task',
      ts: now - 60_000,
    },
    'opt-idle': {
      session_id: 'opt-idle',
      tmux_socket: socket,
      tmux_session: 'opt-idle',
      tmux_pane: panes['opt-idle'],
      status: 'idle',
      agent_name: 'claude',
      tmux_window_name: 'opt-idle',
      last_user_prompt: 'idle task',
      ts: now - 120_000,
    },
    'opt-allow': {
      session_id: 'opt-allow',
      tmux_socket: socket,
      tmux_session: 'opt-allow',
      tmux_pane: panes['opt-allow'],
      status: allowRunning ? 'running' : 'waiting',
      ...(allowRunning ? {} : { waiting_kind: 'permission_prompt' }),
      agent_name: 'claude',
      tmux_window_name: 'opt-allow',
      last_user_prompt: 'run tests',
      ts: allowRunning ? now : now - 30_000,
    },
    'opt-deny': {
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
    },
  }
}

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
    for (const id of ['opt-send', 'opt-allow', 'opt-deny', 'opt-idle']) {
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
    writeEntries(buildFixtureEntries(socket, panes, Date.now(), false))
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

    // 2b. Host confirms Allow (waiting → running) across staggered detail/list polls:
    //     permission card and composer-blocked notice must NEVER flash back in,
    //     TurnLine must stay mounted, and list tone must never bounce back to waiting.
    await installPermissionSettleWatch(page)
    writeEntries(buildFixtureEntries(socket, panes, Date.now(), true))
    // Wait through both detail (1s) and list settlement polls
    await page.waitForTimeout(2_500)
    expect(await readPermissionSettleWatch(page)).toEqual({
      promptFlashes: 0,
      listWaitingBounces: 0,
      statusbarShifts: 0,
    })

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

    // 4. Phone flow: send on an idle session, immediately navigate back to the
    //    list, and verify the row stays `running` even across list polls where
    //    tmux window_activity bumped card.ts while host status is still `idle`.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${base}/zh/console/sessions/opt-idle`)
    const phoneBox = page.getByLabel('发给 Agent 的消息')
    await phoneBox.waitFor({ timeout: 15_000 })
    await phoneBox.click()
    await phoneBox.fill('手机发完立刻回列表')
    await page.getByRole('button', { name: '发送' }).click()
    // Navigate back to the session list right after send
    await page.getByRole('button', { name: '会话', exact: true }).click()
    await page.waitForURL('**/console/sessions')
    const phoneRow = page.locator('[data-session=opt-idle]')
    await phoneRow.waitFor({ timeout: 10_000 })
    await expect
      .poll(
        () => phoneRow.getByTestId('chat-preview').getAttribute('data-tone'),
        { timeout: 3_000 },
      )
      .toBe('running')
    // Hold across a 1.5s list refetch while host still reports idle
    await page.waitForTimeout(2_000)
    expect(
      await phoneRow.getByTestId('chat-preview').getAttribute('data-tone'),
    ).toBe('running')
    expect(await phoneRow.getByTestId('chat-preview').textContent()).toContain(
      '手机发完立刻回列表',
    )

    await context.close()
  }, 90_000)
})
