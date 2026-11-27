// covers: web/src/features/session-chat-row.tsx web/src/features/session-chat-group.tsx
// covers: web/src/features/session-list.tsx web/src/components/deck/split-column.tsx
// covers: web/src/features/repo-links.tsx
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const base = process.env.WEZDECK_REMOTE_URL || 'http://127.0.0.1:3018'
const token = process.env.WEZDECK_REMOTE_TOKEN || 'dev-client-token'
const attention = process.env.WEZDECK_TEST_ATTENTION ?? ''

type RowRect = { top: number; height: number; prevTop: number | null }

async function snapshotRows(page: Page): Promise<Record<string, RowRect>> {
  return page.evaluate(() => {
    const out: Record<string, RowRect> = {}
    for (const el of document.querySelectorAll(
      '.vt-split-list [data-session]',
    )) {
      const id = el.getAttribute('data-session')
      if (!id) continue
      const r = el.getBoundingClientRect()
      const p = (
        el.querySelector('[data-testid=chat-preview]') ??
        el.querySelector('[data-testid=session-preview]')
      )?.getBoundingClientRect()
      out[id] = { top: r.top, height: r.height, prevTop: p ? p.top : null }
    }
    return out
  })
}

async function countPixelDiff(page: Page, a: Buffer, b: Buffer) {
  return page.evaluate(
    async ([s1, s2]) => {
      const decode = async (b64: string) => {
        const res = await fetch(`data:image/png;base64,${b64}`)
        const bmp = await createImageBitmap(await res.blob())
        const canvas = document.createElement('canvas')
        canvas.width = bmp.width
        canvas.height = bmp.height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(bmp, 0, 0)
        return ctx.getImageData(0, 0, bmp.width, bmp.height).data
      }
      const d1 = await decode(s1)
      const d2 = await decode(s2)
      let changed = 0
      for (let i = 0; i < d1.length; i += 4) {
        const diff =
          Math.abs(d1[i] - d2[i]) +
          Math.abs(d1[i + 1] - d2[i + 1]) +
          Math.abs(d1[i + 2] - d2[i + 2])
        if (diff > 3) changed += 1
      }
      return changed
    },
    [a.toString('base64'), b.toString('base64')],
  )
}

function stabilityStack() {
  const ctx = {} as { browser: Browser }
  const socket = join(mkdtempSync(join(tmpdir(), 'wd-stab-')), 'sock')
  const tmux = (...args: Array<string>) =>
    execFileSync('tmux', ['-S', socket, ...args])
      .toString()
      .trim()

  beforeAll(async () => {
    const now = Date.now()
    const entries: Record<string, unknown> = {}
    const specs = [
      {
        id: 'st-short',
        cwd: 'repo-a/w1',
        cmd: 'sh -c "seq 1 5; exec cat"',
        prompt: '短会话提示',
        title: '短会话',
      },
      {
        id: 'st-tall',
        cwd: 'repo-a/w2',
        cmd: 'sh -c "seq 1 400; exec cat"',
        prompt: '长会话提示',
        title: '长会话',
      },
      {
        id: 'st-draft',
        cwd: 'repo-a/w3',
        cmd: 'sh -c "seq 1 5; exec cat"',
        prompt: '草稿会话提示',
        title: '草稿会话',
      },
      {
        id: 'st-watch',
        cwd: 'repo-a/w4',
        cmd: 'sh -c "seq 1 5; exec cat"',
        prompt: '观察行提示',
        title: '观察行',
      },
      {
        id: 'st-g1',
        cwd: 'repo-b/grp',
        cmd: 'sh -c "seq 1 5; exec cat"',
        prompt: '分组一提示',
        title: '分组一',
      },
      {
        id: 'st-g2',
        cwd: 'repo-b/grp',
        cmd: 'sh -c "seq 1 5; exec cat"',
        prompt: '',
        title: '',
      },
      {
        id: 'st-g3',
        cwd: 'repo-b/grp',
        cmd: 'sh -c "seq 1 5; exec cat"',
        prompt: '分组三提示',
        title: '分组三',
      },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `st-pad-${i}`,
        cwd: `repo-c/p-${i}`,
        cmd: 'sh -c "seq 1 5; exec cat"',
        prompt: `填充会话 ${i}`,
        title: `填充 ${i}`,
      })),
    ]
    specs.forEach((s, idx) => {
      const cwd = join(dirname(socket), s.cwd)
      mkdirSync(cwd, { recursive: true })
      tmux(
        'new-session',
        '-d',
        '-s',
        s.id,
        '-c',
        cwd,
        '-x',
        '100',
        '-y',
        '120',
        s.cmd,
      )
      entries[s.id] = {
        session_id: s.id,
        tmux_socket: socket,
        tmux_session: s.id,
        tmux_pane: tmux('display-message', '-p', '-t', s.id, '#{pane_id}'),
        status: 'idle',
        agent_name: 'claude',
        tmux_window_name: s.id,
        session_title: s.title || undefined,
        last_user_prompt: s.prompt,
        ts: now - 3600_000 * (idx + 2),
      }
    })
    writeFileSync(attention, JSON.stringify({ entries }))
    ctx.browser = await chromium.launch()
  })

  afterAll(async () => {
    await ctx.browser.close()
    tmux('kill-server')
  })
  return ctx
}

