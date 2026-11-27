// covers: web/src/features/host-file-sheet.tsx web/src/features/host-file-context.tsx
// covers: web/src/features/mermaid-block.tsx web/src/features/chat-markdown.tsx
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

describe.runIf(attention && devicesFile)(
  'Host file / Artifact viewer over relay',
  () => {
    let browser: Browser | undefined
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

    beforeAll(async () => {
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
          '## 1. Architecture',
          '',
          '```mermaid',
          'flowchart LR',
          '  A["Web"] --> B["Relay"]',
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
      const pane = tmux(
        'display-message',
        '-p',
        '-t',
        'demo',
        '#{pane_id}',
      ).trim()
      tmux(
        'set-option',
        '-p',
        '-t',
        pane,
        '@wezterm_pane_role',
        'agent-cli:agy',
      )
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
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
      try {
        tmux('kill-server')
      } catch {
        // already stopped
      }
      rmSync(brainDir, { recursive: true, force: true })
      rmSync(workDir, { recursive: true, force: true })
      rmSync(socketDir, { recursive: true, force: true })
    })

    it('opens Agy artifact card, renders Mermaid, follows nested file:// link with line highlight, and quotes to composer', async () => {
      if (!browser) throw new Error('browser not launched')
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        locale: 'zh-CN',
      })
      const page = await context.newPage()
      await page.goto(
        `${base}/zh/console/sessions/${sessionId}?remote=1#pair=${encodeURIComponent(token)}${roomQuery}`,
      )

      // 1. Artifact card renders in the thread and opens the Markdown plan sheet
      const card = page.getByTestId('artifact-card')
      await card.waitFor({ timeout: 20_000 })
      expect(await card.innerText()).toContain('design-plan.md')
      expect(await card.innerText()).toContain(
        'Design proposal with Mermaid diagram and code link',
      )

      // Inline file:// link in the assistant bubble is also clickable
      const inlineLink = page.getByTestId('host-file-link').first()
      await inlineLink.waitFor({ timeout: 10_000 })

      await card.getByTestId('artifact-open').click()
      const sheet = page.getByTestId('host-file-sheet')
      await sheet.waitFor({ timeout: 10_000 })

      // 2. Markdown content + Mermaid SVG render inside the sheet
      await sheet.getByTestId('host-file-markdown').waitFor({ timeout: 15_000 })
      await sheet.getByTestId('mermaid-svg').waitFor({ timeout: 15_000 })
      expect(
        await sheet.getByTestId('mermaid-svg').locator('svg').count(),
      ).toBe(1)

      // 3. Clicking nested file:// code link navigates in-sheet with line highlight
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

      // 4. Back returns to the plan, Reply drafts a reference into the composer
      await sheet.getByRole('button', { name: '返回' }).click()
      await sheet.getByTestId('host-file-markdown').waitFor({ timeout: 10_000 })
      await sheet.getByTestId('host-file-quote').click()
      await sheet.waitFor({ state: 'hidden', timeout: 5_000 })
      await expect
        .poll(() => page.locator('#session-composer').inputValue())
        .toContain('design-plan.md')

      await context.close()
    })
  },
)
