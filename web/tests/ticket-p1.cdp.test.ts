// covers: web/src/features/ticket-list-groups.ts web/src/features/ticket-keys.tsx
// covers: web/src/features/tickets-view.tsx web/src/features/ticket-run-chat.tsx
// covers: web/src/features/ticket-diff.tsx web/src/features/ticket-header.tsx
// covers: web/src/features/ticket-manager-panel.tsx
// covers: native/wezdeck-wsl/collab_chat.go native/wezdeck-wsl/collab_diff.go
// covers: native/wezdeck-wsl/collab_manager.go
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const devicesFile = process.env.WEZDECK_TEST_DEVICES ?? ''
const stack = process.env.WEZDECK_TEST_STACK_DIR ?? ''
const room = process.env.WEZDECK_REMOTE_ROOM ?? ''
const roomQuery = room ? `&room=${room}` : ''
const repoRoot = join(import.meta.dirname, '..', '..')

function writeTicket(
  dataRoot: string,
  id: string,
  frontmatter: Record<string, string>,
  meta: Record<string, unknown>,
  summary: string,
) {
  const dir = join(dataRoot, id)
  mkdirSync(join(dir, 'runs'), { recursive: true })
  const header = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
  writeFileSync(
    join(dir, 'ticket.md'),
    `---\n${header}\n---\n\n## Summary\n\n${summary}\n`,
  )
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  return dir
}

function createFixture() {
  const dataRoot = join(stack, 'tickets', '_data')
  const suffix = Date.now().toString(36)
  const parentId = `req-20261127-190001-p${suffix}`
  const childId = `req-20261127-190002-c${suffix}`
  const researchId = `req-20261127-190003-r${suffix}`
  const runId = `run-20261127-190004-${suffix}`

  // Real temp git worktree with a tracked modification for collab.diff
  const worktree = mkdtempSync(join(tmpdir(), 'wd-p1-diff-'))
  const git = (...args: Array<string>) =>
    execFileSync('git', ['-C', worktree, ...args])
      .toString()
      .trim()
  git('init')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(worktree, 'handler.ts'), 'export const v = 1\n')
  git('add', 'handler.ts')
  git('commit', '-m', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  writeFileSync(
    join(worktree, 'handler.ts'),
    'export const v = 2\nexport const ready = true\n',
  )

  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  writeTicket(
    dataRoot,
    parentId,
    {
      id: parentId,
      title: `Parent P1 ${suffix}`,
      from: 'wezdeck',
      to: 'demo-repo',
      status: 'in_progress',
      created_at: nowIso,
      updated_at: nowIso,
    },
    {
      kind: 'parent',
      repos: ['demo-repo'],
      manager_session: {
        backend: 'claude',
        profile: 'claude-sonnet',
        state: 'parked',
        cwd: join(stack, 'tickets', 'workspaces', parentId),
        updated_at: nowIso,
      },
    },
    'Parent orchestration ticket',
  )

  const childDir = writeTicket(
    dataRoot,
    childId,
    {
      id: childId,
      title: `Child P1 ${suffix}`,
      from: 'wezdeck',
      to: 'demo-repo',
      status: 'waiting_initiator',
      created_at: nowIso,
      updated_at: nowIso,
    },
    {
      kind: 'child',
      parent: parentId,
      worktree,
      branch: 'ticket/p1-demo',
      base_sha: baseSha,
      repos: ['demo-repo'],
    },
    'Child worker ticket with ChatThread run and live diff',
  )

  writeFileSync(
    join(childDir, 'runs', `${runId}.json`),
    JSON.stringify({
      v: 1,
      run: runId,
      backend: 'codex',
      phase: 'implement',
      role: 'worker',
      started_at: nowIso,
      ended_at: nowIso,
      wall_ms: 4200,
      turns: 2,
      cache_hit_rate: 0.75,
      exit: 0,
      session: { id: `missing-sess-${suffix}`, reuse: 'fresh' },
    }),
  )
  writeFileSync(
    join(childDir, 'runs', `${runId}.stream.jsonl`),
    [
      JSON.stringify({ type: 'thread.started', thread_id: `t-${suffix}` }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'agent_message',
          text: `Worker finished updating handler.ts (${suffix}).`,
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'command_execution',
          command: 'pnpm test',
          aggregated_output: 'all green',
          exit_code: 0,
        },
      }),
    ].join('\n') + '\n',
  )

  writeTicket(
    dataRoot,
    researchId,
    {
      id: researchId,
      title: `Standalone Research ${suffix}`,
      from: 'wezdeck',
      to: 'demo-repo',
      status: 'in_progress',
      created_at: nowIso,
      updated_at: nowIso,
    },
    { kind: 'research', repos: ['demo-repo'] },
    'Read-only research ticket',
  )

  return {
    suffix,
    parentId,
    childId,
    researchId,
    cleanup() {
      rmSync(worktree, { recursive: true, force: true })
      rmSync(join(dataRoot, parentId), { recursive: true, force: true })
      rmSync(join(dataRoot, childId), { recursive: true, force: true })
      rmSync(join(dataRoot, researchId), { recursive: true, force: true })
    },
  }
}

