// covers: web/src/features/pwa-boot.tsx web/src/features/me-app.tsx web/src/features/console-shell.tsx
// covers: web/src/features/console-status-band.tsx web/src/features/console-keys.tsx
// covers: web/src/features/remote-badge.tsx web/src/features/landing-page.tsx web/src/features/public-header.tsx
// covers: web/src/features/console-me.tsx web/src/features/me-entry-row.tsx
// covers: web/src/features/me-host.tsx web/src/features/host-quick-controls.tsx web/src/features/me-autotitle.tsx
// covers: web/src/features/inspector.tsx web/public/*
import { chromium, devices } from '@playwright/test'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// PWA shell + phone / desktop interaction (docs/web-pwa.md), against the
// remote link (same setup as remote.cdp.test.ts: dev server or the deployed
// site + a connected `wezdeck-wsl relay`). WEZDECK_PWA_PROD=1 adds the
// service-worker / offline checks, which need a production build.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const prod = process.env.WEZDECK_PWA_PROD === '1'

// Mirrored Windows adapters flapping make WSL Chromium drop loads with
// ERR_NETWORK_CHANGED (diagnostics open question); retry spaced out.
async function open(page: Page, url: string, ready: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url)
      await page.locator(ready).first().waitFor({ timeout: 15_000 })
      return
    } catch (error) {
      if (attempt >= 3) throw error
      await page.waitForTimeout(1_000)
    }
  }
}

async function assertDesktopRailFits(browser: Browser) {
  for (const { locale, path } of [
    { locale: 'zh-CN', path: '/zh/console/collab' },
    { locale: 'en-US', path: '/console/collab' },
  ]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 600 },
      locale,
    })
    const page = await context.newPage()
    await open(
      page,
      `${base}${path}?remote=1#pair=${token}`,
      '[data-testid=keys-entry]',
    )
    await page.evaluate(() => document.fonts.ready)
    const metrics = await page.evaluate(() => {
      const aside = document.querySelector('aside.vt-sidebar')!
      const nav = aside.querySelector('nav')!
      const asideRect = aside.getBoundingClientRect()
      const navRect = nav.getBoundingClientRect()
      const controls = [
        ...aside.querySelectorAll<HTMLElement>('nav a, nav button'),
      ].map((el) => {
        const rect = el.getBoundingClientRect()
        const label = el.querySelector<HTMLElement>('span.truncate')
        const labelRect = label?.getBoundingClientRect()
        return {
          text: el.textContent.trim(),
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          labelRight: labelRect?.right ?? rect.right,
          labelScrollWidth: label?.scrollWidth ?? 0,
          labelClientWidth: label?.clientWidth ?? 0,
        }
      })
      return {
        navLeft: navRect.left,
        navRight: navRect.right,
        asideBottom: asideRect.bottom,
        controls,
      }
    })
    expect(metrics.controls.length).toBeGreaterThanOrEqual(4)
    const primaryWidth = metrics.controls[0].width
    for (const control of metrics.controls) {
      expect(control.left, control.text).toBeGreaterThanOrEqual(
        metrics.navLeft - 0.5,
      )
      expect(control.right, control.text).toBeLessThanOrEqual(
        metrics.navRight + 0.5,
      )
      expect(control.bottom, control.text).toBeLessThanOrEqual(
        metrics.asideBottom + 1,
      )
      expect(
        Math.abs(control.width - primaryWidth),
        control.text,
      ).toBeLessThanOrEqual(1)
      expect(control.labelRight, control.text).toBeLessThanOrEqual(
        control.right + 0.5,
      )
      expect(control.labelScrollWidth, control.text).toBeLessThanOrEqual(
        control.labelClientWidth + 1,
      )
    }
    // Boundary: even an overlong label must stay clamped inside nav (grid-cols-1)
    // and never widen sibling footer items past the rail edge.
    const clamped = await page.evaluate(() => {
      const aside = document.querySelector('aside.vt-sidebar')!
      const navRight = aside.querySelector('nav')!.getBoundingClientRect().right
      const keysBtn = aside.querySelector<HTMLElement>(
        '[data-testid=keys-entry]',
      )!
      const label = keysBtn.querySelector<HTMLElement>('span.truncate')!
      const prev = label.textContent
      label.textContent = '键盘快捷键超出边界测试'
      const keysRight = keysBtn.getBoundingClientRect().right
      const footerMaxRight = Math.max(
        ...[...keysBtn.parentElement!.children].map(
          (el) => el.getBoundingClientRect().right,
        ),
      )
      label.textContent = prev
      return { navRight, keysRight, footerMaxRight }
    })
    expect(clamped.keysRight).toBeLessThanOrEqual(clamped.navRight + 0.5)
    expect(clamped.footerMaxRight).toBeLessThanOrEqual(clamped.navRight + 0.5)
    await context.close()
  }
}

