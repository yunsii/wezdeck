// covers: web/src/features/session-new.tsx web/src/features/session-list.tsx
// covers: web/src/features/session-order.ts web/src/features/session-purpose.tsx
// covers: native/wezdeck-wsl/session_new.go native/wezdeck-wsl/worktree_description.go
// covers: scripts/runtime/worktree/lib/core-describe.sh
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from '@playwright/test'
import type {
  Browser,
  BrowserContextOptions,
  Locator,
  Page,
} from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 新会话 from the phone (session-new.tsx → host session_new.go): pick the
// repository, name a workstation (its direction) with a one-line purpose and
// write the first message; the host runs open-task-window
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

    /** a paired, approved page */
    const approvedPage = async (options: BrowserContextOptions) => {
      const context = await browser.newContext({ ...options, locale: 'zh-CN' })
      const page = await context.newPage()
      await page.goto(`${base}/zh/console/me/writing?remote=1#pair=${token}`)
      await page
        .locator('[data-testid=remote-badge-compact]')
        .first() // a wide window shows it twice
        .waitFor({ timeout: 20_000 })
      await page.getByRole('button', { name: '申请授权' }).click()
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
      await page.getByText(/^已获批。/).waitFor({ timeout: 15_000 })
      return { context, page }
    }

    const listEntry = (id: string, pane: string, session: string) => ({
      session_id: id,
      tmux_socket: socket,
      tmux_session: session,
      tmux_pane: pane,
      // the fake names the branch dev/<name>; the relay reads its purpose
      git_branch: `dev/${session}`,
      status: 'running',
      agent_name: 'claude',
      last_user_prompt: '从手机开的新会话',
      ts: Date.now(),
    })

    /**
     * 新会话 › a workstation named `name` with `description`; once the pane
     * has the message, list it as id (the agent's first-prompt hook) and
     * wait for the page to open it. Returns the worktree and the pane.
     */
    const createSession = async (
      page: Page,
      name: string,
      id: string,
      description = '',
    ) => {
      await page.goto(`${base}/zh/console/sessions`)
      await page.getByTestId('new-session').click()
      const sheet = page.getByTestId('new-session-sheet')
      // the repository picker (Base UI Select) preselects the visited repo
      await expect
        .poll(() => sheet.getByRole('combobox').textContent())
        .toContain('phone-repo')
      await sheet.getByPlaceholder('例如 ux、ci、i18n').fill(name)
      await expect
        .poll(() => sheet.getByTestId('new-session-slug').textContent())
        .toContain(`工作站 ${name}，分支 dev/${name}`)
      await sheet.getByPlaceholder('这个工作站做什么，一行').fill(description)
      await sheet.getByPlaceholder('要它做什么？').fill('从手机开的新会话')
      await sheet.getByRole('button', { name: '创建会话' }).click()
      const stage = page.getByTestId('new-session-stage')
      await expect
        .poll(() => stage.getAttribute('data-stage'), { timeout: 20_000 })
        .toBe('done')
      const session = name
      const pane = execFileSync('tmux', [
        '-S',
        socket,
        'display-message',
        '-p',
        '-t',
        session,
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
      writeFileSync(
        attention,
        JSON.stringify({ entries: { [id]: listEntry(id, pane, session) } }),
      )
      await page.waitForURL(`**/console/sessions/${id}`, { timeout: 20_000 })
      return { worktree: join(repo, '.worktrees', session), pane, session }
    }

    it('creates the workstation, hands the agent the message, opens the session', async () => {
      const { context, page } = await approvedPage(devices['iPhone 13'])
      const { worktree } = await createSession(
        page,
        'phone',
        'new-1',
        '手机端体验',
      )
      const git = (...args: Array<string>) =>
        execFileSync('git', ['-C', worktree, ...args])
          .toString()
          .trim()
      expect(git('branch', '--show-current')).toBe('dev/phone')
      // the purpose is the branch description
      expect(git('config', 'branch.dev/phone.description')).toBe('手机端体验')
      // and the session list shows it under the workstation
      await page.goto(`${base}/zh/console/sessions`)
      const group = page.locator('[data-worktree=phone]')
      await expect
        .poll(() => group.getByTestId('worktree-description').textContent(), {
          timeout: 15_000,
        })
        .toContain('手机端体验')

      await editPurposeInList(page, group, worktree)
      await context.close()
    }, 90_000)

    it('a name without letters or digits is refused before anything runs', async () => {
      const { context, page } = await approvedPage(devices['iPhone 13'])
      await page.goto(`${base}/zh/console/sessions`)
      await page.getByTestId('new-session').click()
      const sheet = page.getByTestId('new-session-sheet')
      await sheet.getByPlaceholder('例如 ux、ci、i18n').fill('网页体验')
      await sheet.getByPlaceholder('要它做什么？').fill('不会创建')
      await expect
        .poll(() => sheet.getByTestId('new-session-slug').textContent())
        .toContain('需要包含字母或数字')
      expect(
        await sheet.getByRole('button', { name: '创建会话' }).isDisabled(),
      ).toBe(true)
      await context.close()
    }, 60_000)

    it('opens the new session once: switching away stays switched (wide)', async () => {
      // on a wide window the list — and its 新会话 sheet — stays mounted
      // beside the session; each sessions poll made a new `listed` row that
      // opened the new session again, so picking another one bounced
      // straight back (2026-11-25)
      const { context, page } = await approvedPage({
        viewport: { width: 1440, height: 900 },
      })
      const { pane, session } = await createSession(page, 'desk', 'new-2')
      const other = execFileSync('tmux', [
        '-S',
        socket,
        'new-window',
        '-d',
        '-P',
        '-F',
        '#{pane_id}',
        '-t',
        session,
        'cat',
      ])
        .toString()
        .trim()
      writeFileSync(
        attention,
        JSON.stringify({
          entries: {
            'new-2': listEntry('new-2', pane, session),
            'other-1': {
              ...listEntry('other-1', other, session),
              status: 'done',
              last_user_prompt: '另一个会话',
              ts: Date.now() - 60_000,
            },
          },
        }),
      )
      const row = page.locator('a[href$="/console/sessions/other-1"]').first()
      await row.waitFor({ timeout: 15_000 })
      await row.click()
      await page.waitForURL('**/console/sessions/other-1', { timeout: 5_000 })
      // two sessions polls (5 s each) later, still there
      await page.waitForTimeout(11_000)
      expect(page.url()).toContain('/console/sessions/other-1')
      await context.close()
    }, 90_000)
  },
)

