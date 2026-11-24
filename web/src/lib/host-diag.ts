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
// Each step records its result and the frames of the next `sample` ms
// (default 700).
import type { AnyRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { buildId } from '#/lib/pwa'

import {
  diagnosticsSnapshot,
  sampleFrames,
  shellMetrics,
  trace,
} from '#/lib/client-trace'
import { remoteLink } from '#/lib/remote-link'

type Step = {
  do: string
  to?: string | number
  text?: string
  selector?: string
  ms?: number
  sample?: number
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
  document.getElementById('console-main')?.parentElement ?? null

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
    case 'reload':
      // done after the snapshot is sent (answer): reloading here would
      // lose the answer
      return { ok: true, deferred: 'after the snapshot' }
  }
  return { skipped: `unknown step ${step.do}` }
}

async function answer(
  router: AnyRouter,
  id: string,
  data: { reason?: string; steps?: Array<Step> },
) {
  const steps = Array.isArray(data.steps) ? data.steps.slice(0, MAX_STEPS) : []
  trace('host-diag', { id, steps: steps.length, reason: data.reason })
  // outside React (no Lingui provider here): pick the page language
  const zh = document.documentElement.lang.startsWith('zh')
  const reloadOnly = steps.length === 1 && steps[0].do === 'reload'
  // a release reloading the page says so after the reload, on the new page
  // (pwa-boot.tsx): a toast here vanished with the reload half-read
  if (!reloadOnly)
    toast(
      steps.length
        ? zh
          ? `电脑正在复现问题并读取诊断（${steps.length} 步）`
          : `The host is reproducing a problem and reading diagnostics (${steps.length} steps)`
        : zh
          ? '电脑读取了这台设备的诊断信息'
          : 'The host read this device’s diagnostics',
      { id: 'host-diag', duration: 4000 },
    )
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
      hostRequest: { id, reason: data.reason, steps: results },
    }),
  )
  const total = Math.max(1, Math.ceil(json.length / CHUNK))
  for (let seq = 0; seq < total; seq++)
    await remoteLink.rpc('diag.submit', {
      id,
      client: pageId(),
      seq,
      total,
      data: json.slice(seq * CHUNK, (seq + 1) * CHUNK),
    })
  // `reload` step (`wezdeck-wsl diag --reload`): the host just shipped and
  // wants this phone on the new build without anyone tapping 刷新 — the
  // snapshot above still reports the build it ran
  if (steps.some((step) => step.do === 'reload')) reloadWhenIdle()
}

export const UPDATED_KEY = 'wezdeck.updated-from'

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
 * are kept anyway). The new page then says 已更新到新版本 once.
 */
function reloadWhenIdle() {
  const go = () => {
    try {
      sessionStorage.setItem(UPDATED_KEY, buildId)
    } catch {
      // storage blocked: the reload still happens, just unannounced
    }
    trace('host-reload', { deferred: Date.now() - asked })
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
  // every page change records its frames: "the animation feels bad" shows up
  // in the next pulled snapshot without a reproduction
  router.subscribe('onBeforeNavigate', ({ toLocation, fromLocation }) => {
    const from = fromLocation?.pathname
    void sampleFrames(700).then((frames) =>
      trace('nav-frames', { from, to: toLocation.pathname, ...frames }),
    )
  })
}
