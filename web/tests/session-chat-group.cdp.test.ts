// covers: web/src/features/session-chat-group.tsx web/src/features/agent-avatar.tsx
// covers: web/src/features/session-collapse.ts
// covers: web/src/features/session-list.tsx web/src/features/session-switcher.tsx
// A worktree with two agent sessions (grok + codex): a foldable header and
// one stable sub-row per session, each directly reachable — the focus no
// longer takes turns repainting one shared row. Runs against
// remote-test-stack.sh only (throwaway attention file, tmux panes made here).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium, devices } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''

describe.runIf(attention)('Multi-session worktree rows', () => {
  let browser: Browser
  const socket = join(mkdtempSync(join(tmpdir(), 'wd-grp-')), 'sock')
  const tmux = (...args: Array<string>) =>
    execFileSync('tmux', ['-S', socket, ...args])
      .toString()
      .trim()

  beforeAll(async () => {
    const shared = join(dirname(socket), 'main')
    mkdirSync(shared)
    const solo = join(dirname(socket), 'ux')
    mkdirSync(solo)
    const sessions: Record<
      string,
      { cwd: string; status: string; agent: string; waiting?: string }
    > = {
      'grp-grok': { cwd: shared, status: 'idle', agent: 'grok' },
      'grp-codex': {
        cwd: shared,
        status: 'waiting',
        agent: 'codex',
        waiting: 'permission',
      },
      'grp-solo': { cwd: solo, status: 'running', agent: 'claude' },
    }
    const entries: Record<string, unknown> = {}
    for (const [id, s] of Object.entries(sessions)) {
      tmux(
        'new-session',
        '-d',
        '-s',
        id,
        '-c',
        s.cwd,
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
        status: s.status,
        waiting_kind: s.waiting ?? '',
        agent_name: s.agent,
        tmux_window_name: id,
        last_user_prompt: s.status === 'idle' ? '' : `prompt ${id}`,
        ts: Date.now(),
      }
    }
    writeFileSync(attention, JSON.stringify({ entries }))
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser.close()
    tmux('kill-server')
  })

  const openList = async (page: Page) => {
    await page.goto(`${base}/zh/console/sessions?remote=1#pair=${token}`)
    await page.locator('[data-session=grp-solo]').waitFor({ timeout: 20_000 })
  }

  it('sub-rows per session, direct links, folding remembered across reloads', async () => {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await openList(page)
    // expanded by default: both sessions of the shared worktree, plus the
    // single-session row — and only one foldable header in the list
    await page.locator('[data-session=grp-grok]').waitFor()
    await page.locator('[data-session=grp-codex]').waitFor()
    await expect
      .poll(() => page.getByTestId('chat-group-toggle').count())
      .toBe(1)
    const toggle = page.getByTestId('chat-group-toggle')
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
    const emptyRow = page.locator('[data-session=grp-grok]')
    // A cat fixture has no verified agent process or profile; its name is metadata.
    await expect.poll(() => emptyRow.textContent()).toContain('Agent')
    expect(await emptyRow.getByTestId('session-preview').count()).toBe(0)
    expect(await toggle.getByTestId('chat-unread').count()).toBe(0)
    // the waiting session is the unread one, on its own sub-row
    await expect
      .poll(() =>
        page
          .locator('[data-session=grp-codex]')
          .getByTestId('chat-unread')
          .count(),
      )
      .toBe(1)
    // a sub-row opens its own session, not whatever the focus resolved to
    await page.locator('[data-session=grp-grok]').click()
    await page.waitForURL('**/console/sessions/grp-grok')

    await openList(page)
    // Telegram-style unified flat rail: full-bleed on mobile (no outer card gutter)
    // and compact top bar carrying search + connection badge on one row.
    const listBox = await page.getByTestId('session-chats').boundingBox()
    const viewport = page.viewportSize()
    expect(
      listBox &&
        viewport &&
        listBox.x === 0 &&
        listBox.width === viewport.width,
    ).toBe(true)
    await page.getByTestId('chat-search').waitFor()
    await page.getByTestId('remote-badge-compact').waitFor()
    // Waiting / done sessions auto-sync into the persisted query cache before clicking in
    await expect
      .poll(
        async () =>
          await page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const req = indexedDB.open('wezdeck')
              req.onsuccess = () => resolve(req.result)
              req.onerror = () => reject(req.error)
            })
            if (!db.objectStoreNames.contains('query-cache')) return false
            const raw = await new Promise<string | undefined>(
              (resolve, reject) => {
                const tx = db.transaction('query-cache', 'readonly')
                const req = tx
                  .objectStore('query-cache')
                  .get('wezdeck-query-cache')
                req.onsuccess = () => resolve(req.result as string | undefined)
                req.onerror = () => reject(req.error)
              },
            )
            db.close()
            if (!raw) return false
            const parsed = JSON.parse(raw) as {
              clientState?: { queries?: Array<{ queryKey?: Array<unknown> }> }
            }
            return Boolean(
              parsed.clientState?.queries?.some((q) => {
                const key = q.queryKey
                return (
                  Array.isArray(key) &&
                  key[0] === 'remote' &&
                  key[1] === 'session' &&
                  key[2] === 'grp-codex'
                )
              }),
            )
          }),
        { timeout: 10_000 },
      )
      .toBe(true)
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
    await expect
      .poll(() => page.locator('[data-session=grp-grok]').count())
      .toBe(0)
    await expect
      .poll(() => page.locator('[data-session=grp-codex]').count())
      .toBe(0)
    await expect
      .poll(() => toggle.getByTestId('chat-unread').textContent())
      .toBe('1')
    // collapsed workstation keeps its focus preview visible like a Telegram group row
    await expect
      .poll(() => toggle.getByTestId('chat-preview').textContent())
      .toContain('prompt grp-codex')
    // the choice survives a reload
    await page.reload()
    await page.locator('[data-session=grp-solo]').waitFor({ timeout: 20_000 })
    await expect
      .poll(() => page.locator('[data-session=grp-grok]').count())
      .toBe(0)
    await page.getByTestId('chat-group-toggle').click()
    await page.locator('[data-session=grp-grok]').waitFor()
    await page.locator('[data-session=grp-codex]').waitFor()
    await context.close()
  })

  it('the switcher lists every session of the worktree', async () => {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await openList(page)
    await page.locator('[data-session=grp-codex]').click()
    await page.waitForURL('**/console/sessions/grp-codex')
    await page.getByTestId('session-title').click()
    const sheet = page.getByTestId('session-switcher')
    await sheet.waitFor()
    await sheet.locator('[data-session-id=grp-grok]').waitFor()
    await expect
      .poll(() =>
        sheet.locator('[aria-current=page]').getAttribute('data-session-id'),
      )
      .toBe('grp-codex')
    await sheet.locator('[data-session-id=grp-grok]').click()
    await page.waitForURL('**/console/sessions/grp-grok')
    await expect.poll(() => sheet.count()).toBe(0)
    await context.close()
  })

  it('wide screen: the open sub-row is marked, j / k walk sub-rows', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/sessions?remote=1#pair=${token}`)
    await page.locator('[data-session=grp-grok]').waitFor({ timeout: 20_000 })
    await page.locator('[data-session=grp-grok]').click()
    await page.waitForURL('**/console/sessions/grp-grok')
    await expect
      .poll(() =>
        page.locator('[data-session=grp-grok]').getAttribute('aria-current'),
      )
      .toBe('page')
    await page.keyboard.press('j')
    await expect.poll(() => page.url().split('/').at(-1)).not.toBe('grp-grok')
    await context.close()
  })
})
