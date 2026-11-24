// covers: web/src/features/session-background.tsx
// covers: web/src/features/session-header.tsx
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Background tasks (交互调试 › 后台任务): each row says what the task is —
// the call's description or command, how long it has run, its newest output
// line — not a bare `task:<id>`; a row opens to the command, the output and
// a jump to the call. A task the host knows nothing about keeps its id.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Background tasks', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('rows describe the task; one opens to its command and output', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#background`)
    const list = page.getByTestId('background-tasks')
    await list.waitFor({ timeout: 20_000 })
    const rows = list.locator('[data-bg-task]')
    await expect.poll(() => rows.count()).toBe(3)
    const bash = list.locator('[data-bg-task=b7k2m9]')
    const text = (await bash.innerText()).replace(/\s+/g, ' ')
    expect(text).toContain('Run the web cdp tests')
    expect(text).toContain('Test Files 1 passed')
    expect(text).toMatch(/1m3\ds/) // ran ~95 s
    expect(text).not.toContain('task:b7k2m9')
    // only the unknown one falls back to its id
    expect(await list.locator('[data-bg-task=q93hz0]').innerText()).toContain(
      'task:q93hz0',
    )
    await bash.locator('button[aria-expanded]').click()
    await expect
      .poll(() => bash.innerText())
      .toContain('scripts/dev/web-affected-tests.sh')
    expect(await bash.getByTestId('bg-jump').count()).toBe(1)
    // the Monitor has no output yet and no call in this demo thread
    const monitor = list.locator('[data-bg-task=mon4x1]')
    await monitor.locator('button[aria-expanded]').click()
    await expect.poll(() => monitor.innerText()).toContain('还没有输出')
    await context.close()
  })
})
