// covers: web/src/features/console-interactions*
// covers: web/src/features/session-permission.tsx
// covers: web/src/features/session-elicitation.tsx
// covers: web/src/features/session-ask-claude.tsx
// covers: web/src/features/console-me.tsx
// covers: web/src/components/ui/disclosure.tsx
// covers: web/src/features/chat-tools.tsx
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 交互调试 (我的 › 交互调试, /console/me/interactions): every
// special interaction rendered from sample data; taps only go to the key
// log, nothing reaches a pane, so no stack state is needed.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Interaction debugging page', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  const IDS = [
    'claude-ask',
    'claude-ask-review',
    'grok-ask',
    'permission-bash',
    'permission-edit',
    'plan-approval',
    'grok-plan',
    'generic-keys',
    'progress',
    'to-background',
    'compaction',
    'slash',
    'diff',
  ]

  it('wide: a 我的 page, list beside detail, taps land in the log', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions`)
    const detail = page.getByTestId('interaction-detail')
    await detail.waitFor({ timeout: 20_000 })
    // it belongs to 我的, not to 工单 (the shell's fallback section)
    expect(await page.locator('[data-me-page=interactions]').count()).toBe(1)
    await expect
      .poll(() =>
        page.locator('nav a[aria-current=page]').first().textContent(),
      )
      .toContain('我的')
    for (const id of IDS)
      expect(
        await page.locator(`button[data-interaction=${id}]`).count(),
        id,
      ).toBe(1)
    expect(await detail.getAttribute('data-interaction')).toBe('claude-ask')
    // a click before hydration does nothing: retry until the detail moves
    const item = page.locator('button[data-interaction=permission-bash]')
    await expect
      .poll(async () => {
        await item.click()
        return detail.getAttribute('data-interaction')
      })
      .toBe('permission-bash')
    await detail.getByRole('button', { name: '允许' }).click()
    await expect
      .poll(() => page.getByTestId('interaction-log').textContent())
      .toContain('permission-bash → 1')
    // the selection is in the hash: a link opens that one
    expect(page.url()).toContain('#permission-bash')
    await page.goto(`${base}/zh/console/me/interactions#plan-approval`)
    await expect
      .poll(() =>
        page.getByTestId('interaction-detail').getAttribute('data-interaction'),
      )
      .toBe('plan-approval')
    await context.close()
  })

  it('phone: the list first, an item opens, back returns to the list', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions`)
    const item = page.locator('button[data-interaction=grok-plan]')
    await item.waitFor({ timeout: 20_000 })
    expect(await page.getByTestId('interaction-detail').count()).toBe(0)
    await expect
      .poll(async () => {
        await item.click().catch(() => {})
        return page.getByTestId('interaction-detail').count()
      })
      .toBe(1)
    // the system back returns to the list, still on 交互调试
    await page.goBack()
    await expect
      .poll(() => page.getByTestId('interaction-detail').count())
      .toBe(0)
    expect(await page.locator('[data-me-page=interactions]').count()).toBe(1)
    // and so does the header's back arrow
    await item.click()
    await page.getByTestId('interaction-detail').waitFor()
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect
      .poll(() => page.getByTestId('interaction-detail').count())
      .toBe(0)
    expect(await page.locator('[data-me-page=interactions]').count()).toBe(1)
    await context.close()
  })

  it('转到后台 sits top-right; the command flows around it', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#to-background`)
    const detail = page.getByTestId('interaction-detail')
    await detail.waitFor({ timeout: 20_000 })
    const buttons = detail.getByTestId('to-background')
    await expect.poll(() => buttons.count()).toBe(2)
    // open the long command: its text wraps (pre-wrap) under the button
    const long = detail.locator('button[aria-expanded]', {
      hasText: 'lingui extract',
    })
    await expect
      .poll(async () => {
        await long.click()
        return long.getAttribute('aria-expanded')
      })
      .toBe('true')
    const layout = await detail.evaluate((root) =>
      [...root.querySelectorAll('[data-testid=to-background]')].map((b) => {
        const row = b.parentElement!.parentElement!.getBoundingClientRect()
        const button = b.getBoundingClientRect()
        const trigger = b.parentElement!.parentElement!.querySelector(
          'button[aria-expanded]',
        )!
        const spacer = trigger.querySelector('.float-right')!
        // the command's own text, not the invisible spacer's
        const walker = document.createTreeWalker(trigger, NodeFilter.SHOW_TEXT)
        const lines: Array<DOMRect> = []
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (spacer.contains(n)) continue
          const range = document.createRange()
          range.selectNodeContents(n)
          lines.push(...range.getClientRects())
        }
        const hits = (r: DOMRect) =>
          r.width > 0 &&
          r.top < button.bottom - 1 &&
          r.bottom > button.top + 1 &&
          r.right > button.left + 1 &&
          r.left < button.right - 1
        return {
          corner:
            Math.abs(button.top - row.top) < 2 &&
            Math.abs(button.right - row.right) < 2,
          spacerMatches:
            Math.abs(spacer.getBoundingClientRect().width - button.width) < 1,
          // some text runs under the button, past its left edge
          flowsUnder: lines.some(
            (r) => r.top >= button.bottom - 1 && r.right > button.left + 8,
          ),
          // nothing overlaps the button
          clear: !lines.some(hits),
        }
      }),
    )
    const [short, longRow] = layout
    expect(short.corner).toBe(true)
    expect(short.spacerMatches).toBe(true)
    expect(short.clear).toBe(true)
    expect(longRow.corner).toBe(true)
    expect(longRow.spacerMatches).toBe(true)
    expect(longRow.clear).toBe(true)
    expect(longRow.flowsUnder).toBe(true)
    await buttons.first().click()
    await expect
      .poll(() => page.getByTestId('interaction-log').textContent())
      .toContain('to-background → C-b')
    await context.close()
  })
})
