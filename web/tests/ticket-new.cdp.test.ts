import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 新工单 from the phone (ticket-new.tsx → host ticket_new.go → `ticket
// create`), on the test stack's private copy of the ticket store; "start
// now" is recorded by the stack's stand-in instead of a systemd unit. Also:
// `g c` (jump to 工单) on the session list must not open 新会话.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const devicesFile = process.env.WEZDECK_TEST_DEVICES ?? ''
const stack = process.env.WEZDECK_TEST_STACK_DIR ?? ''
const repoRoot = join(import.meta.dirname, '..', '..')

describe.runIf(devicesFile && stack)('New ticket from the phone', () => {
  let browser: Browser
  const targets = () =>
    [
      ...readFileSync(join(stack, 'tickets', 'config.yml'), 'utf8').matchAll(
        /^ {2}([A-Za-z0-9_-]+):\s*$/gm,
      ),
    ].map((m) => m[1])

  beforeAll(async () => {
    writeFileSync(devicesFile, JSON.stringify({ approved: [], pending: [] }))
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser.close()
  })

  it('creates the ticket in the store, starts its run, opens it', async () => {
    const [from, to] = targets()
    if (!from || !to) return // a store without two targets: nothing to test
    // a desktop-sized page: the keyboard check below needs the jump keys
    const context = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width: 1280, height: 900 },
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/writing?remote=1#pair=${token}`)
    await page
      .locator('[data-testid=remote-badge-compact], [data-testid=remote-badge]')
      .first()
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
    await page.getByText('已启用').waitFor({ timeout: 15_000 })

    // g c on the session list jumps to 工单 and opens nothing
    await page.goto(`${base}/zh/console/sessions`)
    await page.getByTestId('new-session').waitFor({ timeout: 15_000 })
    await page.keyboard.press('g')
    await page.keyboard.press('c')
    await page.waitForURL(/\/console\/collab$/)
    expect(await page.getByTestId('new-session-sheet').count()).toBe(0)

    await page.getByTestId('new-ticket').click()
    const sheet = page.getByTestId('new-ticket-sheet')
    // Base UI Select: open the trigger, pick from the popup (portalled to body)
    const pick = async (index: number, key: string) => {
      await sheet.getByRole('combobox').nth(index).click()
      await page.getByRole('option', { name: key, exact: true }).click()
    }
    await pick(0, from)
    await pick(1, to)
    await sheet.getByLabel('标题').fill('从手机提的测试单')
    await sheet.getByLabel('你看到的现象').fill('手机上看到 X')
    await sheet.getByLabel('你的假设').fill('对方应该提供 Y')
    await sheet.getByRole('checkbox').check()
    await sheet.getByRole('button', { name: '创建工单' }).click()
    await page.waitForURL(/\/console\/collab\/req-[A-Za-z0-9_.-]+$/, {
      timeout: 20_000,
    })
    const ticket = page.url().split('/').at(-1) ?? ''
    // written to the stack's copy only, and its run handed to the stand-in
    expect(existsSync(join(stack, 'tickets', '_data', ticket))).toBe(true)
    expect(
      existsSync(join(homedir(), '.agent', 'tickets', '_data', ticket)),
    ).toBe(false)
    await expect
      .poll(() =>
        existsSync(join(stack, 'ticket-runs'))
          ? readFileSync(join(stack, 'ticket-runs'), 'utf8')
          : '',
      )
      .toContain(ticket)
    await context.close()
  }, 60_000)
})