async function assertMeSectionLayouts(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
  })
  const cors = { 'access-control-allow-origin': '*' }
  await context.route('http://127.0.0.1:35791/**', async (route) => {
    const url = new URL(route.request().url())
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: cors,
        body: JSON.stringify(body),
      })
    if (url.pathname === '/api/v1/health')
      return json({
        api_version: '1',
        instance_id: 'test-runtime',
        ready: true,
        uptime_ms: 120_000,
        capabilities: ['remote.read', 'wsl.status'],
        observed_at: new Date().toISOString(),
      })
    if (url.pathname === '/api/v1/wsl/status')
      return json({ available: true, socket: '/tmp/test.sock', pid: 42 })
    if (url.pathname === '/api/v1/remote/host.warp.status')
      return json({ state: 'connected' })
    if (url.pathname === '/api/v1/remote/host.oppo.status')
      return json({ active: false, last_result: 'connected' })
    if (url.pathname === '/api/v1/remote/session.autotitle.status')
      return json({
        enabled: true,
        provider: '',
        effective_provider: 'grok',
        effective_model: 'grok-fast',
        interval_s: 60,
        providers: [
          { id: 'grok', available: true, model: 'grok-fast' },
          { id: 'claude', available: true, model: 'claude-haiku' },
        ],
        entries: [
          {
            session_id: 'long-title-session',
            agent: 'claude',
            title:
              '一个非常非常长用来验证单列网格不会把右侧操作按钮挤出卡片容器边界的会话标题示例文字',
            source: 'auto',
            provider: 'grok',
            updated_at: Date.now(),
            user_turns: 4,
            active: true,
            history: [
              {
                at: Date.now(),
                title: '初始任务标题',
                source: 'auto',
                provider: 'grok',
                user_turns: 1,
              },
            ],
          },
        ],
      })
    return route.abort()
  })
  const page = await context.newPage()
  for (const { path, ready } of [
    {
      path: '/zh/console/me/host',
      ready: '[data-me-page=host] h2.section-heading',
    },
    {
      path: '/zh/console/me/autotitle',
      ready: '[data-testid=autotitle-page] h2.section-heading',
    },
  ]) {
    await open(page, `${base}${path}`, ready)
    const report = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>('[data-testid=me-pane]')!
      const deckBg = getComputedStyle(
        document.querySelector<HTMLElement>('.vt-page')!,
      ).backgroundColor
      const paneRect = pane.getBoundingClientRect()
      const headings = [
        ...pane.querySelectorAll<HTMLElement>('h2.section-heading'),
      ].map((el) => ({
        text: el.textContent.trim(),
        bg: getComputedStyle(el).backgroundColor,
        right: el.getBoundingClientRect().right,
      }))
      const buttons = [
        ...pane.querySelectorAll<HTMLElement>('[data-me-page] li button'),
      ].map((el) => ({
        text: el.textContent.trim(),
        right: el.getBoundingClientRect().right,
      }))
      return { deckBg, paneRight: paneRect.right, headings, buttons }
    })
    expect(report.headings.length).toBeGreaterThanOrEqual(2)
    for (const h of report.headings) {
      expect(h.bg, h.text).toBe(report.deckBg)
      expect(h.right, h.text).toBeLessThanOrEqual(report.paneRight + 0.5)
    }
    for (const btn of report.buttons) {
      expect(btn.right, btn.text).toBeLessThanOrEqual(report.paneRight + 0.5)
    }
  }
  await context.close()
}