describe.runIf(stack)(
  'Ticket P1: folding, research tab, ChatThread & Diff',
  () => {
    let browser: Browser | undefined
    let fixture: ReturnType<typeof createFixture> | undefined

    beforeAll(async () => {
      fixture = createFixture()
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
      fixture?.cleanup()
    })

    it('folds child under parent, isolates research tab, renders run ChatThread and fullscreen Diff drawer', async () => {
      if (!browser || !fixture) throw new Error('fixture not ready')
      const viewport = { width: 1280, height: 800 }
      const context = await browser.newContext({ viewport, locale: 'zh-CN' })
      const page = await context.newPage()

      if (devicesFile) {
        writeFileSync(
          devicesFile,
          JSON.stringify({ approved: [], pending: [] }),
        )
        await page.goto(
          `${base}/zh/console/me/writing?remote=1#pair=${encodeURIComponent(token)}${roomQuery}`,
        )
        await page
          .locator('main[data-remote-mode]')
          .waitFor({ timeout: 20_000 })
        await page.getByRole('button', { name: '申请授权' }).click()
        const command = page.locator('code', { hasText: '--approve' })
        await command.waitFor({ timeout: 20_000 })
        const devId = ((await command.textContent()) ?? '')
          .trim()
          .split(' ')
          .at(-1)
        execFileSync(
          join(repoRoot, 'scripts/dev/install-remote-relay.sh'),
          ['--approve', devId ?? ''],
          { env: { ...process.env, WEZDECK_REMOTE_DEVICES: devicesFile } },
        )
        await page.getByRole('button', { name: '重新检查' }).click()
        await page.getByText(/^已获批。/).waitFor({ timeout: 15_000 })
      }

      await page.goto(
        `${base}/zh/console/collab?remote=1#pair=${encodeURIComponent(token)}${roomQuery}`,
      )
      await page.locator('main[data-remote-mode]').waitFor({ timeout: 20_000 })

      // 1. Default "进行中" folds child under parent and excludes standalone research
      const groupEl = page.locator(`[data-ticket-group="${fixture.parentId}"]`)
      await groupEl.waitFor({ timeout: 15_000 })
      await groupEl.getByTestId('ticket-group-waiting').waitFor()
      expect(
        await page.locator(`[data-ticket="${fixture.researchId}"]`).count(),
      ).toBe(0)

      // Toggle collapse/expand on parent group
      const childLink = groupEl.locator(`[data-ticket="${fixture.childId}"]`)
      await childLink.waitFor()
      await groupEl.getByTestId('ticket-group-toggle').click()
      await expect.poll(() => childLink.count()).toBe(0)
      await groupEl.getByTestId('ticket-group-toggle').click()
      await childLink.waitFor()

      // 2. Switching to "调研" shows the standalone research ticket
      await page.getByRole('radio', { name: /调研/ }).click()
      await page
        .locator(`[data-ticket="${fixture.researchId}"]`)
        .waitFor({ timeout: 10_000 })

      // 3. Open child ticket: shows Back-to-parent button, ChatThread run output, and Diff drawer
      await page.goto(
        `${base}/zh/console/collab/${fixture.childId}?remote=1#pair=${encodeURIComponent(token)}${roomQuery}`,
      )
      const pane = page.getByTestId('ticket-pane')
      await pane.getByTestId('ticket-parent-back').waitFor({ timeout: 15_000 })
      const runChat = pane.getByTestId('ticket-run-chat')
      await runChat.waitFor({ timeout: 15_000 })
      await runChat
        .getByText(`Worker finished updating handler.ts (${fixture.suffix}).`)
        .waitFor({ timeout: 15_000 })

      // 4. Click Diff button (fullscreen net diff sheet shows handler.ts with +2 -1)
      await pane.getByTestId('ticket-diff-button').click()
      const diffSheet = page.getByTestId('ticket-diff-sheet')
      await diffSheet.waitFor({ timeout: 10_000 })
      const box = await diffSheet.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.width).toBeGreaterThanOrEqual(viewport.width - 2)
      expect(box!.height).toBeGreaterThanOrEqual(viewport.height - 2)

      const fileCard = diffSheet.locator('[data-file="handler.ts"]')
      await fileCard.waitFor({ timeout: 15_000 })
      expect(await fileCard.innerText()).toContain('export const ready = true')

      // 5. Annotate file in Diff drawer -> sticky Send review (1) button appears
      await fileCard.getByTestId('ticket-diff-annotate').click()
      await fileCard.locator('textarea').fill('Check null guard here')
      const sendReviewBtn = diffSheet.getByTestId('ticket-diff-send-review')
      await sendReviewBtn.waitFor({ timeout: 5_000 })
      expect(await sendReviewBtn.innerText()).toContain('1')

      // 6. Navigate to parent ticket -> parked Manager Session panel renders with Wake + composer
      await page.goto(
        `${base}/zh/console/collab/${fixture.parentId}?remote=1#pair=${encodeURIComponent(token)}${roomQuery}`,
      )
      const mgrPanel = page.getByTestId('ticket-manager-panel')
      await mgrPanel.waitFor({ timeout: 15_000 })
      await mgrPanel.getByTestId('ticket-manager-resume-button').waitFor()
      await mgrPanel.getByTestId('ticket-manager-composer').waitFor()

      await context.close()
    }, 60_000)
  },
)
