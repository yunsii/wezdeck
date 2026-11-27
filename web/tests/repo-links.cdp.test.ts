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
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
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
  it('keeps repository headings and the links sheet steady while reads resolve', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
    })
    try {
      const fixturePage = await context.newPage()
      const pendingSessions: Array<() => void> = []
      let sessionsReady = false
      let releaseLinks: (() => void) | undefined
      await fixturePage.routeWebSocket('**/relay/client*', (ws) => {
        const host = ws.connectToServer()
        ws.onMessage((message) => {
          const frame = JSON.parse(String(message))
          if (frame.action === 'sessions') {
            const sendSessions = () =>
              ws.send(
                JSON.stringify({
                  t: 'res',
                  id: frame.id,
                  ok: true,
                  result: {
                    sessions: [
                      {
                        id: 'repo-fixture',
                        name: 'codex',
                        agent: 'codex',
                        status: 'idle',
                        cwd: '/tmp/sample',
                        repo_root: '/tmp/sample',
                        repo: 'sample',
                        branch: 'master',
                        window: 'repo-fixture',
                        last_prompt: 'Sample prompt',
                        transcript: false,
                        ts: Date.now(),
                        desk_idle_s: -1,
                      },
                    ],
                  },
                }),
              )
            if (sessionsReady) sendSessions()
            else pendingSessions.push(sendSessions)
          } else if (frame.action === 'repo.links') {
            releaseLinks = () =>
              ws.send(
                JSON.stringify({
                  t: 'res',
                  id: frame.id,
                  ok: true,
                  result: {
                    cli_available: true,
                    links: [
                      {
                        type: 'detected',
                        source: 'git',
                        title: 'Repository',
                        url: 'https://example.com/repo',
                      },
                    ],
                  },
                }),
              )
          } else {
            host.send(message)
          }
        })
      })
      await fixturePage.goto(
        `${base}/console/sessions?remote=1&transport=websocket#pair=${token}`,
      )
      const skeleton = fixturePage.getByTestId('session-skeleton')
      await expect.poll(() => pendingSessions.length).toBeGreaterThan(0)
      await skeleton.waitFor()
      const loadingHeader = await skeleton
        .locator('[data-slot=skeleton-group] > div')
        .first()
        .evaluate((el) => el.getBoundingClientRect().height)
      const loadingRow = await skeleton
        .locator('li')
        .first()
        .evaluate((el) => el.getBoundingClientRect().height)
      sessionsReady = true
      pendingSessions.splice(0).forEach((send) => send())
      const heading = fixturePage
        .getByRole('heading', { level: 2 })
        .filter({ has: fixturePage.getByTestId('repo-links-button') })
        .first()
      await heading.waitFor()
      expect((await heading.boundingBox())?.height).toBe(loadingHeader)
      const row = fixturePage.locator('[data-session="repo-fixture"]')
      await expect
        .poll(async () => (await row.boundingBox())?.height)
        .toBe(loadingRow)

      await heading.getByTestId('repo-links-button').click()
      const sheet = fixturePage.getByTestId('repo-links-sheet')
      await sheet.getByTestId('repo-links-skeleton').waitFor()
      const sheetSize = () =>
        sheet.evaluate((el: HTMLElement) => [el.offsetWidth, el.offsetHeight])
      const size = await sheetSize()
      await expect.poll(() => Boolean(releaseLinks)).toBe(true)
      releaseLinks!()
      await sheet.getByTestId('repo-link-row').waitFor()
      expect(await sheetSize()).toEqual(size)
    } finally {
      await context.close()
    }
  }, 35_000)
})
