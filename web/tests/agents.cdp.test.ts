// covers: web/src/features/me-agents.tsx
// covers: web/src/features/me-agent-detail.tsx
// covers: web/src/features/agent-profiles.ts
// covers: web/src/features/copy-reference.tsx
// covers: native/wezdeck-wsl/agent_profiles.go
import { chromium } from '@playwright/test'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

async function pageWithProfiles(
  browser: Browser,
  width: number,
  kimiConfigured = false,
) {
  const context: BrowserContext = await browser.newContext({
    viewport: { width, height: 850 },
    locale: 'zh-CN',
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const writes: Array<{ profile: string; model: string }> = []
  let codexModel = ''
  await context.route('http://127.0.0.1:35791/**', async (route) => {
    const url = new URL(route.request().url())
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(body),
      })
    if (url.pathname === '/api/v1/health')
      return json({
        api_version: '1',
        instance_id: 'agents-test',
        ready: true,
        capabilities: ['remote.read', 'remote.write'],
        observed_at: new Date().toISOString(),
      })
    if (url.pathname === '/api/v1/remote/agent.profiles')
      return json({
        v: 1,
        ok: true,
        default: 'claude',
        profiles: [
          { id: 'claude', label: 'Claude', default: true },
          {
            id: 'claude_sub2api',
            label: 'Claude · gateway',
            configured: true,
            default_model: 'gateway-model',
            masked_key: '••••••••1234',
          },
          {
            id: 'claude_kimi',
            label: 'Claude · Kimi',
            configured: kimiConfigured,
            model: kimiConfigured ? 'kimi-k3[1m]' : '',
            masked_key: kimiConfigured ? '••••••••5678' : '',
          },
          {
            id: 'codex',
            label: 'Codex',
            default_model: 'gpt-6.2-sol',
            model_override: codexModel,
          },
          { id: 'grok', label: 'Grok', default_model: 'grok-4.5' },
          { id: 'agy', label: 'Antigravity' },
        ],
      })
    if (url.pathname === '/api/v1/remote/agent.profile.model') {
      const body = route.request().postDataJSON() as {
        profile: string
        model: string
      }
      writes.push(body)
      codexModel = body.model
      return json({ v: 1, ok: true })
    }
    return route.abort()
  })
  const page: Page = await context.newPage()
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(`${base}/zh/console/me/agents`)
    try {
      await page
        .locator('[data-agent-profile=codex]')
        .waitFor({ timeout: 6_000 })
      break
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
  return { context, page, writes }
}

describe('Agent settings layout', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('desktop keeps a detail column while switching profiles and saves the selected model', async () => {
    const { context, page, writes } = await pageWithProfiles(
      browser,
      1440,
      true,
    )
    const detail = page.getByTestId('agent-detail')
    await detail.waitFor()
    expect(
      await page
        .locator('[data-agent-profile=claude_sub2api] span.truncate')
        .evaluate((label) => label.scrollWidth <= label.clientWidth),
    ).toBe(true)
    await page
      .locator('[data-agent-profile=claude_kimi]')
      .locator('..')
      .getByTestId('agent-copy-reference')
      .click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(
        '[wezdeck 智能体] Claude · Kimi\nagent_profile: claude_kimi\nmodel: kimi-k3[1m]',
      )
    expect(await detail.locator('h2').textContent()).toBe('Claude')
    expect(
      await page
        .locator('[data-agent-profile=agy]')
        .locator('img[src="/icons/agents/agy.png"]')
        .evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
        ),
    ).toBe(true)
    const before = await detail.boundingBox()
    expect(before?.width).toBeGreaterThan(300)
    if (process.env.WEZDECK_VISUAL_SHOTS)
      await page.screenshot({ path: '/tmp/wezdeck-agents-desktop.png' })
    for (const id of ['claude', 'claude_sub2api', 'grok', 'agy']) {
      await page.locator(`[data-agent-profile=${id}]`).click()
      await expect.poll(() => detail.locator('h2').count()).toBe(1)
      expect(
        await detail.getByRole('textbox', { name: '模型 ID' }).count(),
      ).toBe(1)
    }
    await page.locator('[data-agent-profile=claude_sub2api]').click()
    expect(
      await detail.getByRole('textbox', { name: '模型 ID' }).inputValue(),
    ).toBe('gateway-model')
    expect(await detail.getByText('••••••••1234').count()).toBe(1)
    await page.locator('[data-agent-profile=grok]').click()
    expect(
      await detail.getByRole('textbox', { name: '模型 ID' }).inputValue(),
    ).toBe('grok-4.5')
    await page.locator('[data-agent-profile=claude_kimi]').click()
    expect(await detail.getByText('••••••••5678').count()).toBe(1)
    expect(await detail.getByLabel('更换 API 密钥').inputValue()).toBe('')
    await page.locator('[data-agent-profile=codex]').click()
    await expect.poll(() => detail.locator('h2').textContent()).toBe('Codex')
    const after = await detail.boundingBox()
    expect(after?.x).toBe(before?.x)
    expect(after?.width).toBe(before?.width)
    expect(
      await detail.getByRole('textbox', { name: '模型 ID' }).inputValue(),
    ).toBe('gpt-6.2-sol')
    await detail.getByRole('textbox', { name: '模型 ID' }).fill('gpt-6.2-astra')
    await detail.getByRole('button', { name: '保存' }).click()
    await expect.poll(() => writes.length).toBe(1)
    expect(writes[0]).toEqual({ profile: 'codex', model: 'gpt-6.2-astra' })
    await expect.poll(() => detail.getByText('受管模型覆盖').count()).toBe(1)
    await page.evaluate(() => navigator.clipboard.writeText(''))
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    )
    await page.keyboard.press('y')
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('agent_profile: codex\nmodel: gpt-6.2-astra')
    await context.close()
  })

  it('phone opens one profile detail and returns to the list', async () => {
    const { context, page } = await pageWithProfiles(browser, 390)
    await page
      .locator('[data-agent-profile=agy]')
      .locator('..')
      .getByTestId('agent-copy-reference')
      .click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('[wezdeck 智能体] Antigravity\nagent_profile: agy')
    if (process.env.WEZDECK_VISUAL_SHOTS)
      await page.screenshot({ path: '/tmp/wezdeck-agents-mobile-list.png' })
    expect(
      await page
        .locator('[data-agent-profile=agy]')
        .locator('img[src="/icons/agents/agy.png"]')
        .evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
        ),
    ).toBe(true)
    expect(await page.getByTestId('agent-detail').isVisible()).toBe(false)
    await page.locator('[data-agent-profile=claude_kimi]').click()
    await page.getByTestId('agent-detail').waitFor({ state: 'visible' })
    await page
      .getByTestId('agent-detail')
      .getByTestId('agent-detail-copy-reference')
      .click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('agent_profile: claude_kimi')
    expect(
      await page.evaluate(() => navigator.clipboard.readText()),
    ).not.toContain('5678')
    if (process.env.WEZDECK_VISUAL_SHOTS)
      await page.screenshot({ path: '/tmp/wezdeck-agents-mobile.png' })
    expect(
      await page
        .getByTestId('agent-detail')
        .getByLabel('Kimi API 密钥')
        .count(),
    ).toBe(1)
    await page
      .getByTestId('agents-page')
      .getByRole('button', { name: '返回智能体列表' })
      .click()
    expect(await page.locator('[data-agent-profile=codex]').isVisible()).toBe(
      true,
    )
    await context.close()
  })
})
