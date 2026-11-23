import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 架构解析 (/architecture, features/architecture): public, no pairing. A desk
// window draws each diagram on a React Flow canvas and a card opens its
// notes; a phone gets the step lists only and never loads the canvas.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

// Mirrored Windows adapters flapping make WSL Chromium drop loads with
// ERR_NETWORK_CHANGED (diagnostics open question); retry spaced out.
async function open(page: Page, url: string, ready: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url)
      await page
        .locator(ready)
        .first()
        .waitFor({ state: 'attached', timeout: 15_000 })
      // the markup is server-rendered: wait for hydration before clicking
      await page.waitForLoadState('networkidle')
      return
    } catch (error) {
      if (attempt >= 3) throw error
      await page.waitForTimeout(1_000)
    }
  }
}

describe('Architecture page', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('desk: five canvases; a card opens its notes, the list follows', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await open(
      page,
      `${base}/zh/architecture`,
      '#open-session .react-flow__node-card',
    )
    expect(await page.locator('.react-flow').count()).toBe(5)
    const card = page.locator('#open-session .react-flow__node-card').nth(5)
    await card.scrollIntoViewIfNeeded()
    await card.click()
    const panel = page.locator('#open-session aside')
    await expect.poll(() => panel.count()).toBe(1)
    expect(await panel.textContent()).toContain('只要缺的')
    // the same card is open in the step list (the keyboard path)
    expect(
      await page.locator('#open-session li [aria-expanded=true]').count(),
    ).toBe(1)
    // the step list works from the keyboard: Enter on another step moves the selection
    const step = page.locator('#open-session li button[aria-expanded]').first()
    await step.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => panel.textContent()).toContain('先显示缓存')
    await context.close()
  })

  it('phone: step lists, no canvas; capability tables fold', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await open(page, `${base}/zh/architecture`, '#capabilities')
    expect(await page.locator('.react-flow').count()).toBe(0)
    expect(
      await page.locator('#send-message li button[aria-expanded]').count(),
    ).toBe(8)
    const group = page.locator('#capabilities [aria-expanded]').first()
    await group.click()
    await expect
      .poll(() => page.locator('#capabilities dl').first().isVisible())
      .toBe(true)
    expect(
      await page.locator('#capabilities dl').first().textContent(),
    ).toContain('/api/v1/health')
    // an open group stays inside the screen: no sideways scroll
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true)
    await context.close()
  })

  it('the landing page links here', async () => {
    const context = await browser.newContext({ locale: 'zh-CN' })
    const page = await context.newPage()
    await open(page, `${base}/zh`, 'a[href$="/architecture"]')
    expect(
      await page.locator('a[href$="/zh/architecture"]').count(),
    ).toBeGreaterThan(0)
    await context.close()
  })
})
