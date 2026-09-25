import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const webUrl = process.env.WEZDECK_WEB_URL || 'http://127.0.0.1:3000/console'
const cdpUrl = process.env.WEZDECK_CDP_URL || 'http://127.0.0.1:9222'

describe('Runtime Console through an existing Chromium CDP session', () => {
  let browser: Browser
  let page: Page
  let createdPage = false
  let savedStorage: { locale: string | null; theme: string | null } = {
    locale: null,
    theme: null,
  }

  beforeAll(async () => {
    browser = await chromium.connectOverCDP(cdpUrl)
    const context = browser.contexts()[0]
    page = await context.newPage()
    createdPage = true
    await page.goto(webUrl, { waitUntil: 'domcontentloaded' })
    savedStorage = await page.evaluate(() => ({
      locale: localStorage.getItem('wezdeck-locale'),
      theme: localStorage.getItem('wezdeck-theme'),
    }))
    await page.waitForFunction(() => document.body.innerText.includes('Online'))
  })

  afterAll(async () => {
    if (createdPage) {
      await page.evaluate((storage) => {
        if (storage.locale === null) localStorage.removeItem('wezdeck-locale')
        else localStorage.setItem('wezdeck-locale', storage.locale)
        if (storage.theme === null) localStorage.removeItem('wezdeck-theme')
        else localStorage.setItem('wezdeck-theme', storage.theme)
      }, savedStorage)
      await page.close()
    }
    // Keep the user's existing browser alive; the Vitest process disconnects
    // when it exits.
  })

  it('renders the local Runtime health and Rime snapshot', async () => {
    expect(await page.getByText('Online').isVisible()).toBe(true)
    expect(await page.getByText('Rime today').isVisible()).toBe(true)
    expect(await page.getByText('Current local day').isVisible()).toBe(true)
    expect(await page.getByText('Rime commits').isVisible()).toBe(true)
  })

  it('switches language and theme without a reload', async () => {
    await page.getByRole('button', { name: '中文' }).click()
    await page.waitForURL('**/zh/console')
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN')
    expect(await page.locator('body').innerText()).toContain('Runtime 控制台')

    await page.getByRole('button', { name: '亮色主题' }).click()
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light')

    await page.getByRole('button', { name: 'English' }).click()
    await page.waitForURL('http://127.0.0.1:3000/console')
    await page.getByRole('button', { name: 'Dark theme' }).click()
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark')
  })

  it('keeps the marketing page and Runtime Console on separate routes', async () => {
    await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' })
    expect(
      await page.getByRole('heading', { name: 'WezDeck' }).isVisible(),
    ).toBe(true)
    expect(
      await page
        .getByRole('link', { name: 'Open Runtime Console' })
        .getAttribute('href'),
    ).toBe('/console')

    await page.goto('http://127.0.0.1:3000/console', {
      waitUntil: 'domcontentloaded',
    })
    expect(await page.getByText('Runtime Console').first().isVisible()).toBe(
      true,
    )

    await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Light theme' }).click()
    expect(await page.locator('.console-preview-light').isVisible()).toBe(true)
    expect(await page.locator('.console-preview-dark').isVisible()).toBe(false)
    await page.getByRole('button', { name: 'Dark theme' }).click()
    expect(await page.locator('.console-preview-dark').isVisible()).toBe(true)
    expect(await page.locator('.console-preview-light').isVisible()).toBe(false)
  })
})
