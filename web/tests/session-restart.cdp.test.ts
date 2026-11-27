// covers: web/src/features/session-header.tsx web/src/features/session-restart.tsx web/src/features/session-key-panel.tsx
// covers: web/src/features/session-handoff.tsx
// covers: native/wezdeck-wsl/session_restart.go native/wezdeck-wsl/session_handoff.go
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 按键 › 重启会话 / 新开会话 (session-restart.tsx → relay session.restart).
// The test stack's stand-in for session-restart.sh only records each call
// (restart.log) and, for a fresh start, names a new conversation; the real
// script is covered by session_restart_test.go. Both ask first, in the panel (no browser dialog); after a fresh
// start the host marks the old entry cleared_to the new id — written here
// the way the script does — and the page follows.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''
const devicesFile = process.env.WEZDECK_TEST_DEVICES ?? ''
const stack = process.env.WEZDECK_TEST_STACK_DIR ?? ''
const repo = join(import.meta.dirname, '..', '..')
const NEW_ID = '00000000-0000-4000-8000-000000000001'

async function checkComposerInset(page: Page) {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 })
    const inset = await page.evaluate(() => {
      const field =
        document.querySelector<HTMLTextAreaElement>('#session-composer')
      const button = document.querySelector<HTMLElement>(
        '[data-testid=composer-tools-button]',
      )
      if (!field || !button) return null
      return {
        gap:
          field.getBoundingClientRect().left +
          parseFloat(getComputedStyle(field).paddingLeft) -
          button.getBoundingClientRect().right,
        padding: parseFloat(getComputedStyle(field).paddingLeft),
      }
    })
    expect(inset?.padding).toBe(44)
    expect(inset?.gap).toBeGreaterThanOrEqual(1)
  }
}

async function checkTitleGeometry(browser: Browser, page: Page) {
  const firstPaint = await browser.newPage({
    javaScriptEnabled: false,
    locale: 'zh-CN',
  })
  const geometry = (target: Page) =>
    target.evaluate(() => {
      const header = document.querySelector('[data-testid=session-header]')!
      const title = document.querySelector('[data-testid=session-title]')!
      return {
        height: header.getBoundingClientRect().height,
        titleWidth: title.getBoundingClientRect().width,
      }
    })
  try {
    for (const width of [1280, 390]) {
      const viewport = { width, height: 800 }
      await firstPaint.setViewportSize(viewport)
      await firstPaint.goto(page.url())
      await page.setViewportSize(viewport)
      await expect
        .poll(() => geometry(page))
        .toEqual(await geometry(firstPaint))
    }
  } finally {
    await firstPaint.close()
  }
}

async function checkDesktopShortcuts(page: Page) {
  expect(await page.locator('[data-restart=new] kbd').isVisible()).toBe(true)
  expect(
    await page.locator('[data-restart=new]').getAttribute('aria-keyshortcuts'),
  ).toBe('Control+N Meta+N')
  expect(await page.locator('[data-restart=fresh] kbd').innerText()).toContain(
    'Ctrl/⌘+Shift+N',
  )
  expect(await page.locator('[data-restart=resume] kbd').innerText()).toBe(
    'Alt+R',
  )
  expect(
    await page.locator('button[aria-label="发送"]').getAttribute('title'),
  ).toContain('Ctrl/⌘+Enter')
}

async function checkWebRestartKey(
  page: Page,
  calls: () => Array<string>,
  pane: string,
) {
  const sheet = page.getByTestId('session-actions-sheet')
  await sheet.getByRole('button', { name: '关闭' }).click()
  await sheet.waitFor({ state: 'hidden' })
  const url = page.url()
  await page.keyboard.press('Alt+R')
  await expect.poll(calls, { timeout: 10_000 }).toHaveLength(1)
  expect(calls()[0]).toBe(`--pane ${pane} --agent claude`)
  expect(page.url()).toBe(url)
}

