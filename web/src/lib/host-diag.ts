// Diagnostics the host pulls (`wezdeck-wsl diag`, native relay_diag.go): the
// relay pushes {t:"diag.request", id, data:{reason, steps}}; this page may
// first drive its own UI through `steps` to reproduce a problem while
// recording frame timing, then answers with the client-trace snapshot as
// `diag.submit` chunks. A toast says the host read diagnostics.
//
// Steps (allowlisted; anything else is reported as skipped):
//   {do:"navigate", to:"/zh/console/sessions"}  in-app path only
//   {do:"back"}
//   {do:"click", text?:"会话", selector?:"[data-session=…]"}
//       never a write control: nothing inside a <form> or [data-write]
//   {do:"scroll", to:"top"|"bottom"|number}
//   {do:"wait", ms:800}                    ≤ 10 s
//   {do:"layout"}  what overflows the viewport: offending elements with
//                  their box, font size and text; root font size, text zoom
//   {do:"sample-list", ms?:1500, selector?:...}
//                  sample every list row rect and split-list scrollTop across
//                  rAF frames to catch live flicker/jitter without mutations
// Each step records its result and the frames of the next `sample` ms
// (default 700).
import type { AnyRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import {
  UPDATED_KEY,
  UPDATED_REASON_KEY,
  buildId,
  notifyUpdateAvailable,
} from '#/lib/pwa'

import {
  diagnosticsSnapshot,
  listScroller,
  sampleFrames,
  shellMetrics,
  trace,
} from '#/lib/client-trace'
import { remoteLink } from '#/lib/remote-link'
import { hostRead, hostWrite, readsLocally } from '#/lib/runtime-client'

export { UPDATED_KEY, UPDATED_REASON_KEY }

type Step = {
  do: string
  to?: string | number
  text?: string
  selector?: string
  /** query: the attributes to read (besides rect and text) */
  attrs?: Array<string>
  ms?: number
  sample?: number
}

const QUERY_MAX = 10

/**
 * `query` (read only): what the page shows for a selector — up to ten
 * elements' requested attributes, box and text — so a fix can be checked on
 * the person's own device and session instead of a sample (e.g.
 * {"do":"query","selector":"[data-testid=session-tags]","attrs":["data-folded"]}).
 */
function query(step: Step) {
  if (!step.selector) return { skipped: 'query needs a selector' }
  let found: Array<HTMLElement>
  try {
    found = [...document.querySelectorAll<HTMLElement>(step.selector)]
  } catch {
    return { skipped: 'bad selector' }
  }
  return {
    count: found.length,
    items: found.slice(0, QUERY_MAX).map((el) => {
      const r = el.getBoundingClientRect()
      return {
        tag: el.tagName.toLowerCase(),
        attrs: Object.fromEntries(
          (step.attrs ?? []).map((name) => [name, el.getAttribute(name)]),
        ),
        rect: [r.x, r.y, r.width, r.height].map(Math.round),
        text: el.textContent.trim().slice(0, 80),
      }
    }),
  }
}

/** the build the site serves now (the page may still run an older one) */
async function deployedBuild() {
  try {
    const res = await fetch('/build.json', { cache: 'no-store' })
    return ((await res.json()) as { buildId?: string }).buildId ?? null
  } catch {
    return null
  }
}

const CHUNK = 36 * 1024
const MAX_STEPS = 30
// one id per page load: the host files answers per phone. Made on first use —
// Workers refuse random values in global scope (this module is in the SSR
// bundle too)
let clientId = ''
const pageId = () =>
  (clientId ||= Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join(''))

const scroller = () =>
  document.querySelector<HTMLElement>(
    '[data-testid=session-thread-scroll].overflow-y-auto',
  ) ??
  document.querySelector<HTMLElement>('.vt-split-pane.overflow-y-auto') ??
  document.getElementById('console-main')?.parentElement ??
  null

function findTarget(step: Step): HTMLElement | null {
  if (step.selector) {
    try {
      return document.querySelector<HTMLElement>(step.selector)
    } catch {
      return null
    }
  }
  if (!step.text) return null
  const want = step.text
  const visible = [
    ...document.querySelectorAll<HTMLElement>(
      'a, button, summary, [role=button], [role=tab]',
    ),
  ].filter((el) => el.offsetParent !== null)
  // exact text first (「工单」 must not hit 「工单动态」), then the shortest match
  return (
    visible.find((el) => el.textContent.trim() === want) ??
    visible
      .filter((el) => el.textContent.includes(want))
      .sort((x, y) => x.textContent.length - y.textContent.length)
      .at(0) ??
    null
  )
}

/** elements sticking out of the viewport (horizontal overflow on a phone) */
function layoutReport(): Record<string, unknown> {
  const vw = document.documentElement.clientWidth
  const box = scroller()
  const offenders: Array<Record<string, unknown>> = []
  for (const el of document.querySelectorAll<HTMLElement>('body *')) {
    const r = el.getBoundingClientRect()
    // width ≤ 1: visually hidden (sr-only skip link)
    if (r.width <= 1 || (r.right <= vw + 0.5 && r.left >= -0.5)) continue
    // the innermost ones say most: skip containers whose children overflow too
    if (
      [...el.children].some((c) => c.getBoundingClientRect().right > vw + 0.5)
    )
      continue
    const cs = getComputedStyle(el)
    offenders.push({
      tag: el.tagName.toLowerCase(),
      cls: el.className.toString().slice(0, 120),
      left: Math.round(r.left),
      right: Math.round(r.right),
      width: Math.round(r.width),
      fontSize: cs.fontSize,
      whiteSpace: cs.whiteSpace,
      text: el.textContent.trim().slice(0, 60),
    })
    if (offenders.length >= 15) break
  }
  const root = getComputedStyle(document.documentElement)
  return {
    vw,
    innerWidth: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    scroller: box ? [box.scrollWidth, box.clientWidth] : null,
    rootFontSize: root.fontSize,
    textSizeAdjust: root.getPropertyValue('text-size-adjust') || null,
    shell: shellMetrics(),
    offenders,
  }
}

/**
 * On-demand live row geometry probe (`{"do":"sample-list","ms":2000}`):
 * samples every matching list row's rect + split-list scrollTop across rAF
 * frames to catch flickering / subpixel jitter on a real tablet or phone.
 */
function sampleListGeometry(step: Step): Promise<Record<string, unknown>> {
  const selector =
    step.selector ||
    '.vt-split-list [data-session], [data-testid=session-chats] [data-session]'
  const duration = Math.min(Math.max(step.ms ?? 1500, 200), 5000)
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'undefined') {
      resolve({ skipped: 'no rAF' })
      return
    }
    const start = performance.now()
    let frames = 0
    let shiftedFrames = 0
    let maxDy = 0
    let maxDh = 0
    let maxDx = 0
    let scrollJumps = 0
    let prevScrollTop: number | null = null
    const prevRects = new Map<string, { x: number; y: number; h: number }>()
    const shifts: Array<Record<string, unknown>> = []
    const round2 = (n: number) => Math.round(n * 100) / 100

    const tick = (now: number) => {
      frames++
      const ls = listScroller()
      const scrollTop = ls?.vp?.top ?? null
      if (
        prevScrollTop !== null &&
        scrollTop !== null &&
        scrollTop !== prevScrollTop
      ) {
        scrollJumps++
      }
      prevScrollTop = scrollTop

      let els: Array<HTMLElement> = []
      try {
        els = [...document.querySelectorAll<HTMLElement>(selector)]
      } catch {
        resolve({ skipped: 'bad selector' })
        return
      }
      let frameShifted = false
      let subpixelRows = 0
      for (const el of els) {
        const id =
          el.dataset.session ??
          el.dataset.ticket ??
          el.dataset.me ??
          el.dataset.testid ??
          ''
        if (!id) continue
        const r = el.getBoundingClientRect()
        if (
          Math.abs(r.y - Math.round(r.y)) > 0.01 ||
          Math.abs(r.height - Math.round(r.height)) > 0.01
        ) {
          subpixelRows++
        }
        const prev = prevRects.get(id)
        if (prev) {
          const dx = Math.abs(r.x - prev.x)
          const dy = Math.abs(r.y - prev.y)
          const dh = Math.abs(r.height - prev.h)
          if (dx > 0.1 || dy > 0.1 || dh > 0.1) {
            frameShifted = true
            maxDx = Math.max(maxDx, dx)
            maxDy = Math.max(maxDy, dy)
            maxDh = Math.max(maxDh, dh)
            if (shifts.length < 15) {
              shifts.push({
                frame: frames,
                t: Math.round(now - start),
                id,
                dx: round2(r.x - prev.x),
                dy: round2(r.y - prev.y),
                dh: round2(r.height - prev.h),
                scrollTop,
              })
            }
          }
        }
        prevRects.set(id, { x: r.x, y: r.y, h: r.height })
      }
      if (frameShifted) shiftedFrames++
      if (now - start < duration) {
        requestAnimationFrame(tick)
      } else {
        resolve({
          ms: Math.round(now - start),
          frames,
          rows: els.length,
          shiftedFrames,
          maxDx: round2(maxDx),
          maxDy: round2(maxDy),
          maxDh: round2(maxDh),
          scrollJumps,
          subpixelRows,
          listScroller: ls,
          shifts,
        })
      }
    }
    requestAnimationFrame(tick)
  })
}

