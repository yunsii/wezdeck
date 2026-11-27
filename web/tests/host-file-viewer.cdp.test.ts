// covers: web/src/features/host-file-sheet.tsx web/src/features/host-file-body.tsx
// covers: web/src/features/host-file-context.tsx web/src/features/mermaid-block.tsx
// covers: web/src/features/chat-markdown.tsx web/src/features/doc-code-block.tsx
// covers: web/src/components/ui/sheet.tsx
// covers: native/wezdeck-wsl/session_file.go native/wezdeck-wsl/agent_agy.go
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''
const devicesFile = process.env.WEZDECK_TEST_DEVICES ?? ''
const room = process.env.WEZDECK_REMOTE_ROOM ?? ''
const roomQuery = room ? `&room=${room}` : ''

function createSessionFixture() {
  const sessionId = `cdp-file-${Date.now().toString(36)}`
  const socketDir = mkdtempSync(join(tmpdir(), 'wd-file-tmux-'))
  const socket = join(socketDir, 'sock')
  const workDir = mkdtempSync(join(tmpdir(), 'wd-file-repo-'))
  const brainDir = join(
    homedir(),
    '.gemini',
    'antigravity-cli',
    'brain',
    sessionId,
  )
  const logsDir = join(brainDir, '.system_generated', 'logs')
  const artifactPath = join(brainDir, 'design-plan.md')
  const codePath = join(workDir, 'sample.ts')
  const tmux = (...args: Array<string>) =>
    execFileSync('tmux', ['-S', socket, ...args]).toString()

  mkdirSync(logsDir, { recursive: true })
  writeFileSync(
    codePath,
    [
      'export const first = 1',
      'export function greet(name: string) {',
      '  return `hello ${name}`',
      '}',
    ].join('\n'),
  )
  writeFileSync(
    artifactPath,
    [
      '# Remote Plan Viewer',
      '',
      '> Summary callout for testing fullscreen document typography.',
      '',
      '## 1. Architecture',
      '',
      '### 1.1 Wide Diagram',
      '',
      '```mermaid',
      'flowchart LR',
      '  A["Web PWA Fullscreen Reader"] --> B["Cloudflare HostRelay Durable Object"] --> C["WSL wezdeck-wsl session.file"] --> D["Local Artifact & Workspace Files"] --> E["Sanitized Markdown + Mermaid"]',
      '```',
      '',
      '| Column A | Column B | Column C | Column D |',
      '| --- | --- | --- | --- |',
      '| Alpha detail cell with longer descriptive text | Beta detail cell with longer descriptive text | Gamma detail cell | Delta detail cell |',
      '',
      '```ts',
      'export const mode = "fullscreen"',
      '```',
      '',
      '## 2. Code Reference',
      '',
      `See [sample.ts](file://${codePath}#L2-L3) for details.`,
      '',
    ].join('\n'),
  )

  const transcriptLines = [
    JSON.stringify({
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nShow me the plan\n</USER_REQUEST>',
      created_at: '2026-11-27T16:40:00Z',
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      content: '',
      created_at: '2026-11-27T16:40:05Z',
      tool_calls: [
        {
          name: 'write_file',
          args: {
            Path: artifactPath,
            Content: '# Remote Plan Viewer\n',
            ArtifactMetadata: {
              UserFacing: true,
              RequestFeedback: true,
              Summary: 'Design proposal with Mermaid diagram and code link',
            },
          },
        },
      ],
    }),
    JSON.stringify({
      type: 'GENERIC',
      content: 'Created file.',
      created_at: '2026-11-27T16:40:06Z',
    }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      content: `Plan ready at [design-plan.md](file://${artifactPath}).`,
      created_at: '2026-11-27T16:40:07Z',
    }),
  ]
  writeFileSync(
    join(logsDir, 'transcript_full.jsonl'),
    `${transcriptLines.join('\n')}\n`,
  )

  tmux('new-session', '-d', '-s', 'demo', '-c', workDir, 'cat')
  const pane = tmux('display-message', '-p', '-t', 'demo', '#{pane_id}').trim()
  tmux('set-option', '-p', '-t', pane, '@wezterm_pane_role', 'agent-cli:agy')
  writeFileSync(
    attention,
    JSON.stringify({
      entries: {
        [sessionId]: {
          session_id: sessionId,
          tmux_socket: socket,
          tmux_session: 'demo',
          tmux_pane: pane,
          status: 'done',
          ts: Date.now(),
          last_user_prompt: 'Show me the plan',
          agent_name: 'agy',
        },
      },
      recent: [],
    }),
  )

  return {
    sessionId,
    cleanup() {
      try {
        tmux('kill-server')
      } catch {
        // already stopped
      }
      rmSync(brainDir, { recursive: true, force: true })
      rmSync(workDir, { recursive: true, force: true })
      rmSync(socketDir, { recursive: true, force: true })
    },
  }
}

