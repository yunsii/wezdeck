// covers: web/src/features/session-stable.ts web/src/features/session-order.ts
// covers: web/src/features/session-list.tsx web/src/features/session-split.tsx
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The session list holds still while you use it (session-stable.ts): opening
// a session (a visit) does not lift its group, j / k walk the rows the
// current filter shows, and a row shown under 等你 stays after it is
// answered until the filter changes. Wide split, remote-test-stack.sh only
// (throwaway attention file, tmux panes made here).
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''

describe.runIf(attention)('A session list that holds still', () => {
  let browser: Browser
  const socket = join(mkdtempSync(join(tmpdir(), 'wd-st-')), 'sock')
  const tmux = (...args: Array<string>) =>
    execFileSync('tmux', ['-S', socket, ...args])
      .toString()
      .trim()
  const entries: Record<string, Record<string, unknown>> = {}
  const write = () => {
    writeFileSync(attention, JSON.stringify({ entries }))
  }

  beforeAll(async () => {
    const sessions: Record<string, [string, string?]> = {
      'st-a': ['waiting', 'question'],
      'st-b': ['waiting', 'permission'],
      'st-c': ['running'],
      // a second group outside the waiting band, so a visit could reorder
      'st-d': ['running'],
    }
    for (const [id, [status, waiting]] of Object.entries(sessions)) {
      // one worktree each (cwd basename), so each is its own group
      const cwd = join(dirname(socket), id)
      mkdirSync(cwd)
      tmux(
        'new-session',
        '-d',
        '-s',
        id,
        '-c',
        cwd,
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
        status,
        waiting_kind: waiting ?? '',
        agent_name: 'claude',
        tmux_window_name: id,
        last_user_prompt: `prompt ${id}`,
        ts: Date.now(),
      }
    }
    write()
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser.close()
    tmux('kill-server')
  })

  // the URL moves before the list re-renders: wait for the row to be marked
  const opened = async (page: Page, id: string) => {
    await page.waitForURL(`**/console/sessions/${id}`)
    await expect
      .poll(() =>
        page
          .locator(`[data-session=${id}]`)
          .first()
          .getAttribute('aria-current'),
      )
      .toBe('page')
  }
  const listed = (page: Page) =>
    page
      .locator('.vt-split-list [data-session]')
      .evaluateAll((els) =>
        els.map((el) => (el as HTMLElement).dataset.session),
      )

  it('order holds on a visit; j / k follow the filter; answered rows stay', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/sessions/st-c?remote=1#pair=${token}`)
    await page.locator('[data-session=st-c]').waitFor({ timeout: 20_000 })
    await page.getByRole('radio', { name: /^全部/ }).click()
    await expect.poll(async () => (await listed(page)).length).toBe(4)
    const before = await listed(page)
    // open the last row: a visit, which used to lift its group to the top
    const last = before.at(-1) ?? ''
    expect(last).toBe('st-d')
    await page.locator(`[data-session=${last}]`).click()
    await page.waitForURL(`**/console/sessions/${last}`)
    await page.waitForTimeout(500)
    expect(await listed(page)).toEqual(before)
    // pressing the open row (running, as reported; a waiting row is swipe-
    // to-clear, whose pointer handling keeps :active off): the bar stays, no veil (it flashed)
    const row = page.locator('[data-session=st-d]')
    await expect.poll(() => row.getAttribute('class')).toContain('row-selected')
    const box = await row.boundingBox()
    if (box) {
      // .key-press eases box-shadow over 120 ms: read settled values
      await page.waitForTimeout(300)
      await page.mouse.move(box.x + 80, box.y + 16)
      await page.mouse.down()
      await page.waitForTimeout(300)
      expect(
        await row.evaluate((el) => getComputedStyle(el).boxShadow),
      ).toMatch(/^rgb\(\d+, \d+, \d+\) 3px 0px 0px 0px inset$/)
      await page.mouse.up()
    }

    // 等你: j / k cycle st-a / st-b only, never the running st-c / st-d
    await page.getByRole('radio', { name: /^等你/ }).click()
    await expect.poll(() => listed(page)).toEqual(['st-a', 'st-b'].sort())
    await page.locator('[data-session=st-a]').click()
    await opened(page, 'st-a')
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    )
    for (const want of ['st-b', 'st-a', 'st-b']) {
      await page.keyboard.press('j')
      await opened(page, want)
    }

    // st-b answered (running): still listed under 等你 until the filter changes
    entries['st-b'] = {
      ...entries['st-b'],
      status: 'running',
      waiting_kind: '',
    }
    write()
    await expect
      .poll(() => page.getByRole('radio', { name: /^等你/ }).textContent(), {
        timeout: 15_000,
      })
      .toMatch(/1$/)
    expect(await listed(page)).toContain('st-b')
    await page.getByRole('radio', { name: /^全部/ }).click()
    await page.getByRole('radio', { name: /^等你/ }).click()
    await expect.poll(() => listed(page)).toEqual(['st-a'])
    await context.close()
  }, 60_000)
})