async function runStep(
  router: AnyRouter,
  step: Step,
): Promise<Record<string, unknown>> {
  switch (step.do) {
    case 'navigate': {
      const to = String(step.to ?? '')
      if (!to.startsWith('/') || to.startsWith('//'))
        return { skipped: 'in-app paths only' }
      await router.navigate({ href: to })
      return { ok: true }
    }
    case 'back':
      router.history.back()
      return { ok: true }
    case 'click': {
      const el = findTarget(step)
      if (!el) return { skipped: 'target not found' }
      if (el.closest('form, [data-write]'))
        return { skipped: 'write control (never clicked by the host)' }
      el.click()
      return { ok: true, target: el.textContent.trim().slice(0, 40) }
    }
    case 'scroll': {
      const box = scroller()
      if (!box) return { skipped: 'no scroller' }
      const top =
        step.to === 'bottom'
          ? box.scrollHeight
          : step.to === 'top'
            ? 0
            : Number(step.to) || 0
      box.scrollTo({ top, behavior: 'smooth' })
      return { ok: true }
    }
    case 'wait':
      await new Promise((r) => setTimeout(r, Math.min(step.ms ?? 500, 10_000)))
      return { ok: true }
    case 'layout':
      return layoutReport()
    case 'query':
      return query(step)
    case 'sample-list':
      return sampleListGeometry(step)
    case 'reload':
      // done after the snapshot is sent (answer): reloading here would
      // lose the answer
      return { ok: true, deferred: 'after the snapshot' }
    case 'notify-update':
      // non-disruptive: show sticky "New version available" toast and wait for
      // a safe idle window instead of reloading under active fingers
      return { ok: true, deferred: 'notify-update' }
  }
  return { skipped: `unknown step ${step.do}` }
}

