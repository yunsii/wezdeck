// covers: web/src/features/session-new.tsx
// covers: web/src/features/session-new-panels.tsx
// covers: native/wezdeck-wsl/session_new.go
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'

describe('Agy worktree trust in new session', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })

  it.each([390, 1440])(
    'restores the new-session form after an unknown job at width %i',
    async (width) => {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        locale: 'zh-CN',
      })
      const writes: Array<{ action: string; body: Record<string, unknown> }> =
        []
      let stage = 'waiting_trust'
      await context.route('http://127.0.0.1:35791/**', async (route) => {
        const url = new URL(route.request().url())
        const reply = (body: unknown) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify(body),
          })
        if (url.pathname === '/api/v1/health')
          return reply({
            api_version: '1',
            instance_id: 'agy-test',
            ready: true,
            capabilities: ['remote.read', 'remote.write'],
            observed_at: new Date().toISOString(),
          })
        if (url.pathname === '/api/v1/remote/repos')
          return reply({
            v: 1,
            ok: true,
            repos: [{ root: '/tmp/agy-test-repo', label: 'agy-test-repo' }],
          })
        if (url.pathname === '/api/v1/remote/workstations')
          return reply({ v: 1, ok: true, directions: [] })
        if (url.pathname === '/api/v1/remote/agent.profiles')
          return reply({
            v: 1,
            ok: true,
            default: 'claude',
            profiles: [
              { id: 'claude', label: 'Claude' },
              { id: 'agy', label: 'Antigravity' },
            ],
          })
        if (url.pathname === '/api/v1/remote/sessions')
          return reply({ v: 1, ok: true, sessions: [] })
        if (url.pathname === '/api/v1/remote/session.new.job') {
          if (stage === 'unknown')
            return reply({
              available: false,
              error: 'session.new.job: unknown job',
            })
          return reply({
            v: 1,
            ok: true,
            job: {
              job: 'agy-job',
              stage,
              mode: 'new',
              worktree: '/tmp/agy-test-repo/.worktrees/agy',
              branch: 'dev/agy',
            },
          })
        }
        if (
          url.pathname === '/api/v1/remote/session.new' ||
          url.pathname === '/api/v1/remote/session.new.trust'
        ) {
          const action = url.pathname.split('/').at(-1) || ''
          const body = route.request().postDataJSON() as Record<string, unknown>
          writes.push({ action, body })
          if (action === 'session.new.trust') stage = 'starting'
          return reply(
            action === 'session.new'
              ? { v: 1, ok: true, job: 'agy-job' }
              : { v: 1, ok: true },
          )
        }
        return route.abort()
      })
      const page = await context.newPage()
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.goto(`${base}/zh/console/sessions`)
        try {
          await page.getByTestId('new-session').waitFor({ timeout: 6_000 })
          break
        } catch (error) {
          if (attempt === 2) throw error
        }
      }
      await page.getByTestId('new-session').click()
      const sheet = page.getByTestId('new-session-sheet')
      await sheet.getByTestId('new-session-place').click()
      await sheet.locator('[data-direction="+new"]').click()
      await sheet.getByPlaceholder('例如 ux、ci、i18n').fill('agy')
      await sheet.getByTestId('new-session-direction-done').click()
      await sheet.getByPlaceholder('要它做什么？').fill('Read the README')
      await sheet.getByRole('combobox', { name: '智能体' }).click()
      await page.getByRole('option', { name: 'Antigravity' }).click()
      await sheet.getByRole('button', { name: '创建会话' }).click()
      await expect
        .poll(() =>
          sheet.getByTestId('new-session-stage').getAttribute('data-stage'),
        )
        .toBe('waiting_trust')
      if (process.env.WEZDECK_VISUAL_SHOTS)
        await page.screenshot({ path: `/tmp/wezdeck-agy-trust-${width}.png` })
      expect(writes).toEqual([
        {
          action: 'session.new',
          body: expect.objectContaining({ agent_profile: 'agy' }),
        },
      ])
      await sheet.getByRole('button', { name: '关闭' }).click()
      await page.getByTestId('new-session').click()
      await expect
        .poll(() => sheet.getByTestId('agy-trust-worktree').isVisible())
        .toBe(true)
      await sheet.getByTestId('agy-trust-worktree').click()
      await expect.poll(() => writes.length).toBe(2)
      expect(writes[1]).toEqual({
        action: 'session.new.trust',
        body: { job: 'agy-job', confirm: true },
      })

      stage = 'unknown'
      await sheet.getByRole('button', { name: '关闭' }).click()
      await page.getByTestId('new-session').click()
      await expect
        .poll(() => sheet.getByTestId('new-session-place').isEnabled(), {
          timeout: 15_000,
        })
        .toBe(true)
      await expect
        .poll(() => sheet.getByRole('alert').textContent())
        .toContain('上次新建会话请求已失效')
      expect(
        await page.evaluate(() =>
          sessionStorage.getItem('wezdeck.pending-new-session-job'),
        ),
      ).toBeNull()
      await sheet.getByTestId('new-session-place').click()
      await expect
        .poll(() => sheet.getByTestId('new-session-place').count())
        .toBe(0)
      await context.close()
    },
  )
})