/**
 * The workstation's purpose edited in place from the session list
 * (session-purpose.tsx → relay worktree.describe → worktree-task describe):
 * retype, clear (the row then offers 「+ 描述」), add by keyboard, Esc.
 */
async function editPurposeInList(page: Page, group: Locator, worktree: string) {
  const purpose = () =>
    execFileSync('git', [
      '-C',
      worktree,
      'config',
      '--default',
      '',
      'branch.dev/phone.description',
    ])
      .toString()
      .trim()
  const input = group.getByTestId('worktree-purpose-input')
  await group.getByTestId('worktree-description').click()
  await input.fill('手机端新建与收尾')
  await input.press('Enter')
  await expect.poll(purpose, { timeout: 15_000 }).toBe('手机端新建与收尾')
  await expect
    .poll(() => group.getByTestId('worktree-description').textContent())
    .toContain('手机端新建与收尾')

  // emptied → removed, and the row offers 「+ 描述」 instead
  await group.getByTestId('worktree-description').click()
  await input.fill('')
  await input.press('Enter')
  await expect.poll(purpose, { timeout: 15_000 }).toBe('')
  const add = group.getByTestId('worktree-purpose-add')
  await expect.poll(() => add.textContent()).toContain('+ 描述')
  // keyboard: focus it, Enter opens the field
  await add.focus()
  await page.keyboard.press('Enter')
  await input.fill('再补一句')
  await input.press('Enter')
  await expect.poll(purpose, { timeout: 15_000 }).toBe('再补一句')

  // Esc leaves it as it was
  await group.getByTestId('worktree-description').click()
  await input.fill('不保存')
  await input.press('Escape')
  expect(await input.count()).toBe(0)
  expect(purpose()).toBe('再补一句')
}
