// What this page saw lately, for diagnostics the host pulls (lib/host-diag.ts,
// `wezdeck-wsl diag`): a ring buffer of viewport / keyboard changes, focus, scroll
// pinning, visibility, link mode and errors, plus a snapshot of the device
// and page. It never holds tokens or message text (the URL hash, which can
// carry the pairing token, is dropped).
import { buildId } from '#/lib/pwa'
import { remoteLink } from '#/lib/remote-link'

type TraceEvent = { t: number; kind: string; data?: Record<string, unknown> }

const MAX_EVENTS = 300
const events: Array<TraceEvent> = []

/** page state for the snapshot (the session page registers its own) */
let pageState: () => Record<string, unknown> = () => ({})
export function setDiagnosticsPage(fn: () => Record<string, unknown>) {
  pageState = fn
  return () => {
    if (pageState === fn) pageState = () => ({})
  }
}

/**
 * Frame timing for `ms` from now (rAF): how many frames, the longest gap, how
 * many gaps over 50 ms — the evidence for "the animation feels bad".
 */
export function sampleFrames(ms: number): Promise<Record<string, number>> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'undefined') {
      resolve({})
      return
    }
    const start = performance.now()
    let last = start
    let frames = 0
    let maxGap = 0
    let janks = 0
    const tick = (now: number) => {
      frames++
      const gap = now - last
      maxGap = Math.max(maxGap, gap)
      if (gap > 50) janks++
      last = now
      if (now - start < ms) requestAnimationFrame(tick)
      else
        resolve({
          ms: Math.round(now - start),
          frames,
          fps: Math.round((frames * 1000) / Math.max(1, now - start)),
          maxGapMs: Math.round(maxGap),
          janks,
        })
    }
    requestAnimationFrame(tick)
  })
}

export function trace(kind: string, data?: Record<string, unknown>) {
  if (typeof performance === 'undefined') return
  events.push({ t: Math.round(performance.now()), kind, data })
  if (events.length > MAX_EVENTS) events.shift()
}

function viewport() {
  const vv = window.visualViewport
  return {
    inner: [window.innerWidth, window.innerHeight],
    vv: vv
      ? {
          w: Math.round(vv.width),
          h: Math.round(vv.height),
          top: Math.round(vv.offsetTop),
          scale: Number(vv.scale.toFixed(2)),
        }
      : null,
  }
}

/** The page's main scroller (console shell) and where it stands. */
function scroller() {
  const el = document.getElementById('console-main')?.parentElement
  if (!el) return null
  return {
    top: Math.round(el.scrollTop),
    height: el.scrollHeight,
    client: el.clientHeight,
    gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
  }
}

const describe = (target: EventTarget | null) =>
  target instanceof HTMLElement
    ? `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ''}`
    : ''

let installed = false

export function installClientTrace() {
  if (installed || typeof window === 'undefined') return
  installed = true
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (entry.duration >= 80)
          trace('longtask', { ms: Math.round(entry.duration) })
    }).observe({ type: 'longtask', buffered: false })
  } catch {
    // not supported (Firefox, Safari): frame sampling still covers jank
  }
  const vv = window.visualViewport
  let lastTop = -1
  let settled: ReturnType<typeof setTimeout> | undefined
  const onViewport = (source: string) => () => {
    if (source === 'vv-scroll') {
      const top = Math.round(vv?.offsetTop ?? 0)
      if (top === lastTop) return
      lastTop = top
    }
    trace('viewport', { source, ...viewport(), scroller: scroller() })
    // where things ended up once the page has reacted (keyboard follow etc.)
    if (source !== 'vv-scroll') {
      clearTimeout(settled)
      settled = setTimeout(() => {
        trace('viewport-settled', { ...viewport(), scroller: scroller() })
      }, 700)
    }
  }
  window.addEventListener('resize', onViewport('window'))
  vv?.addEventListener('resize', onViewport('vv'))
  vv?.addEventListener('scroll', onViewport('vv-scroll'))
  document.addEventListener('visibilitychange', () => {
    trace('visibility', { state: document.visibilityState })
  })
  document.addEventListener('focusin', (event) => {
    trace('focus', { el: describe(event.target) })
  })
  document.addEventListener('focusout', (event) => {
    trace('blur', { el: describe(event.target) })
  })
  window.addEventListener('error', (event) => {
    trace('error', {
      message: String(event.message).slice(0, 300),
      at: `${event.filename}:${event.lineno}`,
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason as { message?: string } | undefined
    trace('rejection', {
      message: String(reason?.message ?? reason).slice(0, 300),
    })
  })
  let mode = ''
  remoteLink.subscribe(() => {
    const state = remoteLink.snapshot()
    if (state.mode === mode) return
    mode = state.mode
    trace('link', { mode, path: state.path, note: state.rtcNote })
  })
  trace('start', viewport())
}

function safeArea() {
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
  document.body.append(probe)
  const style = getComputedStyle(probe)
  const area = {
    top: style.paddingTop,
    right: style.paddingRight,
    bottom: style.paddingBottom,
    left: style.paddingLeft,
  }
  probe.remove()
  return area
}

/** Everything the agent needs to see what the phone saw; `extra` is page state. */
export function diagnosticsSnapshot(extra: Record<string, unknown> = {}) {
  const nav = navigator as Navigator & {
    deviceMemory?: number
    connection?: { effectiveType?: string; downlink?: number }
  }
  const link = remoteLink.snapshot()
  const now = Math.round(performance.now())
  return {
    at: new Date().toISOString(),
    build: buildId,
    page: location.pathname + location.search,
    userAgent: navigator.userAgent,
    language: navigator.language,
    standalone: matchMedia('(display-mode: standalone)').matches,
    screen: [screen.width, screen.height],
    devicePixelRatio: window.devicePixelRatio,
    viewport: viewport(),
    viewportMeta: document.querySelector<HTMLMetaElement>('meta[name=viewport]')
      ?.content,
    safeArea: safeArea(),
    scroller: scroller(),
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light',
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    online: navigator.onLine,
    serviceWorker: Boolean(navigator.serviceWorker.controller),
    deviceMemory: nav.deviceMemory,
    connection: nav.connection?.effectiveType,
    history: {
      index: (history.state as { __TSR_index?: number } | null)?.__TSR_index,
      length: history.length,
    },
    viewTransition: {
      api: 'startViewTransition' in document,
      types:
        typeof CSS !== 'undefined' &&
        CSS.supports('selector(:active-view-transition-type(a))'),
    },
    link: {
      mode: link.mode,
      path: link.path,
      rttMs: link.rttMs,
      samePublic: link.samePublic,
      rtcNote: link.rtcNote,
    },
    ...pageState(),
    ...extra,
    // t is ms before this snapshot, newest last
    events: events.map((event) => ({ ...event, t: event.t - now })),
  }
}