describe.runIf(attention)('Wide split: list stability', () => {
  const stack = stabilityStack()

  it('toggling Draft on single and grouped rows never shifts row geometry', async () => {
    const context = await stack.browser.newContext({
      viewport: { width: 1280, height: 900 },
    })
    const page = await context.newPage()
    await page.addInitScript(() => {
      localStorage.setItem('wezdeck.draft.st-draft', '未发送的草稿')
      localStorage.setItem('wezdeck.draft.st-g1', '分组草稿一')
      localStorage.setItem('wezdeck.draft.st-g2', '空分组草稿二')
    })
    await page.goto(
      `${base}/zh/console/sessions/st-short?remote=1#pair=${token}`,
    )
    await page.locator('[data-session=st-g3]').waitFor({ timeout: 20_000 })
    await page.waitForTimeout(500)

    const baseRects = await snapshotRows(page)
    for (const id of [
      'st-short',
      'st-tall',
      'st-draft',
      'st-watch',
      'st-g1',
      'st-g2',
      'st-g3',
    ]) {
      expect(baseRects[id].height).toBe(64)
      expect(Number.isInteger(baseRects[id].top)).toBe(true)
    }

    // Switch through draft single row, draft sub-row, and empty idle draft sub-row
    for (const target of ['st-draft', 'st-short', 'st-g1', 'st-g2', 'st-g3']) {
      await page.locator(`[data-session=${target}]`).click()
      await page.waitForTimeout(250)
      const now = await snapshotRows(page)
      for (const id of Object.keys(baseRects)) {
        expect(now[id].height).toBe(baseRects[id].height)
        expect(now[id].top).toBe(baseRects[id].top)
        if (baseRects[id].prevTop !== null && now[id].prevTop !== null) {
          expect(now[id].prevTop).toBe(baseRects[id].prevTop)
        }
      }
    }
    await context.close()
  }, 45_000)

  it('switching short <-> tall keeps uninvolved rows pixel-identical at HiDPI (including scrolled list)', async () => {
    for (const dpr of [1.25, 2.625]) {
      const context = await stack.browser.newContext({
        viewport: { width: 1292, height: 866 },
        deviceScaleFactor: dpr,
      })
      const page = await context.newPage()
      await page.goto(
        `${base}/zh/console/sessions/st-short?remote=1#pair=${token}`,
      )
      await page.locator('[data-session=st-watch]').waitFor({ timeout: 20_000 })
      await page.waitForTimeout(500)
      await page.mouse.move(900, 400)
      await page.waitForTimeout(250)

      const watchBox = await page
        .locator('[data-session=st-watch]')
        .boundingBox()
      expect(watchBox).toBeTruthy()
      const before = await page.screenshot({ clip: watchBox! })
      await page.keyboard.press('j') // st-short -> st-tall
      await page.waitForTimeout(350)
      const afterTall = await page.screenshot({ clip: watchBox! })
      await page.keyboard.press('k') // st-tall -> st-short
      await page.waitForTimeout(350)
      const afterShort = await page.screenshot({ clip: watchBox! })

      expect(await countPixelDiff(page, before, afterTall)).toBe(0)
      expect(await countPixelDiff(page, afterTall, afterShort)).toBe(0)

      // Also verify when the left list itself is scrolled down
      await page.evaluate(() => {
        const vp = document.querySelector<HTMLElement>(
          '.vt-split-list [data-overlayscrollbars-viewport], .vt-split-list .overflow-y-auto',
        )
        if (vp) vp.scrollTop = 128
      })
      await page.waitForTimeout(150)
      const scrolledBox = await page
        .locator('[data-session=st-g3]')
        .boundingBox()
      expect(scrolledBox).toBeTruthy()
      const sBefore = await page.screenshot({ clip: scrolledBox! })
      await page.keyboard.press('j') // st-short -> st-tall
      await page.waitForTimeout(350)
      const sAfter = await page.screenshot({ clip: scrolledBox! })
      expect(await countPixelDiff(page, sBefore, sAfter)).toBe(0)

      await context.close()
    }
  }, 60_000)
})
