// Diagnostics the host pulls (`wezdeck-wsl diag`, native relay_diag.go): the
// relay pushes {t:"diag.request", id, data:{reason, steps}}; this page may
// first drive its own UI through `steps` to reproduce a problem while
// recording frame timing, then answers with the client-trace snapshot as
// `diag.submit` chunks. A toast says the host read diagnostics.
//
// Steps (allowlisted; anything else is reported as skipped):
//   {do:"navigate", to:"/zh/console/now"}  in-app path only
//   {do:"back"}
//   {do:"click", text?:"会话", selector?:"[data-session=…]"}
//       never a write control: nothing inside a <form> or [data-write]
//   {do:"scroll", to:"top"|"bottom"|number}
//   {do:"wait", ms:800}                    ≤ 10 s
// Each step records its result and the frames of the next `sample` ms
// (default 700).
import type { AnyRouter } from '@tanstack/react-router'
import { toast } from 'sonner'

import { diagnosticsSnapshot, sampleFrames, trace } from '#/lib/client-trace'
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
let phoneId = ''
const phone = () =>
  (phoneId ||= Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
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
  const candidates = document.querySelectorAll<HTMLElement>(
    'a, button, summary, [role=button], [role=tab]',
  )
  for (const el of candidates)
    if (el.offsetParent !== null && el.textContent.trim().includes(step.text))
      return el
  return null
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
  toast(
    steps.length
      ? zh
        ? `电脑正在复现问题并读取诊断（${steps.length} 步）`
        : `The host is reproducing a problem and reading diagnostics (${steps.length} steps)`
      : zh
        ? '电脑读取了这台手机的诊断信息'
        : 'The host read this phone’s diagnostics',
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
      phone: phone(),
      seq,
      total,
      data: json.slice(seq * CHUNK, (seq + 1) * CHUNK),
    })
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
