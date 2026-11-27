// covers: web/src/features/session-new.tsx
// covers: web/src/features/session-new-job.tsx
// covers: web/src/features/session-new-route.ts
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
    'guides creation in-session, confirms trust, and recovers after an unknown job at width %i',
    async (width) => {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        locale: 'zh-CN',
      })
      const writes: Array<{ action: string; body: Record<string, unknown> }> =
        []
      let stage = 'waiting_trust'
      await context.route('**/api/v1/**', async (route) => {
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
        if (url.pathname === '/api/v1/remote/agent.profiles')
          return reply({
            v: 1,
            ok: true,
            default: 'codex',
            profiles: [
              {
                id: 'claude',
                label: 'Claude',
                disabled: true,
                note: '当前不可用',
              },
              { id: 'codex', label: 'Codex', default: true },
              { id: 'agy', label: 'Antigravity' },
            ],
          })
        if (url.pathname === '/api/v1/remote/sessions')
          return reply({
            v: 1,
            ok: true,
            sessions: [],
            creating_jobs:
              stage === 'unknown'
                ? []
                : [
                    {
                      job: 'agy-job',
                      stage,
                      mode: 'new',
                      repo: '/tmp/agy-test-repo',
                      repo_label: 'agy-test-repo',
                      agent_profile: 'agy',
                      prompt: 'Read the README',
                      worktree: '/tmp/agy-test-repo/.worktrees/agy',
                      branch: 'dev/agy',
                    },
                  ],
          })
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
              repo: '/tmp/agy-test-repo',
              repo_label: 'agy-test-repo',
              agent_profile: 'agy',
              prompt: 'Read the README',
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
      await page.waitForURL('**/console/sessions/new', { timeout: 10_000 })
      const view = page.getByTestId('new-session-view')
      await view.getByPlaceholder('要它做什么？').fill('Read the README')
      await view.getByRole('combobox', { name: '智能体' }).click()
      await page.getByRole('option', { name: 'Antigravity' }).waitFor({
        timeout: 5_000,
      })
      // disabled profiles are hidden from the new-session picker
      expect(await page.getByRole('option', { name: /Claude/ }).count()).toBe(0)
      await page.getByRole('option', { name: 'Antigravity' }).click()
      await view.getByRole('button', { name: '创建会话' }).click()
      await page.waitForURL('**/console/sessions/job-agy-job', {
        timeout: 10_000,
      })

      const jobView = page.getByTestId('new-session-job-view')
      await expect
        .poll(() =>
          jobView.getByTestId('new-session-stage').getAttribute('data-stage'),
        )
        .toBe('waiting_trust')
      expect(
        await jobView.getByTestId('new-session-first-prompt').textContent(),
      ).toBe('Read the README')
      expect(writes).toEqual([
        {
          action: 'session.new',
          body: expect.objectContaining({ agent_profile: 'agy' }),
        },
      ])

      await expect
        .poll(() => jobView.getByTestId('agy-trust-worktree').isVisible())
        .toBe(true)
      await jobView.getByTestId('agy-trust-worktree').click()
      await expect.poll(() => writes.length).toBe(2)
      expect(writes[1]).toEqual({
        action: 'session.new.trust',
        body: { job: 'agy-job', confirm: true },
      })

      stage = 'unknown'
      await page.reload()
      await expect
        .poll(() => jobView.getByRole('alert').textContent(), {
          timeout: 15_000,
        })
        .toContain('上一个会话请求已过期')
      await jobView.getByTestId('new-session-edit').click()
      await page.waitForURL('**/console/sessions/new', { timeout: 10_000 })
      expect(await view.getByPlaceholder('要它做什么？').inputValue()).toBe(
        'Read the README',
      )
      await context.close()
    },
    60_000,
  )
})
