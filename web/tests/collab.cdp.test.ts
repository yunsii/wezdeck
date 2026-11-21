import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Collab page against a Runtime (or scripts/mock-runtime.mjs with
// WEZDECK_MOCK_TICKETS_ROOT) whose store has at least one ticket with
// recorded headless runs. Headless CDP: no focus stealing.
const webUrl =
  process.env.WEZDECK_WEB_URL || 'http://127.0.0.1:3000/console/collab'
const cdpUrl = process.env.WEZDECK_CDP_URL || 'http://127.0.0.1:9222'
const shot = process.env.WEZDECK_COLLAB_SCREENSHOT

describe('Collab console through an existing Chromium CDP session', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.connectOverCDP(cdpUrl)
    page = await browser.contexts()[0].newPage()
    await page.setViewportSize({ width: 1440, height: 1100 })
    await page.goto(webUrl, { waitUntil: 'domcontentloaded' })
    await page
      .getByRole('heading', { name: 'Cross-repo collab' })
      .waitFor({ state: 'visible', timeout: 20_000 })
  })

  afterAll(async () => {
    await page.close()
  })

  it('shows metrics, tickets, runs, launch record, prompt and transcript', async () => {
    const metrics = page.getByRole('region', { name: 'Collab metrics' })
    await metrics.getByText('Cache hit', { exact: true }).waitFor()
    expect(
      await metrics.getByText('Sessions', { exact: true }).isVisible(),
    ).toBe(true)

    const list = page.getByRole('listbox', { name: 'Collab tickets' })
    await list.getByRole('option').first().waitFor()
    await list.getByRole('option').first().click()

    const runs = page.getByRole('table', { name: 'Runs' })
    await runs.waitFor()
    expect(await runs.getByText(/resume · warm_cache/).count()).toBeGreaterThan(
      0,
    )

    const detail = page.getByRole('region', { name: 'Run detail' })
    await detail.getByText('Origin session').waitFor()
    expect(
      await page
        .getByRole('table', { name: 'Prompt composition' })
        .getByText('template')
        .isVisible(),
    ).toBe(true)

    await page.getByRole('button', { name: 'Show initial prompt' }).click()
    await page
      .getByText(/Ticket phase view/)
      .first()
      .waitFor()

    const transcript = page.getByRole('list', { name: 'Transcript' })
    await transcript.getByText('run_end').waitFor()
    expect(
      await transcript.getByText('tool', { exact: true }).count(),
    ).toBeGreaterThan(0)

    // keyboard path: listbox arrow navigation keeps a selection
    await list.focus()
    await page.keyboard.press('ArrowDown')
    expect(await list.locator('[aria-selected="true"]').count()).toBe(1)
    if (shot) await page.screenshot({ path: shot, fullPage: true })
  })
})
