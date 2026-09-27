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
    expect(await page.getByText('Ops checks').isVisible()).toBe(true)
    expect(await page.getByText('Rime activity').isVisible()).toBe(true)
    expect(
      await page
        .getByRole('heading', { name: 'Overview', exact: true })
        .isVisible(),
    ).toBe(true)
    await page.getByRole('link', { name: 'Development' }).click()
    await page.waitForURL('**/console/development')
    await page
      .getByRole('button', { name: 'Jump to WezTerm pane' })
      .first()
      .waitFor({ state: 'visible' })
    expect(
      await page.getByText('Agent sessions', { exact: true }).isVisible(),
    ).toBe(true)
    expect(
      await page.getByText('VS Code windows', { exact: true }).isVisible(),
    ).toBe(true)
    expect(
      await page.getByRole('heading', { name: 'Local tools' }).isVisible(),
    ).toBe(true)
    expect(await page.getByText('Chrome debug').isVisible()).toBe(true)
    expect(
      await page.getByRole('button', { name: 'Jump to WezTerm pane' }).count(),
    ).toBeGreaterThan(0)
    await page.getByRole('link', { name: 'Overview' }).click()
    await page.waitForURL('http://127.0.0.1:3000/console')
  })

  it('switches language and theme without a reload', async () => {
    await page.goto('http://127.0.0.1:3000/console', {
      waitUntil: 'domcontentloaded',
    })
    await page.getByRole('button', { name: '中文' }).click()
    await page.waitForURL('**/zh/console')
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN')
    expect(await page.locator('body').innerText()).toContain('Runtime 总览')

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
    expect(
      await page.getByRole('heading', { name: 'Runtime overview' }).isVisible(),
    ).toBe(true)

    await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' })
    const example = page.getByRole('tab', { name: /team-stat/ })
    await example.click()
    expect(await example.getAttribute('aria-selected')).toBe('true')
    expect(await page.locator('#landing-session-detail').innerText()).toContain(
      'team-stat',
    )
    expect(await page.locator('.landing-signal-list').innerText()).toContain(
      'Runtime',
    )
  })
})
