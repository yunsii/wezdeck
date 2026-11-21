// PWA client side: service-worker registration, "new version" check, and the
// install entry. Same shape as forge / fe1 (docs/web-pwa.md).
import { useSyncExternalStore } from 'react'

type InstallPrompt = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPrompt | null = null
let update: { buildId: string } | null = null
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

/** Compare the deployed build with ours; "new" once the new worker has the code. */
export async function checkForUpdate(): Promise<'latest' | 'offline' | 'new'> {
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
  update = { buildId: latest.buildId }
  emit()
  return 'new'
}

/** Production only: dev HMR and a caching worker fight each other. */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  navigator.serviceWorker
    .register(`/sw.js?v=${__BUILD_ID__}`)
    .catch(() => undefined)
  // Installed apps stay open for days: check when brought back (≤ 10 min).
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