describe('PWA shell on phone and desktop', () => {
  let browser: Browser
  let phone: BrowserContext

  beforeAll(async () => {
    browser = await chromium.launch()
    phone = await browser.newContext({
      ...devices['iPhone 13'],
      locale: 'zh-CN',
    })
  })

  afterAll(async () => {
    await browser.close()
  })

  it('phone: bottom tabs, list pushes detail, back returns', async () => {
    const page = await phone.newPage()
    await open(
      page,
      `${base}/zh/console/collab?remote=1#pair=${token}`,
      'main[data-remote-mode]',
    )
    // mobile no longer shows a persistent connection badge in page headers
    expect(
      await page.locator('[data-testid=remote-badge-compact]').count(),
    ).toBe(0)
    // data-remote-mode appears only after hydration, so the segment click lands
    await page.locator('[data-value=ended]').click()
    await page.locator('[data-ticket]').first().waitFor({ timeout: 15_000 })
    const tabs = page.getByRole('navigation', { name: '栏目' })
    expect(await tabs.getByRole('link').count()).toBe(3)
    const first = page.locator('[data-ticket]').first()
    const id = await first.getAttribute('data-ticket')
    await first.click()
    await page.waitForURL(`**/console/collab/${id}`)
    expect(
      await page.locator('[data-testid=remote-badge-compact]').count(),
    ).toBe(0)
    await page.getByRole('button', { name: '返回' }).click()
    await page.waitForURL(/\/console\/collab(\?[^/]*)?$/)
    await tabs.getByRole('link', { name: /会话/ }).click()
    await page.waitForURL(/\/console\/sessions$/)
    expect(
      await page.locator('[data-testid=remote-badge-compact]').count(),
    ).toBe(0)
    await tabs.getByRole('link', { name: /我的/ }).click()
    await page.waitForURL(/\/console\/me$/)
    const menuIcons = await page
      .locator('[data-me]')
      .evaluateAll((rows) =>
        rows.map((row) => row.querySelectorAll(':scope > svg').length),
      )
    expect(menuIcons.length).toBeGreaterThan(5)
    expect(menuIcons.every((count) => count === 2)).toBe(true)
    // connection status still lives on the 我的 › 连接 row, not in sub-page headers
    await page
      .locator('[data-me=connection] [data-testid=remote-badge-compact]')
      .waitFor({ timeout: 5_000 })
    await page.locator('[data-me=app]').click()
    await page.waitForURL(/\/console\/me\/app$/)
    await page.locator('[data-me-page=app]').waitFor({ timeout: 5_000 })
    expect(
      await page.locator('[data-testid=remote-badge-compact]').count(),
    ).toBe(0)
    await tabs.getByRole('link', { name: /工单/ }).click()
    await page.waitForURL(/\/console\/collab$/)
    await page.getByRole('link', { name: '工单动态' }).click()
    await page.waitForURL(/\/console\/activity$/)
    await page
      .getByRole('heading', { name: '工单动态' })
      .first()
      .waitFor({ timeout: 15_000 })
    // a page under 工单 on a phone, not a tab: back returns to 工单 (it was
    // collapsed onto the first entry and back left the PWA)
    await page.goBack()
    await page.waitForURL(/\/console\/collab$/)
    // 运行与花费 opens in a sheet
    await page.getByRole('button', { name: /运行与花费/ }).click()
    await page.getByRole('dialog').waitFor({ timeout: 5_000 })
    await page.close()
  }, 60_000)

  it('phone 320px: settings icons and labels stay within the row', async () => {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      viewport: { width: 320, height: 700 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await open(
      page,
      `${base}/zh/console/me?remote=1#pair=${token}`,
      '[data-me=agents]',
    )
    const rows = await page.locator('[data-me]').evaluateAll((links) =>
      links.map((link) => {
        const icons = link.querySelectorAll(':scope > svg')
        const label = link.querySelector('span')!
        return {
          icons: icons.length,
          iconRight: icons[0].getBoundingClientRect().right,
          labelLeft: label.getBoundingClientRect().left,
          right: link.getBoundingClientRect().right,
          viewport: document.documentElement.clientWidth,
        }
      }),
    )
    expect(rows.length).toBeGreaterThan(5)
    expect(
      rows.every(
        (row) =>
          row.icons === 2 &&
          row.iconRight < row.labelLeft &&
          row.right <= row.viewport + 1,
      ),
    ).toBe(true)
    await context.close()
  })

  it(
    'desktop: rail items stay inside narrow sidebar without clipping or horizontal overflow',
    () => assertDesktopRailFits(browser),
    60_000,
  )

  it(
    'desktop: host and autotitle section headings blend with deck and keep rows in bounds',
    () => assertMeSectionLayouts(browser),
    60_000,
  )

  it('desktop: j / k move the selection and the URL follows', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    const page = await context.newPage()
    await open(
      page,
      `${base}/console/collab?remote=1#pair=${token}`,
      'main[data-remote-mode]',
    )
    // The main mode appears after hydration, so the segment click lands.
    await page.locator('[data-value=ended]').click()
    // a split like 会话: link rows beside the ticket, j moves on (global)
    const rows = page.locator('a[data-ticket]')
    await rows.first().waitFor({ timeout: 15_000 })
    const second = await rows.nth(1).getAttribute('data-ticket')
    await rows.first().click()
    await page.waitForURL(/\/console\/collab\/req-/)
    // focus outside the list column (bottom-right whitespace, not a run row)
    await page.mouse.click(1400, 850)
    await page.keyboard.press('j')
    await page.waitForURL(`**/console/collab/${second ?? ''}`)
    await page.keyboard.press('g')
    await page.keyboard.press('a')
    await page.waitForURL(/\/console\/activity$/)
    await context.close()
  }, 60_000)

  it.runIf(prod)(
    'installable, worker controls the page, reopens offline with cached tickets',
    async () => {
      const context = await browser.newContext({
        ...devices['Pixel 7'],
        locale: 'zh-CN',
      })
      const page = await context.newPage()
      const manifest = (await (
        await page.request.get(`${base}/manifest.webmanifest`)
      ).json()) as { start_url: string; icons: Array<{ purpose?: string }> }
      expect(manifest.start_url).toBe('/console/sessions')
      expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(
        true,
      )
      await open(
        page,
        `${base}/zh/console/inbox?remote=1#pair=${token}`,
        '[data-ticket]',
      )
      await page.evaluate(() => navigator.serviceWorker.ready)
      await page.reload()
      expect(
        await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      ).toBe(true)
      // let the persister flush (1 s throttle), then go offline
      await page.waitForTimeout(2_500)
      await context.setOffline(true)
      await page.reload()
      await page.locator('[data-ticket]').first().waitFor({ timeout: 20_000 })
      await page
        .locator('[data-testid=freshness][data-stale=true]')
        .waitFor({ timeout: 20_000 })
      await context.close()
    },
    90_000,
  )
})
