// covers: web/src/features/repo-links.tsx
// covers: web/src/features/repo-links-model.ts
// covers: web/src/features/console-interactions-chrome.tsx
// covers: web/src/features/session-list.tsx
// covers: web/src/features/session-info.tsx
// covers: native/wezdeck-wsl/repo_links.go
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 交互调试 › 仓库外链 (sample data): opens the repo links sheet, groups by
// link type, searches with keyboard ↑/↓/Esc, and renders safe target=_blank links.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Repository links sheet', () => {
  let browser: Browser
  let page: Page
  beforeAll(async () => {
    browser = await chromium.launch()
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
    })
    page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#repo-links`)
    await page.getByTestId('repo-links-demo').waitFor({ timeout: 20_000 })
  })
  afterAll(async () => {
    await browser.close()
  })

  it('opens the sheet, groups links, filters, and opens external links', async () => {
    await page.getByTestId('session-repo-links-button').click()
    const sheet = page.getByTestId('repo-links-sheet')
    await sheet.waitFor({ timeout: 5_000 })

    const text = (await sheet.innerText()).replace(/\s+/g, ' ')
    expect(text).toContain('wezdeck · 外链')
    expect(text).toContain('仓库 · 2')
    expect(text).toContain('项目配置 · 1')
    expect(text).toContain('共享 · 1')

    const firstLink = sheet.getByTestId('repo-link-row').first()
    expect(await firstLink.getAttribute('href')).toBe(
      'https://github.com/yunsii/wezterm-config',
    )
    expect(await firstLink.getAttribute('target')).toBe('_blank')
    expect(await firstLink.getAttribute('rel')).toContain('noopener')

    // Search filters across title / url / source, Esc clears query first
    const search = sheet.getByTestId('repo-links-search')
    await search.fill('runbook')
    await expect
      .poll(async () => sheet.getByTestId('repo-link-row').count())
      .toBe(1)
    expect(
      await sheet.getByTestId('repo-link-row').first().getAttribute('href'),
    ).toBe('https://docs.example.com/runbook')

    await search.press('Escape')
    expect(await search.inputValue()).toBe('')
    await expect
      .poll(async () => sheet.getByTestId('repo-link-row').count())
      .toBe(4)

    // ArrowDown moves active highlight; Escape with empty query closes sheet
    await search.press('ArrowDown')
    expect(
      await sheet
        .getByTestId('repo-link-item')
        .nth(1)
        .getAttribute('data-active'),
    ).toBe('')
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'hidden' })
  })
})
