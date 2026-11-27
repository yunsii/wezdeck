// PWA client side: service-worker registration, "new version" check,
// non-disruptive update notifications with safe-idle reload, and install entry.
// Same shape as forge / fe1 (docs/web-pwa.md).
import { useSyncExternalStore } from 'react'

import { trace } from '#/lib/client-trace'

type InstallPrompt = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export const UPDATED_KEY = 'wezdeck.updated-from'
/** Why the host asked for an update (`--reason`); shown after the new page loads. */
export const UPDATED_REASON_KEY = 'wezdeck.updated-reason'

const IDLE_RELOAD_MS = 45_000
const HIDDEN_RETURN_RELOAD_MS = 15_000

let deferred: InstallPrompt | null = null
let update: { buildId: string; reason?: string } | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// beforeinstallprompt can fire before React mounts: listen at module load.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferred = event as InstallPrompt
    emit()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    emit()
  })
}

const standalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true
// iPadOS reports a Mac UA; touch points tell them apart.
const ios = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const inApp = () => /MicroMessenger|Lark|Feishu/i.test(navigator.userAgent)

export type InstallState =
  'installed' | 'prompt' | 'ios' | 'in-app' | 'unavailable'

function installState(): InstallState {
  if (standalone()) return 'installed'
  if (inApp()) return 'in-app'
  if (deferred) return 'prompt'
  return ios() ? 'ios' : 'unavailable'
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribe, installState, () => 'unavailable')
}

export async function promptInstall() {
  const event = deferred
  if (!event) return
  deferred = null
  emit()
  await event.prompt()
}

export function useUpdateAvailable() {
  return useSyncExternalStore(
    subscribe,
    () => update,
    () => null,
  )
}

export const buildId = __BUILD_ID__

/** Reload onto the newly deployed build while announcing the reason once loaded. */
export function reloadToUpdate(reason = '') {
  try {
    sessionStorage.setItem(UPDATED_KEY, buildId)
    if (reason) sessionStorage.setItem(UPDATED_REASON_KEY, reason)
    else sessionStorage.removeItem(UPDATED_REASON_KEY)
  } catch {
    // storage blocked: the reload still happens, just unannounced
  }
  trace('host-reload', { reason, mode: 'safe-update' })
  location.reload()
}

/**
 * Strict safety predicate for silent auto-reload: returns false whenever the
 * user is typing, has an unsent draft focused, has a modal/sheet open, has an
 * active permission/elicitation/plan card, or has a message currently sending.
 */
export function isSafeToAutoReload(doc: Document = document): boolean {
  const active = doc.activeElement
  if (active) {
    const tag = active.tagName
    if (
      tag === 'TEXTAREA' ||
      tag === 'INPUT' ||
      active.getAttribute('contenteditable') === 'true'
    ) {
      return false
    }
  }
  for (const el of doc.querySelectorAll(
    'textarea, input[type="text"], input:not([type])',
  )) {
    const val = (el as HTMLInputElement | HTMLTextAreaElement).value
    if (val.trim().length > 0) return false
  }
  if (doc.querySelector('[role="dialog"], [data-pending="sending"]')) {
    return false
  }
  if (
    doc.querySelector(
      '[data-testid="permission-card"], [data-testid="elicitation-card"], [data-testid="plan-card"]',
    )
  ) {
    return false
  }
  return true
}

let idleWatcherInstalled = false
let pendingReloadReason = ''

/**
 * Wait for a genuinely safe idle window (45 s without interaction, or returning
 * after >= 15 s in the background) before silently reloading onto the new build.
 * Active users keep working uninterrupted and can click the sticky toast anytime.
 */
export function scheduleSafeIdleReload(reason = '') {
  if (typeof window === 'undefined') return
  pendingReloadReason = reason
  if (idleWatcherInstalled) return
  idleWatcherInstalled = true

  let lastActivity = Date.now()
  let hiddenAt: number | null = null
  const bump = () => {
    lastActivity = Date.now()
  }
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'input']) {
    window.addEventListener(ev, bump, { passive: true, capture: true })
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now()
      return
    }
    if (
      hiddenAt !== null &&
      Date.now() - hiddenAt >= HIDDEN_RETURN_RELOAD_MS &&
      update &&
      isSafeToAutoReload()
    ) {
      reloadToUpdate(pendingReloadReason)
      return
    }
    hiddenAt = null
    lastActivity = Date.now()
  })
  window.setInterval(() => {
    if (!update || document.visibilityState !== 'visible') return
    if (Date.now() - lastActivity < IDLE_RELOAD_MS) return
    if (isSafeToAutoReload()) {
      reloadToUpdate(pendingReloadReason)
    }
  }, 10_000)
}

/** Compare the deployed build with ours; "new" once the new worker has the code. */
export async function checkForUpdate(
  reason?: string,
): Promise<'latest' | 'offline' | 'new'> {
  let latest: { buildId?: string }
  try {
    latest = (await (
      await fetch('/build.json', { cache: 'no-store' })
    ).json()) as typeof latest
  } catch {
    return 'offline'
  }
  if (!latest.buildId || latest.buildId === __BUILD_ID__) return 'latest'
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register(`/sw.js?v=${latest.buildId}`)
    } catch {
      // private mode: the reload still fetches from the network
    }
  }
  update = {
    buildId: latest.buildId,
    reason: reason || update?.reason,
  }
  emit()
  return 'new'
}

/** Called when the host announces a new build (`diag --notify-update`). */
export async function notifyUpdateAvailable(reason = '') {
  const status = await checkForUpdate(reason)
  if (status === 'new') {
    scheduleSafeIdleReload(reason)
  }
  return status
}

/** Production only: dev HMR and a caching worker fight each other. */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  navigator.serviceWorker
    .register(`/sw.js?v=${__BUILD_ID__}`)
    .catch(() => undefined)
  // Installed apps stay open for days: check when brought back (<= 10 min).
  let last = Date.now()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || Date.now() - last < 600_000)
      return
    last = Date.now()
    void checkForUpdate()
  })
  // A chunk from a build that is gone: reload once per build.
  window.addEventListener('vite:preloadError', () => {
    const key = `wezdeck.reloaded.${__BUILD_ID__}`
    try {
      if (sessionStorage.getItem(key)) return
      sessionStorage.setItem(key, '1')
    } catch {
      return
    }
    location.reload()
  })
}
