// covers: web/src/features/session-chat-row.tsx web/src/features/session-chat-group.tsx web/src/features/session-row-swipe.tsx
// covers: web/src/features/session-list.tsx web/src/features/session-list-trace.ts web/src/features/session-split.tsx web/src/components/deck/split-column.tsx
// covers: web/src/features/repo-links.tsx web/src/styles/motion.css web/src/styles/deck.css
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

async function afterPaint(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

async function listScrollTop(page: Page) {
  return page.evaluate(
    () =>
      document.querySelector<HTMLElement>(
        '.vt-split-list [data-overlayscrollbars-viewport], .vt-split-list .overflow-y-auto',
      )?.scrollTop,
  )
}

async function scrolledRowState(page: Page, id: string) {
  const box = await page.locator(`[data-session=${id}]`).boundingBox()
  if (!box) throw new Error(`row ${id} is not visible`)
  return { box, scrollTop: await listScrollTop(page) }
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
        return {
          width: bmp.width,
          height: bmp.height,
          data: ctx.getImageData(0, 0, bmp.width, bmp.height).data,
        }
      }
      const d1 = await decode(s1)
      const d2 = await decode(s2)
      if (d1.width !== d2.width || d1.height !== d2.height) return Infinity
      // Fractional DPR can move a composited row's raster phase by one device
      // pixel while all DOM rectangles stay unchanged. Compare the shared
      // interior after that small alignment; actual content changes still fail.
      return Math.min(
        ...[-1, 0, 1].map((dy) => {
          let changed = 0
          for (let y = 1; y < d1.height - 1; y++) {
            for (let x = 0; x < d1.width; x++) {
              const i = (y * d1.width + x) * 4
              const j = ((y + dy) * d2.width + x) * 4
              const diff =
                Math.abs(d1.data[i] - d2.data[j]) +
                Math.abs(d1.data[i + 1] - d2.data[j + 1]) +
                Math.abs(d1.data[i + 2] - d2.data[j + 2])
              if (diff > 3) changed += 1
            }
          }
          return changed
        }),
      )
    },
    [a.toString('base64'), b.toString('base64')],
  )
}

