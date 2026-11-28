// covers: web/src/features/session-stable.ts web/src/features/session-chats.ts
// covers: web/src/features/session-list.tsx web/src/features/session-split.tsx
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium, devices } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// IM chat list holds still: opening a chat does not lift its row; j / k walk
// every chat; an answered unread chat stays
// in the unread sticky set until 会话 is re-tapped. Wide split,
// remote-test-stack.sh only.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''

// These navigation cases share one tmux fixture and run serially.
// eslint-disable-next-line max-lines-per-function
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
      'st-d': ['running'],
    }
    for (const [id, [status, waiting]] of Object.entries(sessions)) {
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

  it('opening a chat keeps order; j / k walk chats; unread sticky keeps answered', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/sessions/st-c?remote=1#pair=${token}`)
    await page.locator('[data-session=st-c]').waitFor({ timeout: 20_000 })
    await expect.poll(async () => (await listed(page)).length).toBe(4)
    // no status filter
    expect(await page.getByRole('radiogroup', { name: '状态' }).count()).toBe(0)
    const before = await listed(page)
    const last = before.at(-1) ?? ''
    await page.locator(`[data-session=${last}]`).click()
    await page.waitForURL(`**/console/sessions/${last}`)
    await page.waitForTimeout(500)
    expect(await listed(page)).toEqual(before)

    const row = page.locator(`[data-session=${last}]`)
    await expect.poll(() => row.getAttribute('class')).toContain('row-selected')
    const box = await row.boundingBox()
    if (box) {
      await page.waitForTimeout(300)
      await page.mouse.move(box.x + 80, box.y + 16)
      await page.mouse.down()
      await page.waitForTimeout(300)
      expect(await row.evaluate((el) => getComputedStyle(el).boxShadow)).toBe(
        'none',
      )
      expect(
        await row.evaluate((el) => getComputedStyle(el, '::before').width),
      ).toBe('3px')
      await page.mouse.up()
    }

    // unread chats float first; j / k still reach every chat in paint order
    await page.locator('[data-session=st-a]').click()
    await opened(page, 'st-a')
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    )
    const order = await listed(page)
    const at = order.indexOf('st-a')
    const next = order[(at + 1) % order.length]
    await page.keyboard.press('j')
    await opened(page, next!)

    // st-b answered: unread badge drops, sticky keeps its place until refresh
    const beforeAnswer = await listed(page)
    expect(beforeAnswer).toContain('st-b')
    entries['st-b'] = {
      ...entries['st-b'],
      status: 'running',
      waiting_kind: '',
    }
    write()
    await expect
      .poll(
        async () => {
          const badge = page
            .locator('[data-session=st-b]')
            .getByTestId('chat-unread')
          return (await badge.count()) === 0
        },
        { timeout: 15_000 },
      )
      .toBe(true)
    expect(await listed(page)).toContain('st-b')
    await context.close()
  }, 60_000)

  it('phone: back from a session keeps the order; re-tapping 会话 keeps the list', async () => {
    const context = await browser.newContext({
      ...devices['Pixel 7'],
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/sessions?remote=1#pair=${token}`)
    await page.locator('[data-session=st-c]').waitFor({ timeout: 20_000 })
    const tree = () =>
      page
        .locator('[data-testid=session-chats] [data-session]')
        .evaluateAll((els) =>
          els
            .map((el) => (el as HTMLElement).dataset.session)
            .filter((id) => id === 'st-c' || id === 'st-d'),
        )
    await expect.poll(async () => (await tree()).length).toBe(2)
    const before = await tree()
    await page.locator('[data-session=st-d]').click()
    await page.waitForURL('**/console/sessions/st-d')
    await page.goBack()
    await page.locator('[data-session=st-c]').waitFor()
    await page.waitForTimeout(500)
    expect(await tree()).toEqual(before)
    await page.getByRole('link', { name: '会话' }).last().click()
    await expect.poll(tree).not.toEqual([])
    await context.close()
  }, 60_000)

  it('phone: first back from a long session keeps the list at its initial top', async () => {
    const context = await browser.newContext({
      ...devices['Pixel 7'],
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/sessions?remote=1#pair=${token}`)
    await page.locator('[data-session=st-c]').waitFor({ timeout: 20_000 })
    await page.addStyleTag({
      content: '#console-main { min-height: 3000px !important; }',
    })
    const scrollTop = () =>
      page.evaluate(() => document.querySelector('.vt-page')?.scrollTop ?? -1)
    expect(await scrollTop()).toBe(0)

    await page
      .locator('[data-session=st-c]')
      .evaluate((el: HTMLElement) => el.click())
    await page.waitForURL('**/console/sessions/st-c')
    await page.evaluate(() => {
      const el = document.querySelector('.vt-page')
      if (el) el.scrollTop = 900
    })
    await expect.poll(scrollTop).toBeGreaterThan(500)
    await page.goBack()
    await page.waitForURL('**/console/sessions?remote=1')
    await expect.poll(scrollTop).toBe(0)
    await page.waitForTimeout(1_100)
    expect(await scrollTop()).toBe(0)

    await page.evaluate(() => {
      const el = document.querySelector('.vt-page')
      if (el) el.scrollTop = 80
    })
    await expect.poll(scrollTop).toBe(80)
    await page
      .locator('[data-session=st-c]')
      .evaluate((el: HTMLElement) => el.click())
    await page.waitForURL('**/console/sessions/st-c')
    await page.evaluate(() => {
      const el = document.querySelector('.vt-page')
      if (el) el.scrollTop = 900
      const samples: Array<{ top: number; transitioning: boolean }> = []
      ;(
        window as Window & { __listReturnFrames?: typeof samples }
      ).__listReturnFrames = samples
      const sample = () => {
        if (
          /\/console\/sessions\/?$/.test(location.pathname) &&
          document.querySelector('[data-testid=session-chats]') &&
          getComputedStyle(
            document.querySelector('[data-testid=session-list-column]')!,
          ).display !== 'none'
        ) {
          samples.push({
            top: document.querySelector('.vt-page')?.scrollTop ?? -1,
            transitioning: document.documentElement.matches(
              ':active-view-transition-type(back)',
            ),
          })
        }
        if (samples.length < 12) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    await page.goBack()
    await page.waitForURL('**/console/sessions?remote=1')
    await expect.poll(scrollTop).toBe(80)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { __listReturnFrames?: Array<unknown> })
              .__listReturnFrames?.length ?? 0,
        ),
      )
      .toBeGreaterThanOrEqual(3)
    expect(
      await page.evaluate(() =>
        (
          window as Window & { __listReturnFrames?: Array<{ top: number }> }
        ).__listReturnFrames?.map((frame) => frame.top),
      ),
    ).toEqual(expect.arrayContaining([80]))
    const returnFrames = await page.evaluate(
      () =>
        (
          window as Window & {
            __listReturnFrames?: Array<{ top: number; transitioning: boolean }>
          }
        ).__listReturnFrames ?? [],
    )
    expect(returnFrames.every((frame) => frame.top === 80)).toBe(true)
    expect(returnFrames.some((frame) => frame.transitioning)).toBe(false)

    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.vt-page')!
      el.scrollTop = el.scrollHeight
    })
    await page.waitForTimeout(100)
    expect(await scrollTop()).toBe(80)
    expect(
      await page.evaluate(
        () =>
          getComputedStyle(document.querySelector('.vt-page')!).overflowAnchor,
      ),
    ).toBe('none')

    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.vt-page')!
      window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      el.scrollTop = 160
      window.dispatchEvent(new Event('resize'))
    })
    await page.waitForTimeout(100)
    expect(await scrollTop()).toBe(160)
    expect(
      await page.evaluate(
        () =>
          getComputedStyle(document.querySelector('.vt-page')!).overflowAnchor,
      ),
    ).toBe('auto')
    await context.close()
  }, 60_000)
})
