// What this page saw lately, for diagnostics the host pulls (lib/host-diag.ts,
// `wezdeck-wsl diag`): a ring buffer of viewport / keyboard changes, focus, scroll
// pinning, visibility, link mode and errors, plus a snapshot of the device
// and page. It never holds tokens or message text (the URL hash, which can
// carry the pairing token, is dropped).
import { buildId } from '#/lib/pwa'
import { remoteLink } from '#/lib/remote-link'
import { installLocalEvents, recordLocalEvent } from '#/lib/local-events'

type TraceEvent = { t: number; kind: string; data?: Record<string, unknown> }

const MAX_EVENTS = 300
const events: Array<TraceEvent> = []

// React's recoverable hydration errors (#418 …) only reach console.error, and
// they happen before any effect runs: wrap it when this module loads (client
// only — the SSR bundle has no window)
if (typeof window !== 'undefined') {
  const consoleError = console.error.bind(console)
  let consoleErrors = 0
  console.error = (...args: Array<unknown>) => {
    if (consoleErrors++ < 20)
      trace('console-error', {
        message: args
          .map((a) => (a instanceof Error ? a.message : String(a)))
          .join(' ')
          .slice(0, 300),
      })
    consoleError(...args)
  }
}

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
  recordLocalEvent(kind, data)
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

/** The active content scroller (wide split pane or main console column). */
function scroller() {
  const el =
    document.querySelector<HTMLElement>('.vt-split-pane.overflow-y-auto') ??
    document.getElementById('console-main')?.parentElement
  if (!el) return null
  return {
    top: Math.round(el.scrollTop),
    height: el.scrollHeight,
    client: el.clientHeight,
    gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
  }
}

/** Wide split-list scroller (OverlayScrollbars viewport or overflow fallback) + rect. */
export function listScroller() {
  const aside = document.querySelector<HTMLElement>('.vt-split-list')
  if (!aside) return null
  const vp = aside.querySelector<HTMLElement>(
    '[data-overlayscrollbars-viewport], .overflow-y-auto',
  )
  const r = aside.getBoundingClientRect()
  const round2 = (n: number) => Math.round(n * 100) / 100
  return {
    rect: {
      x: round2(r.x),
      y: round2(r.y),
      w: round2(r.width),
      h: round2(r.height),
    },
    rows: aside.querySelectorAll('[data-session], [data-ticket], [data-me]')
      .length,
    vp: vp
      ? {
          top: Math.round(vp.scrollTop),
          height: vp.scrollHeight,
          client: vp.clientHeight,
          gap: Math.round(vp.scrollHeight - vp.scrollTop - vp.clientHeight),
        }
      : null,
  }
}

type LayoutShiftSourceLike = {
  node?: Node | null
  previousRect?: DOMRectReadOnly
  currentRect?: DOMRectReadOnly
}

type LayoutShiftEntryLike = PerformanceEntry & {
  value: number
  hadRecentInput: boolean
  sources?: Array<LayoutShiftSourceLike>
}

function describeNode(node: Node | null | undefined): Record<string, unknown> {
  if (!(node instanceof HTMLElement)) return { node: 'other' }
  const row = node.closest<HTMLElement>(
    '[data-session], [data-ticket], [data-me], [data-testid]',
  )
  return {
    tag: node.tagName.toLowerCase(),
    id:
      row?.dataset.session ??
      row?.dataset.ticket ??
      row?.dataset.me ??
      row?.dataset.testid ??
      node.id,
    inSplitList: Boolean(node.closest('.vt-split-list')),
  }
}

const describe = (target: EventTarget | null) =>
  target instanceof HTMLElement
    ? `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ''}`
    : ''

let installed = false

/**
 * The console shell's geometry: where the bottom tab bar sits, how tall the
 * shell is against the viewport and what `100dvh` measures — for "the tab bar
 * vanished after an update reload".
 */
export function shellMetrics(): Record<string, unknown> {
  const rect = (el: Element | null) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      h: Math.round(r.height),
    }
  }
  const bar = document.querySelector('nav.tabbar-vt')
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;top:0;height:100dvh;width:0;visibility:hidden'
  document.body.append(probe)
  const dvh = Math.round(probe.getBoundingClientRect().height)
  probe.remove()
  const vv = window.visualViewport
  return {
    path: location.pathname,
    tabbar: bar
      ? { ...rect(bar), display: getComputedStyle(bar).display }
      : null,
    shell: rect(document.querySelector('main[data-deck]')),
    innerHeight: window.innerHeight,
    dvh,
    vv: vv ? { h: Math.round(vv.height), top: Math.round(vv.offsetTop) } : null,
    scrollY: Math.round(window.scrollY),
    docHeight: document.documentElement.scrollHeight,
  }
}

const PREVIOUS_KEY = 'wezdeck-trace-previous'
// read once at boot, before this document saves its own events under the key
let previousDoc: unknown = null
function previousDocument() {
  return previousDoc
}

const routerIndex = () =>
  (history.state as { __TSR_index?: number } | null)?.__TSR_index

