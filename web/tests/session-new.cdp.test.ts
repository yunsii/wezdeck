import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 新会话 from the phone (session-new.tsx → host session_new.go): pick the
// repository, kind, subject and first message; the host runs open-task-window
// — on the test stack its stand-in, a real `git worktree add` in a throwaway
// repo and a `cat` pane on the stack's tmux socket — pastes the message into
// the pane, and the sheet opens the session once it is listed.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''
const devicesFile = process.env.WEZDECK_TEST_DEVICES ?? ''
const stack = process.env.WEZDECK_TEST_STACK_DIR ?? ''
const repoRoot = join(import.meta.dirname, '..', '..')

describe.runIf(attention && devicesFile && stack)(
  'New session from the phone',
  () => {
    let browser: Browser
    const repo = join(mkdtempSync(join(tmpdir(), 'wd-newrepo-')), 'phone-repo')
    const socket = join(stack, 'new.sock')

    beforeAll(async () => {
      execFileSync('git', ['init', '-q', repo])
      execFileSync(
        'git',
        ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 't',
            GIT_AUTHOR_EMAIL: 't@t',
            GIT_COMMITTER_NAME: 't',
            GIT_COMMITTER_EMAIL: 't@t',
          },
        },
      )
      // the repository list comes from the access ledger (visited worktrees)
      writeFileSync(
        join(stack, 'access-ledger.json'),
        JSON.stringify({
          worktrees: { [repo]: { last_access_ms: Date.now() } },
        }),
      )
      writeFileSync(attention, JSON.stringify({ entries: {} }))
      writeFileSync(devicesFile, JSON.stringify({ approved: [], pending: [] }))
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser.close()
      try {
        execFileSync('tmux', ['-S', socket, 'kill-server'])
      } catch {
        // no session was made
      }
    })

    it('creates the worktree, hands the agent the message, opens the session', async () => {
      const context = await browser.newContext({
        ...devices['iPhone 13'],
        locale: 'zh-CN',
      })
      const page = await context.newPage()
      await page.goto(`${base}/zh/console/me/writing?remote=1#pair=${token}`)
      await page
        .locator('[data-testid=remote-badge-compact]')
        .waitFor({ timeout: 20_000 })
      await page.getByRole('button', { name: '启用写入' }).click()
      const command = page.locator('code', { hasText: '--approve' })
      await command.waitFor({ timeout: 20_000 })
      const id = ((await command.textContent()) ?? '').trim().split(' ').at(-1)
      execFileSync(
        join(repoRoot, 'scripts/dev/install-remote-relay.sh'),
        ['--approve', id ?? ''],
        {
          env: { ...process.env, WEZDECK_REMOTE_DEVICES: devicesFile },
        },
      )
      await page.getByRole('button', { name: '重新检查' }).click()
      await page.getByText(/^已启用。/).waitFor({ timeout: 15_000 })

      await page.goto(`${base}/zh/console/sessions`)
      await page.getByTestId('new-session').click()
      const sheet = page.getByTestId('new-session-sheet')
      // the repository picker (Base UI Select) preselects the visited repo
      await expect
        .poll(() => sheet.getByRole('combobox').textContent())
        .toContain('phone-repo')
      await sheet.locator('[data-value=task]').click()
      await sheet.getByPlaceholder(/phone-create/).fill('phone')
      await sheet.getByPlaceholder('要它做什么？').fill('从手机开的新会话')
      await sheet.getByRole('button', { name: '创建会话' }).click()
      const stage = page.getByTestId('new-session-stage')
      await expect
        .poll(() => stage.getAttribute('data-stage'), { timeout: 20_000 })
        .toBe('done')
      const worktree = join(repo, '.worktrees', 'task-phone')
      const pane = execFileSync('tmux', [
        '-S',
        socket,
        'display-message',
        '-p',
        '-t',
        'task-phone',
        '#{pane_id}',
      ])
        .toString()
        .trim()
      expect(
        execFileSync('tmux', [
          '-S',
          socket,
          'capture-pane',
          '-p',
          '-t',
          pane,
        ]).toString(),
      ).toContain('从手机开的新会话')
      // the agent's first-prompt hook lists it; the sheet then opens it
      writeFileSync(
        attention,
        JSON.stringify({
          entries: {
            'new-1': {
              session_id: 'new-1',
              tmux_socket: socket,
              tmux_session: 'task-phone',
              tmux_pane: pane,
              status: 'running',
              agent_name: 'claude',
              last_user_prompt: '从手机开的新会话',
              ts: Date.now(),
            },
          },
        }),
      )
      await page.waitForURL('**/console/sessions/new-1', { timeout: 20_000 })
      expect(
        execFileSync('git', ['-C', worktree, 'branch', '--show-current'])
          .toString()
          .trim(),
      ).toBe('task/phone')
      await context.close()
    }, 60_000)
  },
)
