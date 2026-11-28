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
  repoSettingsError = false,
) {
  const context: BrowserContext = await browser.newContext({
    viewport: { width, height: 850 },
    locale: 'zh-CN',
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const writes: Array<{ profile: string; model: string }> = []
  const settingsWrites: Array<{
    profile: string
    note: string
    disabled: boolean
  }> = []
  const repoWrites: Array<{ repo: string; profile: string }> = []
  let repoProfile = 'codex'
  const settings: Record<string, { note: string; disabled: boolean }> = {
    claude: { note: '当前不可用', disabled: true },
    claude_sub2api: { note: '当前不可用', disabled: true },
    grok: {
      note: '不能自动处理用户消息队列，不建议在交互场景下使用',
      disabled: false,
    },
  }
  let codexModel = ''
  await context.route('**/api/v1/**', async (route) => {
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
        default: 'codex',
        profiles: [
          { id: 'claude', label: 'Claude', ...settings.claude },
          {
            id: 'claude_sub2api',
            label: 'Claude · gateway',
            configured: true,
            default_model: 'gateway-model',
            masked_key: '••••••••1234',
            ...settings.claude_sub2api,
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
            default: true,
            default_model: 'gpt-6.2-sol',
            model_override: codexModel,
            ...settings.codex,
          },
          {
            id: 'grok',
            label: 'Grok',
            default_model: 'grok-4.5',
            ...settings.grok,
          },
          { id: 'agy', label: 'Antigravity' },
        ],
      })
    if (url.pathname === '/api/v1/remote/repos')
      return json({
        v: 1,
        ok: true,
        settings_error: repoSettingsError,
        repos: [
          {
            root: '/home/test/example',
            label: 'example',
            agent_profile: repoProfile,
            agent_source: repoWrites.length ? 'override' : 'workspace',
          },
        ],
      })
    if (url.pathname === '/api/v1/remote/sessions')
      return json({ v: 1, ok: true, sessions: [], creating_jobs: [] })
    if (url.pathname === '/api/v1/remote/repo.agent.set') {
      const body = route.request().postDataJSON() as {
        repo: string
        profile: string
      }
      repoWrites.push(body)
      repoProfile = body.profile || 'codex'
      return json({ v: 1, ok: true })
    }
    if (url.pathname === '/api/v1/remote/agent.profile.model') {
      const body = route.request().postDataJSON() as {
        profile: string
        model: string
      }
      writes.push(body)
      codexModel = body.model
      return json({ v: 1, ok: true })
    }
    if (url.pathname === '/api/v1/remote/agent.profile.settings') {
      const body = route.request().postDataJSON() as {
        profile: string
        note: string
        disabled: boolean
      }
      settingsWrites.push(body)
      settings[body.profile] = { note: body.note, disabled: body.disabled }
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
  return { context, page, writes, settingsWrites, repoWrites }
}

// Agent settings cases share one mocked Runtime contract.
// eslint-disable-next-line max-lines-per-function
describe('Agent settings layout', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it('shows and updates the resolved agent for a repository', async () => {
    const { context, page, repoWrites } = await pageWithProfiles(browser, 1440)
    await page.goto(`${base}/zh/console/me/repositories`)
    const row = page.getByTestId('repositories-page').getByRole('listitem')
    await row.waitFor()
    expect(
      await row.getByTestId('agent-avatar').first().getAttribute('data-agent'),
    ).toBe('codex')
    await row.getByRole('combobox', { name: /example.*默认智能体/ }).click()
    await page.getByRole('option', { name: 'Grok' }).click()
    await expect.poll(() => repoWrites.length).toBe(1)
    expect(repoWrites[0]).toEqual({
      repo: '/home/test/example',
      profile: 'grok',
    })
    await expect
      .poll(() =>
        row.getByTestId('agent-avatar').first().getAttribute('data-agent'),
      )
      .toBe('grok')
    await page.goto(`${base}/zh/console/sessions/new`)
    const view = page.getByTestId('new-session-view')
    await view.waitFor()
    await expect
      .poll(() =>
        view
          .getByTestId('new-session-header')
          .getByTestId('agent-avatar')
          .getAttribute('data-agent'),
      )
      .toBe('grok')
    const agent = view.getByRole('combobox', { name: '智能体' })
    await agent.click()
    await page.getByRole('option', { name: 'Codex' }).click()
    await expect
      .poll(() =>
        view
          .getByTestId('new-session-header')
          .getByTestId('agent-avatar')
          .getAttribute('data-agent'),
      )
      .toBe('codex')
    await context.close()
  }, 45_000)

  it('keeps repository settings usable on a phone width', async () => {
    const { context, page } = await pageWithProfiles(browser, 390)
    await page.goto(`${base}/zh/console/me/repositories`)
    const row = page.getByTestId('repositories-page').getByRole('listitem')
    await row.waitFor()
    expect(
      await row
        .getByRole('combobox', { name: /example.*默认智能体/ })
        .isVisible(),
    ).toBe(true)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
    await context.close()
  }, 45_000)

  it('requires an explicit agent when repository settings are unreadable', async () => {
    const { context, page } = await pageWithProfiles(browser, 390, false, true)
    await page.goto(`${base}/zh/console/sessions/new`)
    const view = page.getByTestId('new-session-view')
    await view.waitFor()
    await view.getByRole('alert').getByText('仓库智能体设置无法读取').waitFor()
    expect(
      await view.getByRole('button', { name: '创建会话' }).isDisabled(),
    ).toBe(true)
    await view.getByRole('combobox', { name: '智能体' }).click()
    await page.getByRole('option', { name: 'Codex' }).click()
    expect(
      await view
        .getByTestId('new-session-header')
        .getByTestId('agent-avatar')
        .getAttribute('data-agent'),
    ).toBe('codex')
    await page.goto(`${base}/zh/console/me/repositories`)
    await page.getByTestId('repositories-page').getByRole('alert').waitFor()
    expect(
      await page
        .getByRole('combobox', { name: /example.*默认智能体/ })
        .isDisabled(),
    ).toBe(true)
    await context.close()
  }, 45_000)

  it('desktop keeps a detail column while switching profiles and saves the selected model', async () => {
    const { context, page, writes } = await pageWithProfiles(
      browser,
      1440,
      true,
    )
    const detail = page.getByTestId('agent-detail')
    await detail.waitFor()
    const gap = await page.evaluate(() => {
      const second = document.querySelector('.vt-split-list')!
      const third = document.querySelector('[data-agent-profile]')!
      return (
        third.getBoundingClientRect().left -
        second.getBoundingClientRect().right
      )
    })
    expect(gap).toBeLessThanOrEqual(1)
    // Disabled agents are folded behind a toggle by default; enabled first row is selected.
    expect(await page.locator('[data-agent-profile=claude]').count()).toBe(0)
    const disabledToggle = page.getByTestId('agents-disabled-toggle')
    await disabledToggle.waitFor()
    expect(await disabledToggle.getAttribute('aria-expanded')).toBe('false')
    expect(await disabledToggle.textContent()).toContain('不可用智能体（2）')
    expect(await detail.locator('h2').textContent()).toBe('Claude · Kimi')
    await disabledToggle.click()
    expect(await disabledToggle.getAttribute('aria-expanded')).toBe('true')
    expect(
      await page
        .locator('[data-agent-profile=claude_sub2api] span.truncate')
        .first()
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
    expect(
      await page
        .locator('[data-agent-profile=agy]')
        .locator('[data-testid="agent-avatar"][data-agent="agy"] img')
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
    await detail.getByRole('button', { name: '保存', exact: true }).click()
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
    const { context, page, settingsWrites } = await pageWithProfiles(
      browser,
      390,
    )
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
        .locator('[data-testid="agent-avatar"][data-agent="agy"] img')
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
    await page
      .getByTestId('agent-detail')
      .getByTestId('agent-profile-note')
      .fill('Kimi 用于交互会话')
    await page
      .getByTestId('agent-detail')
      .getByTestId('agent-profile-settings-save')
      .click()
    await expect.poll(() => settingsWrites.length).toBe(1)
    expect(settingsWrites[0]).toEqual({
      profile: 'claude_kimi',
      note: 'Kimi 用于交互会话',
      disabled: false,
    })
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

  it('tablet opens one agent detail at a time and returns to its list', async () => {
    const { context, page } = await pageWithProfiles(browser, 900)
    await page.locator('[data-agent-profile=codex]').click()
    await page.getByRole('button', { name: '返回智能体列表' }).click()
    await page.locator('[data-agent-profile=codex]').waitFor()
    await context.close()
  })

  it('edits notes and disabled state without hiding profiles or copying keys', async () => {
    const { context, page, settingsWrites } = await pageWithProfiles(
      browser,
      1280,
      true,
    )
    const detail = page.getByTestId('agent-detail')
    await page.getByTestId('agents-disabled-toggle').click()
    await page.locator('[data-agent-profile=claude]').click()
    expect(await detail.getByTestId('agent-profile-note').inputValue()).toBe(
      '当前不可用',
    )
    expect(
      await detail.getByRole('checkbox', { name: '停用此 Agent' }).isChecked(),
    ).toBe(true)
    await page.locator('[data-agent-profile=grok]').click()
    expect(
      await detail.getByTestId('agent-profile-note').inputValue(),
    ).toContain('不能自动处理用户消息队列')
    await page.locator('[data-agent-profile=codex]').click()
    await detail.getByTestId('agent-profile-note').fill('用于交互和队列')
    await detail.getByRole('checkbox', { name: '停用此 Agent' }).check()
    await detail.getByTestId('agent-profile-settings-save').click()
    await expect.poll(() => settingsWrites.length).toBe(1)
    expect(settingsWrites[0]).toEqual({
      profile: 'codex',
      note: '用于交互和队列',
      disabled: true,
    })
    await expect
      .poll(() => page.locator('[data-agent-profile=codex]').textContent())
      .toContain('已停用 · 用于交互和队列')
    await page
      .locator('[data-agent-profile=codex]')
      .locator('..')
      .getByTestId('agent-copy-reference')
      .click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain(
        'agent_profile: codex\nmodel: gpt-6.2-sol\ndisabled: true\nnote: 用于交互和队列',
      )
    const preferred = page.getByRole('combobox', { name: '默认智能体' })
    await preferred.click()
    const agyOpt = page.getByRole('option', { name: 'Antigravity' })
    await agyOpt.waitFor()
    expect(await agyOpt.getByTestId('agent-avatar').count()).toBe(1)
    const options = await page.getByRole('option').allTextContents()
    expect(
      options.some((o) => ['Codex', 'Claude', 'Claude · gateway'].includes(o)),
    ).toBe(false)
    await context.close()
  })
})
