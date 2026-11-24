// covers: web/src/features/console-collab* web/src/features/collab-top-bar.tsx
// covers: web/src/features/collab-metrics.tsx
// covers: web/src/features/tickets-view.tsx
// covers: web/src/features/ticket-thread-view.tsx
// covers: web/src/features/ticket-reply.tsx native/wezdeck-wsl/collab.go
// covers: web/src/features/ticket-copy-reference.tsx skills/agent-collab/lib/reference.py
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
  // the link badge renders after hydration: clicks after it land
  await page
    .locator('[data-testid=remote-badge], [data-testid=remote-badge-compact]')
    .first()
    .waitFor({ timeout: 20_000 })
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
    const runs = pane.getByRole('table', { name: 'Runs' })
    await runs.waitFor({ timeout: 15_000 })
    expect(await runs.locator('tbody tr').count()).toBeGreaterThan(0)
    const detail = pane.getByRole('region', { name: 'Run detail' })
    // the transcript is open on a wide screen
    await detail
      .getByRole('list', { name: 'Transcript' })
      .locator('li')
      .first()
      .waitFor({ timeout: 15_000 })
    await detail.getByRole('button', { name: 'Launch details' }).click()
    await detail.getByText('Origin session').waitFor()
    await detail.getByRole('button', { name: 'Show initial prompt' }).click()
    await detail.getByRole('button', { name: 'Hide initial prompt' }).waitFor()
    // 复制引用: the reference.py block, ids and run metadata included
    await pane.getByTestId('ticket-copy-reference').click()
    await pane.getByRole('button', { name: 'Copied' }).waitFor()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toMatch(/^\[wezdeck 工单\] /)
    expect(copied).toContain(`id: ${withRun}`)
    expect(copied).toContain('运行合计: ')
    expect(copied).toContain(`ticket api show --id ${withRun}`)
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

  it('phone: run keys, the transcript one tap away', async () => {
    if (!withRun) return // the store copy has no ticket with a run
    const context = await browser.newContext({ ...devices['iPhone 13'] })
    const page = await context.newPage()
    // a phone detail page is full screen: no connection badge to wait for
    await page.goto(`${base}/console/collab/${withRun}?remote=1#pair=${token}`)
    const runs = page.getByRole('list', { name: 'Runs' })
    await runs.getByRole('button').first().waitFor({ timeout: 25_000 })
    const detail = page.getByRole('region', { name: 'Run detail' })
    await detail.waitFor()
    // folded on a phone: the mono log would push everything else away
    expect(await detail.getByRole('list', { name: 'Transcript' }).count()).toBe(
      0,
    )
    await detail.getByRole('button', { name: /^Transcript/ }).click()
    await detail
      .getByRole('list', { name: 'Transcript' })
      .locator('li')
      .first()
      .waitFor()
    await context.close()
  }, 90_000)
})
