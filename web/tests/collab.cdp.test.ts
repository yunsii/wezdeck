// covers: web/src/features/console-collab* web/src/features/collab-top-bar.tsx
// covers: web/src/features/collab-metrics.tsx
// covers: web/src/features/tickets-view.tsx
// covers: web/src/features/ticket-autosync.ts web/src/features/ticket-header.tsx
// covers: web/src/features/ticket-info.tsx web/src/features/ticket-runs.tsx
// covers: web/src/features/ticket-search.tsx
// covers: web/src/features/ticket-thread-view.tsx
// covers: web/src/features/ticket-reply.tsx native/wezdeck-wsl/collab.go
// covers: skills/agent-collab/lib/reference.py
// covers: web/src/features/ticket-keys.tsx web/src/features/copy-reference.tsx
// covers: web/src/lib/last-opened.tsx
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { chromium, devices } from '@playwright/test'
import type { Browser, Locator, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 工单 against the remote-access test stack (scripts/dev/remote-test-stack.sh):
// its relay serves a copy of the ticket store, so this reads real tickets
// and runs without touching the live store. Covers the folded metrics band,
// a ticket with a recorded headless run (runs, transcript, launch record,
// prompt) on a wide screen and on a phone. Skips the run part when the copy
// has no ticket with a run.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const stack = process.env.WEZDECK_TEST_STACK_DIR ?? ''
const repo = join(import.meta.dirname, '..', '..')

/** a ticket in the stack's store copy with at least one recorded run */
function ticketWithRun(): string {
  const api = join(repo, 'skills/agent-collab/lib/api.py')
  const env = { ...process.env, TICKETS_ROOT: join(stack, 'tickets') }
  const run = (args: Array<string>) =>
    JSON.parse(execFileSync('python3', [api, ...args], { env }).toString()) as {
      tickets?: Array<{ id: string; last_run?: unknown }>
      runs?: Array<unknown>
    }
  for (const ticket of run(['list', '--limit', '200']).tickets ?? []) {
    if (!ticket.last_run) continue
    if ((run(['show', '--id', ticket.id]).runs ?? []).length > 0)
      return ticket.id
  }
  return ''
}

/** the repo (from / to) with the most runs in the store copy, all time */
function busiestRepo(): { name: string; runs: number } | null {
  const api = join(repo, 'skills/agent-collab/lib/api.py')
  const env = { ...process.env, TICKETS_ROOT: join(stack, 'tickets') }
  const metrics = (args: Array<string>) =>
    JSON.parse(
      execFileSync('python3', [api, 'metrics', ...args], { env }).toString(),
    ) as {
      runs: number
      by_repo: Record<string, { runs: number }>
    }
  const top = Object.entries(metrics(['--window', 'all']).by_repo)
    .sort((a, b) => b[1].runs - a[1].runs)
    .at(0)
  if (!top) return null
  return {
    name: top[0],
    runs: metrics(['--window', 'all', '--repo', top[0]]).runs,
  }
}

/** the headline Runs cell's value */
async function runsCell(metrics: Locator) {
  return (
    (await metrics
      .locator('div', {
        has: metrics.page().getByText('Runs', { exact: true }),
      })
      .last()
      .locator('dd')
      .textContent()) ?? ''
  )
}

async function open(page: Page, path: string) {
  await page.goto(`${base}${path}?remote=1#pair=${token}`)
  // data-remote-mode appears after hydration: clicks after it land
  await page.locator('main[data-remote-mode]').waitFor({ timeout: 20_000 })
}

describe.runIf(stack)('工单 over the remote link', () => {
  let browser: Browser
  let withRun = ''
  beforeAll(async () => {
    browser = await chromium.launch()
    withRun = ticketWithRun()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('wide: the metrics band unfolds, a run shows its record', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    const page = await context.newPage()
    await open(page, '/console/collab')
    await page
      .getByRole('heading', { name: 'Cross-repo collab' })
      .first()
      .waitFor()
    // folded by default; one tap shows the numbers
    const metrics = page.getByRole('region', { name: 'Collab metrics' })
    expect(await metrics.count()).toBe(0)
    await page.getByRole('button', { name: 'Runs, cache hit and cost' }).click()
    await metrics.getByText('Cache hit', { exact: true }).waitFor()
    // repo filter + window: the Runs cell follows `api metrics --repo`
    const pick = busiestRepo()
    if (pick) {
      await metrics.getByRole('combobox', { name: 'Metrics window' }).click()
      await page.getByRole('option', { name: 'all', exact: true }).click()
      await metrics.getByRole('combobox', { name: 'Repo filter' }).click()
      await page.getByRole('option', { name: pick.name, exact: true }).click()
      await expect
        .poll(() => runsCell(metrics), { timeout: 15_000 })
        .toBe(pick.runs.toLocaleString('en-US'))
      await metrics.getByRole('button', { name: 'Breakdowns' }).click()
      await metrics.getByRole('table', { name: 'By target repo' }).waitFor()
      await metrics.getByRole('table', { name: 'By backend' }).waitFor()
    }

    if (!withRun) return
    await open(page, `/console/collab/${withRun}`)
    const pane = page.getByTestId('ticket-pane')
    const runs = pane.getByRole('list', { name: 'Runs' })
    await runs.waitFor({ timeout: 15_000 })
    expect(await runs.getByTestId('ticket-run-row').count()).toBeGreaterThan(0)
    // tapping a compact run row opens RunDetail inside a dialog sheet
    await runs.getByTestId('ticket-run-row').first().click()
    const runSheet = page.getByTestId('ticket-run-sheet')
    await runSheet.waitFor({ timeout: 10_000 })
    const detail = runSheet.getByRole('region', { name: 'Run detail' })
    await detail
      .getByRole('list', { name: 'Transcript' })
      .locator('li')
      .first()
      .waitFor({ timeout: 15_000 })
    await detail.getByRole('button', { name: 'Launch details' }).click()
    await detail.getByText('Origin session').waitFor()
    await detail.getByRole('button', { name: 'Show initial prompt' }).click()
    await detail.getByRole('button', { name: 'Hide initial prompt' }).waitFor()
    await page.keyboard.press('Escape')
    await expect
      .poll(() => page.getByTestId('ticket-run-sheet').count())
      .toBe(0)
    // ⓘ / title opens 3-tier TicketInfo sheet: 复制引用 + Technical details
    await pane.getByTestId('ticket-info-button').click()
    const info = page.getByTestId('ticket-info')
    await info.waitFor({ timeout: 5_000 })
    await info.getByTestId('ticket-copy-reference').click()
    await info.getByRole('button', { name: 'Copied' }).waitFor()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toMatch(/^\[wezdeck 工单\] /)
    expect(copied).toContain(`id: ${withRun}`)
    expect(copied).toContain('运行合计: ')
    expect(copied).toContain(`ticket api show --id ${withRun}`)
    await info.getByTestId('ticket-tech-details').getByRole('button').click()
    await info.getByRole('table', { name: 'Run metrics' }).waitFor()
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByTestId('ticket-info').count()).toBe(0)
    // the list: y copies the open ticket; a row's key copies that row's
    await page.evaluate(() => navigator.clipboard.writeText(''))
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    )
    await page.keyboard.press('y')
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain(`id: ${withRun}`)
    const other = page.locator(`[data-ticket]:not([data-ticket="${withRun}"])`)
    if ((await other.count()) > 0) {
      const row = other.first()
      const otherId = (await row.getAttribute('data-ticket')) ?? ''
      await row.hover()
      await row.locator('..').getByTestId('row-copy-reference').click()
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toContain(`id: ${otherId}`)
      // copying does not switch the open ticket
      expect(page.url()).toContain(withRun)
    }
    // 工单 with no ticket in the URL opens the last one shown (y copies it;
    // pressed until the list is in and the ticket picked)
    await open(page, '/console/collab')
    await page.evaluate(() => navigator.clipboard.writeText(''))
    await expect
      .poll(async () => {
        await page.keyboard.press('y')
        return page.evaluate(() => navigator.clipboard.readText())
      })
      .toContain(`id: ${withRun}`)
    await context.close()
  }, 90_000)

  it('phone: compact run rows open transcript in a sheet, header opens ticket info', async () => {
    if (!withRun) return // the store copy has no ticket with a run
    const context = await browser.newContext({ ...devices['iPhone 13'] })
    const page = await context.newPage()
    // a phone detail page is full screen: no connection badge to wait for
    await page.goto(`${base}/console/collab/${withRun}?remote=1#pair=${token}`)
    const runs = page.getByRole('list', { name: 'Runs' })
    await runs
      .getByTestId('ticket-run-row')
      .first()
      .waitFor({ timeout: 25_000 })
    // Run detail lives in a bottom sheet, not bloated inline
    expect(await page.getByRole('region', { name: 'Run detail' }).count()).toBe(
      0,
    )
    await runs.getByTestId('ticket-run-row').first().click()
    const runSheet = page.getByTestId('ticket-run-sheet')
    await runSheet.waitFor({ timeout: 10_000 })
    const detail = runSheet.getByRole('region', { name: 'Run detail' })
    await detail
      .getByRole('list', { name: 'Transcript' })
      .locator('li')
      .first()
      .waitFor({ timeout: 15_000 })
    await page.keyboard.press('Escape')
    await expect
      .poll(() => page.getByTestId('ticket-run-sheet').count())
      .toBe(0)
    // tapping header title opens TicketInfo
    await page.getByTestId('ticket-title').click()
    await page.getByTestId('ticket-info').waitFor({ timeout: 5_000 })
    await context.close()
  }, 90_000)
})