type Submit = (args: Record<string, unknown>) => Promise<unknown>

/** a paired device answers over the relay link */
const overRelay: Submit = (args) => remoteLink.rpc('diag.submit', args)

/** Clip host `--reason` for toast / sessionStorage (one line, short). */
export function clipDiagReason(reason?: string): string {
  return (reason ?? '').trim().replace(/\s+/g, ' ').slice(0, 120)
}

/**
 * Toast copy for a host diag request. `kind: 'reload'` is the pre-reload
 * notice; after reload `pwa-boot.tsx` says 已更新到新版本 with the same reason.
 */
export function diagToastMessage(
  zh: boolean,
  steps: number,
  reason: string,
  kind: 'diag' | 'reload',
): string {
  const base =
    kind === 'reload'
      ? zh
        ? '即将刷新到新版本'
        : 'Reloading onto the new build'
      : steps > 0
        ? zh
          ? `调试中：正在这个页面复现问题（${steps} 步）`
          : `Debugging: reproducing a problem on this page (${steps} steps)`
        : zh
          ? '已读取这个页面的诊断信息'
          : 'Diagnostics read from this page'
  return reason ? `${base} · ${reason}` : base
}

async function answer(
  router: AnyRouter,
  id: string,
  data: { reason?: string; steps?: Array<Step> },
  submit: Submit = overRelay,
) {
  const steps = Array.isArray(data.steps) ? data.steps.slice(0, MAX_STEPS) : []
  const reason = clipDiagReason(data.reason)
  const willReload = steps.some((step) => step.do === 'reload')
  const willNotifyUpdate =
    !willReload && steps.some((step) => step.do === 'notify-update')
  trace('host-diag', {
    id,
    steps: steps.length,
    reason,
    action: willReload
      ? 'reload'
      : willNotifyUpdate
        ? 'notify-update'
        : steps.length
          ? 'steps'
          : 'snapshot',
  })
  // outside React (no Lingui provider here): pick the page language
  const zh = document.documentElement.lang.startsWith('zh')
  // Non-disruptive update announcements let pwa-boot show the quiet sticky
  // "New version available · Reload" toast instead of a pre-reload warning.
  if (!willNotifyUpdate) {
    toast(
      diagToastMessage(
        zh,
        steps.length,
        reason,
        willReload ? 'reload' : 'diag',
      ),
      { id: 'host-diag', duration: willReload ? 2500 : 4000 },
    )
  }
  const results: Array<Record<string, unknown>> = []
  for (const step of steps) {
    const frames = sampleFrames(Math.min(step.sample ?? 700, 5000))
    let result: Record<string, unknown>
    try {
      result = await runStep(router, step)
    } catch (e) {
      result = { error: (e as Error).message }
    }
    results.push({
      ...step,
      ...result,
      page: location.pathname,
      frames: await frames,
    })
  }
  const json = JSON.stringify(
    diagnosticsSnapshot({
      hostRequest: {
        id,
        reason: data.reason,
        steps: results,
        deployed: await deployedBuild(),
      },
    }),
  )
  const total = Math.max(1, Math.ceil(json.length / CHUNK))
  for (let seq = 0; seq < total; seq++)
    await submit({
      id,
      client: pageId(),
      seq,
      total,
      data: json.slice(seq * CHUNK, (seq + 1) * CHUNK),
    })
  // `reload` step (`wezdeck-wsl diag --reload`): the host just shipped and
  // wants this phone on the new build without anyone tapping 刷新 — the
  // snapshot above still reports the build it ran
  if (willReload) reloadWhenIdle(reason)
  else if (willNotifyUpdate) void notifyUpdateAvailable(reason)
}

