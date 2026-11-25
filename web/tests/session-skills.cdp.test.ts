// covers: web/src/features/session-skills.tsx
// covers: web/src/features/composer-complete.tsx
// covers: web/src/features/skill-complete.ts
// covers: web/src/features/console-interactions-skills.tsx
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 交互调试 › 能力与 / 补全 (sample data): the 能力 chip opens the sheet by
// origin, a tap drafts the skill; typing / completes from the keyboard.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Skills and / completion', () => {
  let browser: Browser
  let page: Page
  beforeAll(async () => {
    browser = await chromium.launch()
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
    })
    page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#skills`)
    await page.getByTestId('skills-demo').waitFor({ timeout: 20_000 })
  })
  afterAll(async () => {
    await browser.close()
  })

  it('completes / from the keyboard', async () => {
    const input = page.getByTestId('skills-demo-input')
    await input.click()
    await input.fill('')
    await page.keyboard.type('/')
    const list = page.getByTestId('composer-completions')
    await list.waitFor({ timeout: 5_000 })
    // Claude: its own commands first, then the skills
    expect(await list.locator('[role=option]').first().innerText()).toContain(
      '/compact',
    )
    await page.keyboard.type('rev')
    const options = list.locator('[role=option]')
    await expect
      .poll(async () => (await options.first().innerText()).split('\n')[0])
      .toContain('/adversarial-review')
    expect(await input.getAttribute('role')).toBe('combobox')
    // ↓ moves to the next match, Tab picks it with a trailing space
    await page.keyboard.press('ArrowDown')
    expect(await options.nth(1).getAttribute('aria-selected')).toBe('true')
    await page.keyboard.press('Tab')
    expect(await input.inputValue()).toBe('/code-review ')
    expect(await list.count()).toBe(0)
    // a path is not a command: no list
    await page.keyboard.type('src/lib')
    expect(await list.count()).toBe(0)
  })

  it('Esc closes the list for that token only', async () => {
    const input = page.getByTestId('skills-demo-input')
    await input.fill('')
    await page.keyboard.type('/bra')
    const list = page.getByTestId('composer-completions')
    await list.waitFor({ timeout: 5_000 })
    await page.keyboard.press('Escape')
    expect(await list.count()).toBe(0)
    await page.keyboard.type('i')
    await list.waitFor({ timeout: 5_000 })
    await page.keyboard.press('Enter')
    expect(await input.inputValue()).toBe('/brainstorm ')
  })

  it('the chip opens the sheet by origin; a tap drafts the skill', async () => {
    const input = page.getByTestId('skills-demo-input')
    await input.fill('')
    const chip = page.getByTestId('skills-chip')
    expect((await chip.innerText()).replace(/\s+/g, ' ')).toBe('能力 6')
    await chip.click()
    const sheet = page.getByTestId('skills-sheet')
    await sheet.waitFor({ timeout: 5_000 })
    const text = (await sheet.innerText()).replace(/\s+/g, ' ')
    for (const group of [
      '命令 · 8',
      'WezDeck · 2',
      '本仓库 · 1',
      '用户级 · 1',
      '插件 · 1',
      '内置 · 1',
    ])
      expect(text).toContain(group)
    await sheet.getByRole('searchbox').fill('日志')
    await expect.poll(async () => sheet.locator('[data-skill]').count()).toBe(1)
    await sheet.locator('[data-skill=coco-logs]').click()
    await expect.poll(() => sheet.isVisible()).toBe(false)
    expect(await input.inputValue()).toBe('/coco-logs ')
  })
})
