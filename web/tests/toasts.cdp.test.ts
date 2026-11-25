// covers: web/src/features/pwa-boot.tsx web/src/styles/deck.css
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Toasts (交互调试 › 消息提示): the deck's own card (ink, like the user's
// message), the action a pill, an error with its icon.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Toasts', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('every kind renders as the deck card', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
      colorScheme: 'dark',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#toasts`)
    const action = page.locator('[data-toast-kind=action]')
    await action.waitFor({ timeout: 20_000 })
    await action.click()
    const card = page.locator('[data-sonner-toast]').first()
    await card.waitFor({ timeout: 3_000 })
    const look = await card.evaluate((el) => {
      const style = getComputedStyle(el)
      const ink = getComputedStyle(document.documentElement)
        .getPropertyValue('--brand-text')
        .trim()
      return {
        deck: el.classList.contains('deck-toast'),
        border: style.borderTopWidth,
        background: style.backgroundColor,
        ink,
        pill: el.querySelector('.deck-toast-action') !== null,
      }
    })
    expect(look.deck).toBe(true)
    expect(look.border).toBe('0px')
    expect(look.pill).toBe(true)
    // #f1f3f6 (the dark theme's ink)
    expect(look.background).toBe('rgb(241, 243, 246)')
    await page.locator('[data-toast-kind=error]').click()
    await expect
      .poll(() => page.locator('[data-sonner-toast] .text-brand-error').count())
      .toBeGreaterThan(0)
    await context.close()
  })
})
