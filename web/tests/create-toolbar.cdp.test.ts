// covers: web/src/features/session-new.tsx web/src/features/ticket-new.tsx
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import type { Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const devices = process.env.WEZDECK_TEST_DEVICES ?? ''
const repo = join(import.meta.dirname, '..', '..')
const writing = `${base}/zh/console/me/writing`

async function toolbarPositions(page: Page, approved: boolean) {
  const positions = []
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    for (const { route, button, selector } of [
      {
        route: 'sessions',
        button: 'new-session',
        selector: '[data-testid=chat-search]',
      },
      {
        route: 'collab',
        button: 'new-ticket',
        selector: 'a[aria-label="工单动态"]',
      },
    ]) {
      await page.goto(`${base}/zh/console/${route}`)
      await page.locator('main[data-remote-mode]').waitFor()
      const create = page.getByTestId(button)
      await create.waitFor({ state: approved ? 'visible' : 'hidden' })
      if (!approved && route === 'collab') {
        await page.keyboard.press('n')
        expect(await page.getByTestId('new-ticket-sheet').count()).toBe(0)
      }
      const neighbor = page.locator(selector).filter({ visible: true }).first()
      await neighbor.waitFor()
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      positions.push({ route, width, rect: await neighbor.boundingBox() })
    }
  }
  return positions
}

describe.runIf(devices)('Create toolbar layout', () => {
  it('keeps adjacent controls in place when creation becomes available', async () => {
    writeFileSync(devices, JSON.stringify({ approved: [], pending: [] }))
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ locale: 'zh-CN' })
      await page.goto(`${writing}?remote=1#pair=${token}`)
      await page.locator('main[data-remote-mode]').waitFor()
      const before = await toolbarPositions(page, false)

      await page.goto(writing)
      await page.getByRole('button', { name: '申请授权' }).click()
      const command = page.locator('code', { hasText: '--approve' })
      await command.waitFor()
      const id = ((await command.textContent()) ?? '').trim().split(' ').at(-1)
      execFileSync(
        join(repo, 'scripts/dev/install-remote-relay.sh'),
        ['--approve', id ?? ''],
        {
          env: { ...process.env, WEZDECK_REMOTE_DEVICES: devices },
        },
      )
      await page.getByRole('button', { name: '重新检查' }).click()
      await page.getByText(/^已获批。/).waitFor()

      const after = await toolbarPositions(page, true)
      expect(after).toEqual(before)
    } finally {
      await browser.close()
    }
  }, 75_000)
})