async function countWatchFlashes(
  page: Page,
  frames: Array<string>,
  box: { x: number; y: number; width: number; height: number },
) {
  return page.evaluate(
    async ([encoded, rect]) => {
      const decode = async (b64: string) => {
        const res = await fetch(`data:image/png;base64,${b64}`)
        const bmp = await createImageBitmap(await res.blob())
        const canvas = document.createElement('canvas')
        canvas.width = bmp.width
        canvas.height = bmp.height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(bmp, 0, 0)
        return {
          w: bmp.width,
          h: bmp.height,
          d: ctx.getImageData(0, 0, bmp.width, bmp.height).data,
        }
      }
      const imgs = []
      for (const f of encoded) imgs.push(await decode(f))
      const sx = Math.max(0, Math.floor(rect.x))
      const sy = Math.max(0, Math.floor(rect.y))
      const ex = Math.min(imgs[0].w, Math.ceil(rect.x + rect.width))
      const ey = Math.min(imgs[0].h, Math.ceil(rect.y + rect.height))
      let changedFrames = 0
      for (let k = 1; k < imgs.length; k++) {
        let changed = 0
        const a = imgs[k - 1]
        const b = imgs[k]
        for (let y = sy; y < ey; y++) {
          for (let x = sx; x < ex; x++) {
            const i = (y * a.w + x) * 4
            const diff =
              Math.abs(a.d[i] - b.d[i]) +
              Math.abs(a.d[i + 1] - b.d[i + 1]) +
              Math.abs(a.d[i + 2] - b.d[i + 2])
            if (diff > 3) changed++
          }
        }
        if (changed > 0) changedFrames++
      }
      return changedFrames
    },
    [frames, box] as const,
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
        status: s.id === 'st-g1' ? 'running' : 'idle',
        agent_name: 'claude',
        tmux_window_name: s.id,
        session_title: s.title || undefined,
        last_user_prompt: s.prompt,
        ts: now - 3600_000 * (idx + 2),
        turn_started: s.id === 'st-g1' ? now - 30_000 : undefined,
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

type LayerInfo = { layerId: string; drawsContent: boolean }

async function collectActiveAnimReasons(
  cdp: Awaited<ReturnType<Browser['newContext']>> extends infer C
    ? C extends { newCDPSession: (p: Page) => Promise<infer S> }
      ? S
      : never
    : never,
  layers: Array<LayerInfo>,
) {
  const bad: Array<string> = []
  for (const layer of layers) {
    if (!layer.drawsContent) continue
    const res = await cdp
      .send('LayerTree.compositingReasons', { layerId: layer.layerId })
      .catch(() => ({ compositingReasonIds: [] as Array<string> }))
    for (const reason of res.compositingReasonIds) {
      if (
        reason === 'ActiveOpacityAnimation' ||
        reason === 'ActiveTransformAnimation'
      )
        bad.push(reason)
    }
  }
  return bad
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
      expect(
        await page.locator('[data-session=st-watch]').boundingBox(),
      ).toEqual(watchBox)
      const afterTall = await page.screenshot({ clip: watchBox! })
      await page.keyboard.press('k') // st-tall -> st-short
      await page.waitForTimeout(350)
      expect(
        await page.locator('[data-session=st-watch]').boundingBox(),
      ).toEqual(watchBox)
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
      await afterPaint(page)
      const beforeState = await scrolledRowState(page, 'st-g3')
      expect(beforeState.scrollTop).toBeGreaterThan(0)
      const sBefore = await page.screenshot({ clip: beforeState.box })
      await page.keyboard.press('j') // st-short -> st-tall
      await page.waitForTimeout(350)
      await afterPaint(page)
      const afterState = await scrolledRowState(page, 'st-g3')
      expect(afterState).toEqual(beforeState)
      const sAfter = await page.screenshot({ clip: beforeState.box })
      expect(await countPixelDiff(page, sBefore, sAfter)).toBe(0)

      await context.close()
    }
  }, 60_000)

  it('switching from 我的 to 会话 keeps .vt-page un-scrolled with isolated compositor panes', async () => {
    const context = await stack.browser.newContext({
      viewport: { width: 1292, height: 866 },
      deviceScaleFactor: 2.625,
    })
    const page = await context.newPage()
    await page.goto(
      `${base}/zh/console/sessions/st-tall?remote=1#pair=${token}`,
    )
    await page.locator('[data-session=st-tall]').waitFor({ timeout: 20_000 })
    await page.waitForTimeout(400)

    await page.locator('aside.vt-sidebar a[href*="/console/me"]').click()
    await page.locator('[data-me=agents]').waitFor({ timeout: 10_000 })
    await page.locator('[data-me=agents]').click()
    await page.locator('[data-testid=agents-page]').waitFor({ timeout: 10_000 })

    await page.locator('aside.vt-sidebar a[href*="/console/sessions"]').click()
    await page.locator('[data-session=st-tall]').waitFor({ timeout: 20_000 })
    await page.waitForTimeout(500)

    const state = await page.evaluate(() => {
      const vtPage = document.querySelector<HTMLElement>('.vt-page')!
      const pane = document.querySelector<HTMLElement>('.vt-split-pane')!
      const threadScroll = document.querySelector<HTMLElement>(
        '[data-testid=session-thread-scroll]',
      )!
      const detail = document.querySelector<HTMLElement>(
        '[data-testid=session-detail]',
      )!
      const header = document.querySelector<HTMLElement>(
        '[data-testid=session-header]',
      )!
      const form = document
        .querySelector('#session-composer')
        ?.closest<HTMLElement>('form')
      const list = document.querySelector<HTMLElement>('.vt-split-list')!
      const swipeRow = document.querySelector<HTMLElement>(
        '.vt-split-list [data-swipe] > div',
      )
      return {
        pageScrollTop: vtPage.scrollTop,
        pageRoom: vtPage.scrollHeight - vtPage.clientHeight,
        pageVtName: getComputedStyle(vtPage).viewTransitionName,
        paneScrollTop: threadScroll.scrollTop,
        paneRoom: threadScroll.scrollHeight - threadScroll.clientHeight,
        detailHeight: Math.round(detail.getBoundingClientRect().height),
        headerPosition: getComputedStyle(header).position,
        formPosition: form ? getComputedStyle(form).position : 'none',
        listPosition: getComputedStyle(list).position,
        listWillChange: getComputedStyle(list).willChange,
        listContain: getComputedStyle(list).contain,
        paneContain: getComputedStyle(pane).contain,
        idleSwipeTransform: swipeRow
          ? getComputedStyle(swipeRow).transform
          : 'none',
        idleSwipeButtons: document.querySelectorAll(
          '.vt-split-list [data-testid=chat-swipe-copy], .vt-split-list [data-testid=chat-swipe-mark-read]',
        ).length,
      }
    })
    expect(state.pageScrollTop).toBe(0)
    expect(state.pageRoom).toBeLessThanOrEqual(1)
    expect(state.pageVtName).toBe('none')
    expect(state.paneRoom).toBeGreaterThan(200)
    expect(state.paneScrollTop).toBeGreaterThan(200)
    expect(state.detailHeight).toBeLessThanOrEqual(866)
    expect(state.headerPosition).not.toBe('sticky')
    expect(state.formPosition).not.toBe('sticky')
    expect(state.listPosition).not.toBe('sticky')
    expect(state.listWillChange).toBe('auto')
    expect(state.listContain).toBe('strict')
    expect(state.paneContain).toBe('strict')
    expect(state.idleSwipeTransform).toBe('none')
    expect(state.idleSwipeButtons).toBe(0)

    await context.close()
  }, 45_000)

  it('switching sessions never flashes uninvolved rows mid-transition (per-frame screencast)', async () => {
    const context = await stack.browser.newContext({
      viewport: { width: 1292, height: 866 },
      deviceScaleFactor: 2.625,
      colorScheme: 'dark',
    })
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await page.goto(
      `${base}/zh/console/sessions/st-short?remote=1#pair=${token}`,
    )
    await page.locator('[data-session=st-watch]').waitFor({ timeout: 20_000 })
    await page.waitForTimeout(500)

    const watchBox = await page.locator('[data-session=st-watch]').boundingBox()
    expect(watchBox).toBeTruthy()

    const frames: Array<string> = []
    cdp.on('Page.screencastFrame', async (ev) => {
      frames.push(ev.data)
      await cdp
        .send('Page.screencastFrameAck', { sessionId: ev.sessionId })
        .catch(() => undefined)
    })
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })

    for (const target of ['st-tall', 'st-draft', 'st-short']) {
      await page.locator(`[data-session=${target}]`).click()
      await page.waitForTimeout(350)
    }
    await cdp.send('Page.stopScreencast')
    expect(frames.length).toBeGreaterThan(10)

    expect(await countWatchFlashes(page, frames, watchBox!)).toBe(0)

    // LayerTree invariant: idle <-> running switches must spawn zero GPU opacity/transform layers.
    await cdp.send('LayerTree.enable')
    let layers: Array<LayerInfo> = []
    cdp.on('LayerTree.layerTreeDidChange', (ev) => {
      if (ev.layers) layers = ev.layers
    })
    await page.locator('[data-session=st-g3]').click()
    await page.waitForTimeout(250)
    expect(await collectActiveAnimReasons(cdp, layers)).toEqual([])
    await page.locator('[data-session=st-g1]').click()
    await page.waitForTimeout(45)
    expect(await collectActiveAnimReasons(cdp, layers)).toEqual([])
    await page.waitForTimeout(250)
    expect(await collectActiveAnimReasons(cdp, layers)).toEqual([])

    await context.close()
  }, 60_000)
})
