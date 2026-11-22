// What this page saw lately, for "attach diagnostics" in the session
// composer: a ring buffer of viewport / keyboard changes, focus, scroll
// pinning, visibility, link mode and errors, plus a snapshot of the device
// and page. It never holds tokens or message text (the URL hash, which can
// carry the pairing token, is dropped).
import { buildId } from '#/lib/pwa'
import { remoteLink } from '#/lib/remote-link'

type TraceEvent = { t: number; kind: string; data?: Record<string, unknown> }

const MAX_EVENTS = 150
const events: Array<TraceEvent> = []

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
    link: {
      mode: link.mode,
      path: link.path,
      rttMs: link.rttMs,
      samePublic: link.samePublic,
      rtcNote: link.rtcNote,
    },
    ...extra,
    // t is ms before this snapshot, newest last
    events: events.map((event) => ({ ...event, t: event.t - now })),
  }
}
