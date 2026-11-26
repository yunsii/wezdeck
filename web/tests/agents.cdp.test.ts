// covers: web/src/features/me-agents.tsx
// covers: web/src/features/me-agent-detail.tsx
import { chromium } from '@playwright/test'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

async function pageWithProfiles(browser: Browser, width: number) {
  const context: BrowserContext = await browser.newContext({
    viewport: { width, height: 850 },
    locale: 'zh-CN',
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
          { id: 'claude_sub2api', label: 'Claude · gateway' },
          { id: 'claude_kimi', label: 'Claude · Kimi', configured: false },
          { id: 'codex', label: 'Codex', model_override: codexModel },
          { id: 'grok', label: 'Grok' },
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
  await page.goto(`${base}/zh/console/me/agents`)
  await page.locator('[data-agent-profile=codex]').waitFor({ timeout: 20_000 })
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
    const { context, page, writes } = await pageWithProfiles(browser, 1440)
    const detail = page.getByTestId('agent-detail')
    await detail.waitFor()
    const before = await detail.boundingBox()
    expect(before?.width).toBeGreaterThan(300)
    if (process.env.WEZDECK_VISUAL_SHOTS)
      await page.screenshot({ path: '/tmp/wezdeck-agents-desktop.png' })
    for (const id of ['claude', 'claude_sub2api', 'grok']) {
      await page.locator(`[data-agent-profile=${id}]`).click()
      await expect.poll(() => detail.locator('h2').count()).toBe(1)
      expect(
        await detail.getByRole('textbox', { name: '模型 ID' }).count(),
      ).toBe(1)
    }
    await page.locator('[data-agent-profile=codex]').click()
    await expect.poll(() => detail.locator('h2').textContent()).toBe('Codex')
    const after = await detail.boundingBox()
    expect(after?.x).toBe(before?.x)
    expect(after?.width).toBe(before?.width)
    await detail.getByRole('textbox', { name: '模型 ID' }).fill('gpt-6.2-sol')
    await detail.getByRole('button', { name: '保存' }).click()
    await expect.poll(() => writes.length).toBe(1)
    expect(writes[0]).toEqual({ profile: 'codex', model: 'gpt-6.2-sol' })
    await context.close()
  })

  it('phone opens one profile detail and returns to the list', async () => {
    const { context, page } = await pageWithProfiles(browser, 390)
    expect(await page.getByTestId('agent-detail').isVisible()).toBe(false)
    await page.locator('[data-agent-profile=claude_kimi]').click()
    await page.getByTestId('agent-detail').waitFor({ state: 'visible' })
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