export function installClientTrace() {
  if (installed || typeof window === 'undefined') return
  installed = true
  installLocalEvents()
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (entry.duration >= 80)
          trace('longtask', { ms: Math.round(entry.duration) })
    }).observe({ type: 'longtask', buffered: false })
  } catch {
    // not supported (Firefox, Safari): frame sampling still covers jank
  }
  try {
    let lastShiftAt = 0
    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const entry = raw as LayoutShiftEntryLike
        if (entry.hadRecentInput || entry.value < 0.001) continue
        const now = performance.now()
        if (now - lastShiftAt < 250) continue
        lastShiftAt = now
        const sources = (entry.sources ?? []).slice(0, 3).map((src) => ({
          ...describeNode(src.node),
          dy:
            src.previousRect && src.currentRect
              ? Math.round((src.currentRect.y - src.previousRect.y) * 10) / 10
              : 0,
          dh:
            src.previousRect && src.currentRect
              ? Math.round(
                  (src.currentRect.height - src.previousRect.height) * 10,
                ) / 10
              : 0,
        }))
        trace('layout-shift', {
          value: Math.round(entry.value * 10_000) / 10_000,
          sources,
        })
      }
    }).observe({ type: 'layout-shift', buffered: false })
  } catch {
    // not supported in Firefox / Safari
  }
  // how this page came to be (the "one empty entry before the app" question):
  // the URL it loaded with (no hash: it can carry the pairing token), how
  // (navigate / reload / back_forward), and the history it found
  const entry = performance.getEntriesByType('navigation').at(0) as
    PerformanceNavigationTiming | undefined
  const loaded = entry ? new URL(entry.name) : null
  trace('boot', {
    url: loaded ? loaded.pathname + loaded.search : null,
    type: entry?.type,
    length: history.length,
    index: routerIndex(),
    referrer: document.referrer ? new URL(document.referrer).pathname : '',
  })
  // every back / forward: where it landed and whether the router owns that
  // entry (no __TSR_index = an entry the app never wrote)
  window.addEventListener('popstate', () => {
    trace('popstate', {
      path: location.pathname + location.search,
      index: routerIndex(),
      routerEntry: routerIndex() !== undefined,
      length: history.length,
    })
    persist('popstate')
    // what the page actually shows half a second later ("empty content"?)
    setTimeout(() => {
      const main = document.getElementById('console-main')
      trace('after-back', {
        path: location.pathname,
        main: main ? main.childElementCount : -1,
        text: (main?.innerText ?? document.body.innerText).trim().length,
        visibility: document.visibilityState,
      })
      persist('after-back')
    }, 500)
  })
  // keep the last events past this document — a reload, or the app being
  // closed by a back press (localStorage: sessionStorage dies with the
  // window): the next snapshot carries them as `previous`
  const persist = (why: string) => {
    try {
      localStorage.setItem(
        PREVIOUS_KEY,
        JSON.stringify({
          at: new Date().toISOString(),
          why,
          path: location.pathname,
          events: events.slice(-60),
        }),
      )
    } catch {
      // storage blocked: the snapshot just lacks `previous`
    }
  }
  window.addEventListener('pagehide', () => persist('pagehide'))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persist('hidden')
  })
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) trace('pageshow-bfcache', { path: location.pathname })
  })
  try {
    previousDoc = JSON.parse(localStorage.getItem(PREVIOUS_KEY) ?? 'null')
  } catch {
    previousDoc = null
  }
  setTimeout(() => trace('shell', shellMetrics()), 2000)
  let shellTimer: ReturnType<typeof setTimeout> | undefined
  window.addEventListener('resize', () => {
    clearTimeout(shellTimer)
    shellTimer = setTimeout(() => trace('shell', shellMetrics()), 700)
  })
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

const snippet = (el: Element) =>
  el.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)

/**
 * The conversation as drawn (chat-thread.tsx marks every item with
 * data-msg / data-role and the reveal cursor): compared with the host
 * transcript and the page's loaded messages (`chat.loadedUsers`), it tells
 * a message the page never got from one it got but did not draw.
 */
function renderedChat() {
  const marker = document.querySelector<HTMLElement>('[data-chat-reveal]')
  if (!marker) return undefined
  const items = [...document.querySelectorAll<HTMLElement>('[data-msg]')]
  return {
    reveal: Number(marker.dataset.chatReveal),
    end: Number(marker.dataset.chatEnd),
    count: items.length,
    first: items.length ? Number(items[0].dataset.msg) : -1,
    users: items
      .filter((el) => el.dataset.role === 'user')
      .map((el) => Number(el.dataset.msg)),
    tail: items.slice(-40).map((el) => ({
      at: Number(el.dataset.msg),
      role: el.dataset.role,
      text: snippet(el),
    })),
    pending: [...document.querySelectorAll<HTMLElement>('[data-pending]')].map(
      (el) => ({ state: el.dataset.pending, text: snippet(el) }),
    ),
  }
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
    listScroller: listScroller(),
    renderedChat: renderedChat(),
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
    // the last events of the previous document in this tab (pagehide)
    previous: previousDocument(),
    // t is ms before this snapshot, newest last
    events: events.map((event) => ({ ...event, t: event.t - now })),
  }
}