describe.runIf(attention && devicesFile && stack)(
  'Restart and new conversation',
  // Restart and handoff cases share one tmux fixture.
  // eslint-disable-next-line max-lines-per-function
  () => {
    let browser: Browser
    const dir = mkdtempSync(join(tmpdir(), 'wd-restart-'))
    const socket = join(dir, 'sock')
    const log = join(stack, 'restart.log')
    const handoffLog = join(stack, 'handoff.log')
    const tmux = (...args: Array<string>) =>
      execFileSync('tmux', ['-S', socket, ...args]).toString()
    let pane = ''
    const entry = () => ({
      session_id: 'restart-s1',
      tmux_socket: socket,
      tmux_session: 'restart',
      tmux_pane: pane,
      status: 'running',
      agent_name: 'claude',
      ts: Date.now(),
    })

    beforeAll(async () => {
      // a pane whose command is named claude: the page offers the actions
      // for agent sessions only
      symlinkSync(
        execFileSync('which', ['cat']).toString().trim(),
        join(dir, 'claude'),
      )
      tmux(
        'new-session',
        '-d',
        '-s',
        'restart',
        '-x',
        '100',
        '-y',
        '30',
        join(dir, 'claude'),
      )
      pane = tmux('display-message', '-p', '-t', 'restart', '#{pane_id}').trim()
      writeFileSync(
        attention,
        JSON.stringify({ entries: { 'restart-s1': entry() } }),
      )
      writeFileSync(devicesFile, JSON.stringify({ approved: [], pending: [] }))
      rmSync(log, { force: true })
      rmSync(handoffLog, { force: true })
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser.close()
      tmux('kill-server')
    })

    it('asks first, then restarts the pane or starts fresh and follows', async () => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        locale: 'zh-CN',
      })
      const page = await context.newPage()
      await page.goto(`${base}/zh/console/me/writing?remote=1#pair=${token}`)
      await page.locator('main[data-remote-mode]').waitFor({ timeout: 20_000 })
      await page.getByRole('button', { name: '申请授权' }).click()
      const command = page.locator('code', { hasText: '--approve' })
      await command.waitFor({ timeout: 20_000 })
      const id = ((await command.textContent()) ?? '').trim().split(' ').at(-1)
      execFileSync(
        join(repo, 'scripts/dev/install-remote-relay.sh'),
        ['--approve', id ?? ''],
        {
          env: { ...process.env, WEZDECK_REMOTE_DEVICES: devicesFile },
        },
      )
      await page.getByRole('button', { name: '重新检查' }).click()
      await page.getByText(/^已获批。/).waitFor({ timeout: 15_000 })

      await page.goto(`${base}/zh/console/sessions/restart-s1`)
      await checkComposerInset(page)
      await page.getByTestId('session-statusbar').waitFor()
      await checkTitleGeometry(browser, page)
      await page.setViewportSize({ width: 390, height: 844 })
      const layout = () =>
        page.evaluate(() => {
          const field = document.querySelector('[data-text-field="true"]')
          const form = field?.closest('form')
          if (!field || !form) return null
          const f = field.getBoundingClientRect()
          const c = form.getBoundingClientRect()
          return { offset: f.top - c.top, formHeight: c.height }
        })
      const beforeMenus = await layout()
      await page.getByTestId('session-todos-button').click()
      await page.getByTestId('todo-panel').waitFor()
      expect(await layout()).toEqual(beforeMenus)
      await page.keyboard.press('Escape')
      await page.getByTestId('composer-tools-button').click()
      await page.getByTestId('composer-tools').waitFor()
      expect(await layout()).toEqual(beforeMenus)
      await page.keyboard.press('Escape')
      const openKeys = async () => {
        await page.getByTestId('session-actions-button').click()
        await page.getByTestId('session-restart').waitFor({ timeout: 15_000 })
      }
      const calls = () => {
        try {
          return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
        } catch {
          return []
        }
      }
      const handoffCalls = () => {
        try {
          return readFileSync(handoffLog, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
        } catch {
          return []
        }
      }
      // no browser dialog: the question is asked in the panel
      let dialogs = 0
      page.on('dialog', (dialog) => {
        dialogs++
        void dialog.dismiss()
      })
      await openKeys()
      const confirm = page.getByTestId('session-restart-confirm')
      const shell = page.getByTestId('session-actions-sheet')
      await shell.waitFor()
      expect(await page.getByTestId('composer-tools-button').count()).toBe(1)
      expect(await page.getByTestId('session-todos-button').count()).toBe(1)
      const actions = page.getByTestId('session-restart')
      expect(await actions.locator('[data-restart=new] kbd').isVisible()).toBe(
        false,
      )
      await expect
        .poll(() => actions.locator('[data-restart=new]').textContent())
        .toContain('/new')
      await expect
        .poll(() => actions.locator('[data-restart=fresh]').textContent())
        .toContain('新进程')
      await expect
        .poll(() => actions.evaluate((el) => el.scrollWidth <= el.clientWidth))
        .toBe(true)
      await expect
        .poll(() =>
          actions
            .locator('button')
            .evaluateAll((buttons) =>
              buttons.every(
                (button) => button.scrollWidth <= button.clientWidth,
              ),
            ),
        )
        .toBe(true)
      await actions.locator('[data-restart=new]').click()
      await confirm.waitFor()
      expect(await confirm.innerText()).toContain('不重启')
      await page.locator('[data-restart-cancel]').click()
      await actions.waitFor()
      await actions.locator('[data-restart=new]').click()
      await page.locator('[data-restart-confirm]').click()
      await expect
        .poll(() => tmux('capture-pane', '-p', '-t', pane))
        .toContain('/new')
      await openKeys()
      await page.setViewportSize({ width: 1280, height: 800 })
      await checkDesktopShortcuts(page)
      // 取消 sends nothing and brings the pair back
      await page.locator('[data-restart=resume]').click()
      await confirm.waitFor({ timeout: 5_000 })
      expect(await confirm.innerText()).toContain('F5')
      await page.locator('[data-restart-cancel]').click()
      await page.getByTestId('session-restart').waitFor({ timeout: 5_000 })
      // so does Esc; the focus starts on 确认
      await page.locator('[data-restart=fresh]').click()
      await confirm.waitFor({ timeout: 5_000 })
      expect(
        await page.evaluate(() =>
          document.activeElement?.hasAttribute('data-restart-confirm'),
        ),
      ).toBe(true)
      await page.keyboard.press('Escape')
      await page.getByTestId('session-restart').waitFor({ timeout: 5_000 })
      await page.waitForTimeout(500)
      expect(calls()).toEqual([])

      await checkWebRestartKey(page, calls, pane)

      // 重启会话: the pane, its agent, no --fresh
      await openKeys()
      await page.locator('[data-restart=resume]').click()
      await page.locator('[data-restart-confirm]').click()
      await expect.poll(calls, { timeout: 10_000 }).toHaveLength(2)
      expect(calls()[1]).toBe(`--pane ${pane} --agent claude`)
      await page.getByText('窗格正在重启').waitFor({ timeout: 5_000 })

      // 空白切换: same target-agent confirmation, no note or brief. The
      // relay returns its pending id and the page opens the blank session.
      await openKeys()
      await page.getByRole('button', { name: '切换 Agent' }).click()
      await page
        .getByTestId('session-handoff-mode')
        .getByRole('radio', { name: /空白切换/ })
        .waitFor()
      expect(
        await page
          .getByTestId('session-handoff-mode')
          .getByRole('radio')
          .locator('svg')
          .count(),
      ).toBe(2)
      expect(
        await page
          .locator('[data-handoff=grok] [data-testid=agent-avatar]')
          .count(),
      ).toBe(1)
      await page.locator('[data-handoff=grok]').click()
      const handoff = page.getByTestId('session-handoff-confirm')
      const blank = handoff.getByRole('radio', { name: /空白切换/ })
      await blank.focus()
      await page.keyboard.press('Space')
      await expect.poll(() => blank.isChecked()).toBe(true)
      await expect
        .poll(() => handoff.getByTestId('session-handoff-note').count())
        .toBe(0)
      await handoff.locator('[data-handoff-confirm]').click()
      await expect.poll(handoffCalls, { timeout: 10_000 }).toHaveLength(1)
      expect(handoffCalls()[0]).toContain('--empty')
      expect(handoffCalls()[0]).toContain('--to grok')
      await page.waitForURL(
        '**/console/sessions/pending-00000000-0000-4000-8000-000000000003',
        { timeout: 20_000 },
      )

      // The restart reply gives the destination before either read sees
      // cleared_to. Follow the reply without waiting for a poll.
      await page.goto(`${base}/zh/console/sessions/restart-s1`)
      await openKeys()
      await page.locator('[data-restart=fresh]').click()
      await page.locator('[data-restart-confirm]').click()
      await expect.poll(calls, { timeout: 10_000 }).toHaveLength(3)
      expect(calls()[2]).toBe(`--pane ${pane} --agent claude --fresh`)
      await page.waitForURL(`**/console/sessions/${NEW_ID}`, {
        timeout: 5_000,
      })
      writeFileSync(
        attention,
        JSON.stringify({
          entries: {},
          recent: [{ ...entry(), status: 'idle', cleared_to: NEW_ID }],
        }),
      )
      // Codex / Grok cannot name their own fresh id at startup. The host
      // gives the empty pane a pending id, then follows the first prompt's id.
      const pending = 'pending-00000000-0000-4000-8000-000000000002'
      writeFileSync(
        attention,
        JSON.stringify({
          entries: {},
          recent: [{ ...entry(), status: 'idle', cleared_to: pending }],
        }),
      )
      await page.goto(`${base}/zh/console/sessions/restart-s1`)
      await page.waitForURL(`**/console/sessions/${pending}`, {
        timeout: 20_000,
      })
      writeFileSync(
        attention,
        JSON.stringify({
          entries: {
            'codex-real': { ...entry(), session_id: 'codex-real' },
          },
          recent: [{ ...entry(), status: 'idle', cleared_to: pending }],
        }),
      )
      await page.waitForURL('**/console/sessions/codex-real', {
        timeout: 20_000,
      })
      expect(dialogs).toBe(0)
      await context.close()
    }, 90_000)
  },
)
