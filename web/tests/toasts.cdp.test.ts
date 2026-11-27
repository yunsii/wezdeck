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

  for (const colorScheme of ['dark', 'light'] as const) {
    it(`keeps description text high-contrast in ${colorScheme} mode`, async () => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        locale: 'zh-CN',
        colorScheme,
      })
      const page = await context.newPage()
      await page.goto(`${base}/zh/console/me/interactions#toasts`)
      const updated = page.locator('[data-toast-kind=updated]')
      await updated.waitFor({ timeout: 20_000 })
      await updated.click()
      const desc = page.locator('[data-sonner-toast] .deck-toast-description')
      await desc.waitFor({ timeout: 3_000 })
      const contrast = await desc.evaluate((el) => {
        const parse = (css: string) => {
          const canvas = document.createElement('canvas')
          canvas.width = 1
          canvas.height = 1
          const ctx = canvas.getContext('2d')!
          ctx.fillStyle = css
          ctx.fillRect(0, 0, 1, 1)
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
          return [r, g, b, a / 255] as const
        }
        const card = el.closest('[data-sonner-toast]')!
        const [br, bg, bb] = parse(getComputedStyle(card).backgroundColor)
        const [fr, fg, fb, fa] = parse(getComputedStyle(el).color)
        const blend = (f: number, b: number) => f * fa + b * (1 - fa)
        const lum = (r: number, g: number, b: number) => {
          const c = [r, g, b].map((v) => {
            const s = v / 255
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
          })
          return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
        }
        const lBg = lum(br, bg, bb)
        const lFg = lum(blend(fr, br), blend(fg, bg), blend(fb, bb))
        const [hi, lo] = lBg > lFg ? [lBg, lFg] : [lFg, lBg]
        return (hi + 0.05) / (lo + 0.05)
      })
      expect(contrast).toBeGreaterThanOrEqual(4.5)
      await context.close()
    })
  }
})