describe.runIf(attention && devicesFile)(
  'Host file / Artifact viewer over relay',
  () => {
    let browser: Browser | undefined
    let fixture: ReturnType<typeof createSessionFixture> | undefined

    beforeAll(async () => {
      fixture = createSessionFixture()
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
      fixture?.cleanup()
    })

    it('opens fullscreen viewer on desktop, fits wide Mermaid diagram without overflow, follows nested link, and quotes', async () => {
      if (!browser || !fixture) throw new Error('fixture not ready')
      const viewport = { width: 1280, height: 800 }
      const context = await browser.newContext({ viewport, locale: 'zh-CN' })
      const page = await context.newPage()
      await page.goto(
        `${base}/zh/console/sessions/${fixture.sessionId}?remote=1#pair=${encodeURIComponent(token)}${roomQuery}`,
      )

      const card = page.getByTestId('artifact-card')
      await card.waitFor({ timeout: 20_000 })
      expect(await card.innerText()).toContain('design-plan.md')
      expect(await card.innerText()).toContain(
        'Design proposal with Mermaid diagram and code link',
      )

      await page.getByTestId('host-file-link').first().waitFor({
        timeout: 10_000,
      })

      await card.getByTestId('artifact-open').click()
      const sheet = page.getByTestId('host-file-sheet')
      await sheet.waitFor({ timeout: 10_000 })

      const sheetBox = await sheet.boundingBox()
      expect(sheetBox).not.toBeNull()
      expect(sheetBox!.width).toBeGreaterThanOrEqual(viewport.width - 2)
      expect(sheetBox!.height).toBeGreaterThanOrEqual(viewport.height - 2)

      await sheet.getByTestId('host-file-markdown').waitFor({ timeout: 15_000 })
      const mermaidBox = sheet.getByTestId('mermaid-svg')
      await mermaidBox.waitFor({ timeout: 15_000 })
      expect(await mermaidBox.locator('svg').count()).toBe(1)

      const metrics = await page.evaluate(() => {
        const s = document.querySelector('[data-testid="host-file-sheet"]')!
        const mWrap = s.querySelector('[data-testid="mermaid-svg"]')!
        const svg = mWrap.querySelector('svg')!
        const h1 = s.querySelector('article h1')
        const h2 = s.querySelector('article h2')
        const h3 = s.querySelector('article h3')
        return {
          sheetOverflow: s.scrollWidth - s.clientWidth,
          svgWidth: svg.getBoundingClientRect().width,
          wrapWidth: mWrap.getBoundingClientRect().width,
          h1Size: h1 ? parseFloat(getComputedStyle(h1).fontSize) : 0,
          h2Size: h2 ? parseFloat(getComputedStyle(h2).fontSize) : 0,
          h3Size: h3 ? parseFloat(getComputedStyle(h3).fontSize) : 0,
        }
      })
      expect(metrics.sheetOverflow).toBeLessThanOrEqual(1)
      expect(metrics.svgWidth).toBeGreaterThan(100)
      expect(metrics.svgWidth).toBeLessThanOrEqual(metrics.wrapWidth + 1)
      expect(metrics.h1Size).toBeGreaterThan(metrics.h2Size)
      expect(metrics.h2Size).toBeGreaterThan(metrics.h3Size)

      await sheet.getByTestId('host-file-link').click()
      const codeView = sheet.getByTestId('host-file-code')
      await codeView.waitFor({ timeout: 15_000 })
      expect(
        await codeView
          .locator('[data-line="2"][data-highlighted="true"]')
          .count(),
      ).toBe(1)
      expect(
        await codeView
          .locator('[data-line="3"][data-highlighted="true"]')
          .count(),
      ).toBe(1)

      await sheet.getByRole('button', { name: '返回' }).click()
      await sheet.getByTestId('host-file-markdown').waitFor({ timeout: 10_000 })
      await sheet.getByTestId('host-file-quote').click()
      await sheet.waitFor({ state: 'hidden', timeout: 5_000 })
      await expect
        .poll(() => page.locator('#session-composer').inputValue())
        .toContain('design-plan.md')

      await context.close()
    })

    it('renders fullscreen on mobile (390x844) with zero Mermaid or document horizontal overflow', async () => {
      if (!browser || !fixture) throw new Error('fixture not ready')
      const viewport = { width: 390, height: 844 }
      const context = await browser.newContext({ viewport, locale: 'zh-CN' })
      const page = await context.newPage()
      await page.goto(
        `${base}/zh/console/sessions/${fixture.sessionId}?remote=1#pair=${encodeURIComponent(token)}${roomQuery}`,
      )

      const card = page.getByTestId('artifact-card')
      await card.waitFor({ timeout: 20_000 })
      await card.getByTestId('artifact-open').click()

      const sheet = page.getByTestId('host-file-sheet')
      await sheet.waitFor({ timeout: 10_000 })
      await sheet.getByTestId('mermaid-svg').waitFor({ timeout: 15_000 })

      const mobileMetrics = await page.evaluate(() => {
        const s = document.querySelector('[data-testid="host-file-sheet"]')!
        const sRect = s.getBoundingClientRect()
        const mWrap = s.querySelector('[data-testid="mermaid-svg"]')!
        const svg = mWrap.querySelector('svg')!
        return {
          sheetWidth: sRect.width,
          sheetHeight: sRect.height,
          sheetOverflow: s.scrollWidth - s.clientWidth,
          svgWidth: svg.getBoundingClientRect().width,
          wrapWidth: mWrap.getBoundingClientRect().width,
        }
      })
      expect(mobileMetrics.sheetWidth).toBeGreaterThanOrEqual(
        viewport.width - 2,
      )
      expect(mobileMetrics.sheetHeight).toBeGreaterThanOrEqual(
        viewport.height - 2,
      )
      expect(mobileMetrics.sheetOverflow).toBeLessThanOrEqual(1)
      expect(mobileMetrics.svgWidth).toBeGreaterThan(100)
      expect(mobileMetrics.svgWidth).toBeLessThanOrEqual(
        mobileMetrics.wrapWidth + 1,
      )

      await context.close()
    })
  },
)
