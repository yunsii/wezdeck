// covers: web/src/features/console-interactions*
// covers: web/src/features/prompt-action-state.tsx
// covers: web/src/features/session-permission.tsx
// covers: web/src/features/session-elicitation.tsx
// covers: web/src/features/session-ask-claude.tsx
// covers: web/src/features/console-me.tsx
// covers: web/src/components/ui/disclosure.tsx
// covers: web/src/features/chat-tools.tsx
// covers: web/src/features/chat-scroll.ts
// covers: web/src/features/session-subagents.tsx
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 交互调试 (我的 › 交互调试, /console/me/interactions): every
// special interaction rendered from sample data; taps only go to the key
// log, nothing reaches a pane, so no stack state is needed.
const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

// This file intentionally keeps the interaction fixture scenarios together so
// the page-level smoke coverage is easy to scan.
// eslint-disable-next-line max-lines-per-function
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
    'agy-permission',
    'agy-ask',
    'generic-keys',
    'progress',
    'stream',
    'subagents',
    'to-background',
    'compaction',
    'slash',
    'agy-thought',
    'agy-mode-bar',
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
      .poll(() =>
        detail
          .getByTestId('prompt-action-loading')
          .getAttribute('data-prompt-loading'),
      )
      .toBe('waiting')
    await expect
      .poll(() => page.getByTestId('interaction-log').textContent())
      .toContain('permission-bash → 1')
    // the selection is in the hash: a link opens that one
    expect(page.url()).toContain('#permission-bash')
    await page.goto(`${base}/zh/console/me/interactions#agy-permission`)
    await expect
      .poll(() =>
        page.getByTestId('interaction-detail').getAttribute('data-interaction'),
      )
      .toBe('agy-permission')
    const agyDetail = page.getByTestId('interaction-detail')
    // Full summary wraps without ellipsis, risk flag badge is shown, full script is scrollable
    const summaryText = await agyDetail
      .getByTestId('permission-summary')
      .innerText()
    expect(summaryText).toContain('full summary wraps cleanly without ellipsis')
    expect(
      await agyDetail
        .locator('[data-permission-flag="bypass-sandbox"]')
        .count(),
    ).toBe(1)
    const bodyEl = agyDetail.getByTestId('permission-body')
    expect(await bodyEl.innerText()).toContain('RELEASE_SCRIPT_END_MARKER')
    // Expand button opens the full-view Sheet and Escape dismisses it
    await agyDetail.getByTestId('permission-expand').click()
    const sheet = page.getByTestId('permission-detail-sheet')
    await sheet.waitFor({ timeout: 3_000 })
    expect(await sheet.innerText()).toContain('RELEASE_SCRIPT_END_MARKER')
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'hidden', timeout: 3_000 })
    await agyDetail.getByRole('button', { name: '允许' }).click()
    await expect
      .poll(() =>
        page
          .getByTestId('interaction-detail')
          .getByTestId('prompt-action-loading')
          .textContent(),
      )
      .toContain('操作已发送，等待 Agent 继续')
    await expect
      .poll(() => page.getByTestId('interaction-log').textContent())
      .toContain('agy-permission → Enter')
    await page.goto(`${base}/zh/console/me/interactions#agy-ask`)
    await expect
      .poll(() =>
        page.getByTestId('interaction-detail').getAttribute('data-interaction'),
      )
      .toBe('agy-ask')
    const agyAsk = page.getByTestId('interaction-detail')
    await agyAsk.getByRole('button', { name: /1\.\s*权限审批卡片/ }).click()
    await expect
      .poll(() => agyAsk.textContent())
      .toContain('需要顺带同步哪些验证？')
    const agyAskLog =
      (await page.getByTestId('interaction-log').textContent()) ?? ''
    expect(agyAskLog).toContain('agy-ask → 1')
    expect(agyAskLog).not.toContain('agy-ask → Enter')
    await page.goto(`${base}/zh/console/me/interactions#grok-plan`)
    await expect
      .poll(() =>
        page.getByTestId('interaction-detail').getAttribute('data-interaction'),
      )
      .toBe('grok-plan')
    await page
      .getByTestId('interaction-detail')
      .getByRole('button', { name: '批准计划' })
      .click()
    await expect
      .poll(() =>
        page
          .getByTestId('interaction-detail')
          .getByTestId('prompt-action-loading')
          .getAttribute('data-prompt-loading'),
      )
      .toBe('waiting')
    await page.goto(`${base}/zh/console/me/interactions#claude-ask-review`)
    await expect
      .poll(() =>
        page.getByTestId('interaction-detail').getAttribute('data-interaction'),
      )
      .toBe('claude-ask-review')
    await page.getByTestId('ask-submit').click()
    await expect
      .poll(() =>
        page
          .getByTestId('interaction-detail')
          .getByTestId('prompt-action-loading')
          .textContent(),
      )
      .toContain('答案已发送，等待 Agent 继续')
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

  it('tablet opens one interaction at a time and returns to its list', async () => {
    const context = await browser.newContext({
      viewport: { width: 900, height: 850 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions`)
    const item = page.locator('button[data-interaction=grok-plan]')
    await item.waitFor({ timeout: 20_000 })
    await expect.poll(() => page.getByTestId('me-pane').count()).toBe(1)
    expect(await page.getByTestId('interaction-detail').count()).toBe(0)
    await item.click()
    await page.getByTestId('interaction-detail').waitFor()
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect
      .poll(() => page.getByTestId('interaction-detail').count())
      .toBe(0)
    expect(await item.isVisible()).toBe(true)
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

  it('Grok Ask: sixth option, immediate loading, then multi-select and Enter', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#grok-ask`)
    const detail = page.getByTestId('interaction-detail')
    const card = detail.getByTestId('session-elicitation')
    await card.waitFor({ timeout: 20_000 })
    const log = page.getByTestId('interaction-log')

    await card.getByRole('button', { name: /6\. 第六项/ }).click()
    await card.getByTestId('grok-ask-loading').waitFor()
    await expect.poll(() => log.textContent()).toContain('grok-ask → 6')
    await expect.poll(() => log.textContent()).toContain('grok-ask → Enter')
    await card.getByText('报告包含哪些部分？').waitFor()
    await expect
      .poll(() => card.getByText('周报采用哪种数据源？').count())
      .toBe(0)

    const risks = card.getByRole('button', { name: /2\. 风险与阻塞/ })
    await risks.click()
    await expect.poll(() => risks.getAttribute('aria-pressed')).toBe('true')
    await expect
      .poll(() => card.getByTestId('grok-ask-loading').count())
      .toBe(0)
    await expect.poll(() => log.textContent()).toContain('grok-ask → 2')
    // Toggling must not submit; the first question contributed the only Enter.
    expect(
      ((await log.textContent()) ?? '').match(/grok-ask → Enter/g),
    ).toHaveLength(1)

    await card.getByRole('button', { name: /3\. 下周计划/ }).click()
    await expect
      .poll(() =>
        card
          .getByRole('button', { name: /3\. 下周计划/ })
          .getAttribute('aria-pressed'),
      )
      .toBe('true')
    await card.getByTestId('grok-ask-submit').click()
    await expect
      .poll(() => card.getByTestId('grok-ask-loading').textContent())
      .toContain('答案已发送，等待 Agent 继续')
    await page.waitForTimeout(250)
    await card.getByTestId('grok-ask-loading').waitFor()
    await expect.poll(() => log.textContent()).toContain('grok-ask → Enter')
    await context.close()
  })

  it('folding the subagents panel leaves the thread pinned, no blank room', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    await page.goto(`${base}/zh/console/me/interactions#subagents`)
    const demo = page.getByTestId('subagents-demo')
    await demo.waitFor({ timeout: 20_000 })
    const state = () =>
      demo.evaluate((root) => {
        const el = root.querySelector<HTMLElement>('.overflow-y-auto')!
        const end = root.querySelector<HTMLElement>(
          '[data-testid=subagents-demo-end]',
        )!
        return {
          // how far from the real end (the borrowed spacer is not content)
          left: Math.round(
            el.scrollHeight -
              (parseFloat(end.style.height) || 0) -
              el.clientHeight -
              el.scrollTop,
          ),
          borrowed: parseFloat(end.style.height) || 0,
        }
      })
    await expect.poll(async () => (await state()).left).toBeLessThan(2)
    const toggle = demo.locator('[data-testid=session-subagents] > button')
    for (const step of ['open', 'close', 'open', 'close']) {
      await toggle.click()
      await page.waitForTimeout(800)
      const now = await state()
      expect(now.left, `${step}: pinned to the last message`).toBeLessThan(2)
      expect(now.borrowed, `${step}: no blank room lent`).toBe(0)
    }
    expect(await page.getByText('回到最新').count()).toBe(0)
    await context.close()
  })
})
