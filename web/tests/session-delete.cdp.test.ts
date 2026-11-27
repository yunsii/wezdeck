// covers: web/src/features/session-delete.tsx web/src/features/session-delete-state.ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Delete confirmation sheet button layout: full-width stacked on phones
// (destructive action above a bordered Cancel key, >= 44px touch targets) and
// right-aligned side-by-side on desktop dialogs.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''
const devicesFile = process.env.WEZDECK_TEST_DEVICES ?? ''
const repo = join(import.meta.dirname, '..', '..')

describe.runIf(attention && devicesFile)('Session delete sheet layout', () => {
  let browser: Browser
  const socket = join(mkdtempSync(join(tmpdir(), 'wd-del-')), 'sock')
  const tmux = (...args: Array<string>) =>
    execFileSync('tmux', ['-S', socket, ...args])
      .toString()
      .trim()

  beforeAll(async () => {
    tmux('new-session', '-d', '-s', 'del1', '-x', '100', '-y', '20', 'cat')
    writeFileSync(
      attention,
      JSON.stringify({
        entries: {
          'delete-layout': {
            session_id: 'delete-layout',
            tmux_socket: socket,
            tmux_session: 'del1',
            tmux_pane: tmux(
              'display-message',
              '-p',
              '-t',
              'del1',
              '#{pane_id}',
            ),
            status: 'idle',
            agent_name: 'codex',
            tmux_window_name: 'delete-layout',
            ts: Date.now(),
          },
        },
      }),
    )
    writeFileSync(devicesFile, JSON.stringify({ approved: [], pending: [] }))
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser.close()
    tmux('kill-server')
  })

  const approveAndOpenDeleteSheet = async (page: Page) => {
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

    await page.goto(`${base}/zh/console/sessions/delete-layout`)
    await page.getByTestId('session-info-button').click()
    const info = page.getByTestId('session-info')
    await info.waitFor({ timeout: 15_000 })
    // Technical details stay folded by default so the sheet opens clean
    const techTrigger = info
      .getByTestId('session-tech-details')
      .getByRole('button')
    expect(await techTrigger.getAttribute('aria-expanded')).toBe('false')
    await info.getByRole('button', { name: '删除会话' }).click()
    const sheet = page.getByTestId('session-delete-confirm')
    await sheet.waitFor({ timeout: 15_000 })
    await sheet.evaluate((el) =>
      Promise.allSettled(el.getAnimations().map((a) => a.finished)),
    )
    return sheet
  }

  it('phone: stacks full-width action above a bordered Cancel button', async () => {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    const sheet = await approveAndOpenDeleteSheet(page)
    const cancel = sheet.getByRole('button', { name: '取消' })
    const confirm = sheet.getByRole('button', { name: '删除会话' })
    const [sheetBox, cancelBox, confirmBox] = await Promise.all([
      sheet.boundingBox(),
      cancel.boundingBox(),
      confirm.boundingBox(),
    ])
    expect(sheetBox && cancelBox && confirmBox).toBeTruthy()
    expect(confirmBox!.width).toBeGreaterThanOrEqual(sheetBox!.width - 40)
    expect(cancelBox!.width).toBeGreaterThanOrEqual(sheetBox!.width - 40)
    expect(Math.abs(confirmBox!.width - cancelBox!.width)).toBeLessThanOrEqual(
      2,
    )
    expect(Math.abs(confirmBox!.x - cancelBox!.x)).toBeLessThanOrEqual(2)
    expect(confirmBox!.height).toBeGreaterThanOrEqual(44)
    expect(cancelBox!.height).toBeGreaterThanOrEqual(44)
    // destructive action above Cancel on mobile bottom sheets
    expect(confirmBox!.y + confirmBox!.height).toBeLessThan(cancelBox!.y)
    const cancelBorder = await cancel.evaluate(
      (el) => getComputedStyle(el).borderTopWidth,
    )
    expect(parseFloat(cancelBorder)).toBeGreaterThan(0)
    await context.close()
  })

  it('desktop: aligns Cancel left of the confirm action in one row', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    const sheet = await approveAndOpenDeleteSheet(page)
    const cancel = sheet.getByRole('button', { name: '取消' })
    const confirm = sheet.getByRole('button', { name: '删除会话' })
    const [cancelBox, confirmBox] = await Promise.all([
      cancel.boundingBox(),
      confirm.boundingBox(),
    ])
    expect(cancelBox && confirmBox).toBeTruthy()
    expect(Math.abs(cancelBox!.y - confirmBox!.y)).toBeLessThanOrEqual(2)
    expect(cancelBox!.x + cancelBox!.width).toBeLessThan(confirmBox!.x)
    expect(cancelBox!.height).toBeGreaterThanOrEqual(44)
    expect(confirmBox!.height).toBeGreaterThanOrEqual(44)
    await context.close()
  })
})
