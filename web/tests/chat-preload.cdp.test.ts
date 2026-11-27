// covers: web/src/features/chat-preload.ts web/src/features/chat-controls.tsx
// covers: web/src/features/chat-landing.ts web/src/features/console-sessions.tsx
// covers: web/src/features/chat-thread.tsx web/src/lib/session-cache.ts
import { chromium } from '@playwright/test'
import type { Browser, BrowserContext } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const cors = { 'access-control-allow-origin': '*' }

function makeMessages(total: number) {
  return Array.from({ length: total }, (_, i) => ({
    role: i === 10 || i === 60 ? 'user' : 'assistant',
    text:
      i === 10
        ? '更早一轮的用户提问'
        : i === 60
          ? '最新一轮的用户提问（不该被截断）'
          : `第 ${i} 条回复内容，包含足够的文字高度用来撑起可滚动会话列表。`,
  }))
}

async function mockSessionRuntime(
  context: BrowserContext,
  opts: { failFirstBefore?: boolean; total?: number; initialStart?: number },
) {
  const total = opts.total ?? 120
  const initialStart = opts.initialStart ?? 60
  const all = makeMessages(total)
  const beforeCalls: Array<number> = []
  let failedOnce = false

  await context.route('http://127.0.0.1:35791/**', async (route) => {
    const url = new URL(route.request().url())
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: cors,
        body: JSON.stringify(body),
      })
    if (url.pathname === '/api/v1/health') {
      return json({
        api_version: '1',
        instance_id: 'preload-test',
        ready: true,
        uptime_ms: 60_000,
        capabilities: ['remote.read'],
        observed_at: new Date().toISOString(),
      })
    }
    if (url.pathname === '/api/v1/remote/sessions') {
      return json({
        sessions: [
          {
            id: 'preload-s1',
            agent: 'claude',
            status: 'idle',
            title: '自动预加载测试会话',
            cwd: '/tmp/repo',
            repo_root: '/tmp/repo',
            ts: Date.now(),
          },
        ],
      })
    }
    if (url.pathname === '/api/v1/remote/session') {
      const args = JSON.parse(url.searchParams.get('args') ?? '{}') as {
        before?: number
        since?: number
        limit?: number
      }
      if (typeof args.before === 'number') {
        beforeCalls.push(args.before)
        if (opts.failFirstBefore && !failedOnce) {
          failedOnce = true
          return json({ error: 'temporary relay timeout' }, 500)
        }
        const limit = args.limit ?? 60
        const end = Math.max(0, Math.min(args.before, total))
        const start = Math.max(0, end - limit)
        return json({
          id: 'preload-s1',
          agent: 'claude',
          status: 'idle',
          title: '自动预加载测试会话',
          total,
          start,
          span: 'before',
          messages: all.slice(start, end),
        })
      }
      if (typeof args.since === 'number') {
        return json({
          id: 'preload-s1',
          agent: 'claude',
          status: 'idle',
          title: '自动预加载测试会话',
          total,
          start: total,
          span: 'since',
          messages: [],
        })
      }
      return json({
        id: 'preload-s1',
        agent: 'claude',
        status: 'idle',
        title: '自动预加载测试会话',
        total,
        start: initialStart,
        span: 'full',
        messages: all.slice(initialStart),
      })
    }
    return route.abort()
  })

  return { beforeCalls }
}

describe('Session scroll-up automatic preload and manual fallback', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('preloads earlier messages automatically on scroll-up without jumping the reading anchor', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    })
    const { beforeCalls } = await mockSessionRuntime(context, {
      total: 120,
      initialStart: 60,
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/sessions/preload-s1`)
    await page.locator('[data-msg="119"]').waitFor({ timeout: 15_000 })
    // Wait for progressive hydration to finish rendering all 60 initial messages.
    await expect
      .poll(() => page.locator('[data-msg]').count(), { timeout: 10_000 })
      .toBe(60)
    // Never auto-preloads before the user scrolls up.
    expect(beforeCalls).toEqual([])

    // Scroll up into the top preload zone using real wheel + scroll movement.
    // First pause just outside the preload zone so content-visibility lays out
    // the upper messages, then scroll into the preload zone and capture the
    // visible anchor message.
    await page.evaluate(() => {
      const anchor = document.querySelector<HTMLElement>('[data-msg="60"]')!
      const scroller = anchor.closest<HTMLElement>('.overflow-y-auto')!
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
      scroller.scrollTop = 900
    })
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    )
    expect(beforeCalls).toEqual([])

    const beforeScroll = await page.evaluate(() => {
      const first = document.querySelector<HTMLElement>('[data-msg="60"]')!
      const scroller = first.closest<HTMLElement>('.overflow-y-auto')!
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
      scroller.scrollTop = 260
      const sr = scroller.getBoundingClientRect()
      const visible = [
        ...scroller.querySelectorAll<HTMLElement>('[data-msg]'),
      ].find((el) => el.getBoundingClientRect().bottom > sr.top + 4)!
      return {
        msg: visible.dataset.msg!,
        top: visible.getBoundingClientRect().top,
      }
    })

    await expect.poll(() => beforeCalls.length, { timeout: 10_000 }).toBe(1)
    expect(beforeCalls[0]).toBe(60)
    await expect
      .poll(() => page.locator('[data-msg]').count(), { timeout: 10_000 })
      .toBe(120)

    const after = await page.evaluate((msg) => {
      const anchor = document.querySelector<HTMLElement>(`[data-msg="${msg}"]`)!
      const scroller = anchor.closest<HTMLElement>('.overflow-y-auto')!
      return {
        top: anchor.getBoundingClientRect().top,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      }
    }, beforeScroll.msg)
    // Anchor stays locked to the reader's viewport position after prepend.
    expect(
      Math.abs(after.top - beforeScroll.top),
      JSON.stringify({ beforeScroll, after }),
    ).toBeLessThanOrEqual(4)
    await context.close()
  }, 60_000)

  it('stops auto-retry on failure and recovers via manual fallback button', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    })
    const { beforeCalls } = await mockSessionRuntime(context, {
      total: 120,
      initialStart: 60,
      failFirstBefore: true,
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/sessions/preload-s1`)
    await expect
      .poll(() => page.locator('[data-msg]').count(), { timeout: 10_000 })
      .toBe(60)

    await page.evaluate(() => {
      const anchor = document.querySelector<HTMLElement>('[data-msg="60"]')!
      const scroller = anchor.closest<HTMLElement>('.overflow-y-auto')!
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }))
      scroller.scrollTop = 200
    })

    // First automatic attempt fails, switches fallback button to retry, and does not loop.
    await expect
      .poll(() => page.getByTestId('load-earlier').innerText(), {
        timeout: 10_000,
      })
      .toContain('重试加载更早')
    await page.waitForTimeout(400)
    expect(beforeCalls).toEqual([60])

    // Manual fallback click succeeds and loads the remaining 60 messages.
    await page.getByTestId('load-earlier').click()
    await expect
      .poll(() => page.locator('[data-msg]').count(), { timeout: 10_000 })
      .toBe(120)
    expect(beforeCalls).toEqual([60, 60])
    await context.close()
  }, 60_000)
})