/** typing in a text field (the composer, a reply box) */
const typing = () => {
  const el = document.activeElement
  return (
    (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) &&
    el.value.length > 0
  )
}

/**
 * Onto the new build — but not under someone's fingers: while a text field
 * with text in it has focus, wait for it to blur (at most a minute; drafts
 * are kept anyway). The new page then says 已更新到新版本 once (with `reason`
 * when the host passed `--reason`).
 */
function reloadWhenIdle(reason = '') {
  const go = () => {
    try {
      sessionStorage.setItem(UPDATED_KEY, buildId)
      if (reason) sessionStorage.setItem(UPDATED_REASON_KEY, reason)
      else sessionStorage.removeItem(UPDATED_REASON_KEY)
    } catch {
      // storage blocked: the reload still happens, just unannounced
    }
    trace('host-reload', { deferred: Date.now() - asked, reason })
    location.reload()
  }
  const asked = Date.now()
  if (!typing()) return go()
  const check = setInterval(() => {
    if (!typing() || Date.now() - asked > 60_000) {
      clearInterval(check)
      go()
    }
  }, 1_000)
}

/**
 * The host's own browser (local mode: reads and writes through the Runtime)
 * gets no relay push: while shown it asks every few seconds whether the host
 * wants diagnostics from it (`diag.pending` → relay_diag.go localPending) and
 * answers through the Runtime too. Before this an agent could not reach the
 * page the person was looking at on the desktop (2026-11-25).
 */
const LOCAL_POLL_MS = 3_000

function pollLocal(router: AnyRouter, seen: Set<string>) {
  const tick = async () => {
    if (document.visibilityState !== 'visible' || !(await readsLocally()))
      return
    const reply = (await hostRead('diag.pending', { client: pageId() })) as {
      requests?: Array<{ id: string; reason?: string; steps?: Array<Step> }>
    }
    for (const request of reply.requests ?? []) {
      if (seen.has(request.id)) continue
      seen.add(request.id)
      void answer(router, request.id, request, (args) =>
        hostWrite('diag.submit', args),
      ).catch((e: unknown) =>
        trace('host-diag-error', {
          id: request.id,
          error: (e as Error).message,
        }),
      )
    }
  }
  setInterval(() => void tick().catch(() => undefined), LOCAL_POLL_MS)
}

let installed = false

export function installHostDiag(router: AnyRouter) {
  if (installed || typeof window === 'undefined') return
  installed = true
  const seen = new Set<string>()
  remoteLink.onHostRequest((frame) => {
    if (frame.t !== 'diag.request' || !frame.id || seen.has(frame.id)) return
    seen.add(frame.id) // the request can arrive on both channels
    void answer(
      router,
      frame.id,
      (frame.data ?? {}) as { reason?: string; steps?: Array<Step> },
    ).catch((e: unknown) =>
      trace('host-diag-error', { id: frame.id, error: (e as Error).message }),
    )
  })
  pollLocal(router, seen)
  // every page change records its frames: "the animation feels bad" shows up
  // in the next pulled snapshot without a reproduction
  router.subscribe('onBeforeNavigate', ({ toLocation, fromLocation }) => {
    const from = fromLocation?.pathname
    void sampleFrames(700).then((frames) =>
      trace('nav-frames', { from, to: toLocation.pathname, ...frames }),
    )
  })
}
