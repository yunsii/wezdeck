// Background-only local notification handler for WS-delivered `push.notify`
// frames (FCM-free fallback for browsers / networks that cannot reach Google
// Push Service). Only pops a banner while the page is backgrounded/hidden
// (unless `force: true` for explicit test notifications); always syncs badge.
import { trace } from './client-trace'

type WsPushFrame = {
  t: 'push.notify'
  force?: boolean
  kind?: string
  title?: string
  body?: string
  tag?: string
  url?: string
  badge?: number
  silent?: boolean
}

function syncAppBadge(badge: unknown) {
  if (typeof badge !== 'number' || typeof navigator === 'undefined') return
  const nav = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  try {
    if (badge > 0 && typeof nav.setAppBadge === 'function') {
      void nav.setAppBadge(badge).catch(() => undefined)
    } else if (badge === 0 && typeof nav.clearAppBadge === 'function') {
      void nav.clearAppBadge().catch(() => undefined)
    }
  } catch {
    // badge API unsupported on this platform
  }
  // Cross-device read sync: clear stale notifications when pending count hits 0.
  if (badge === 0 && 'serviceWorker' in navigator) {
    void navigator.serviceWorker.ready
      .then((reg) => reg.getNotifications())
      .then((list) => {
        for (const n of list) {
          if (n.tag !== 'wezdeck:test') n.close()
        }
      })
      .catch(() => undefined)
  }
}

export function shouldPopWsNotification(
  frame: { force?: boolean; silent?: boolean },
  visibilityState: string,
): boolean {
  if (frame.force === true) return true
  if (frame.silent === true) return false
  return visibilityState !== 'visible'
}

export function handleWsPushNotify(raw: Record<string, unknown>) {
  if (typeof window === 'undefined') return
  const frame = raw as WsPushFrame
  syncAppBadge(frame.badge)

  if (!shouldPopWsNotification(frame, document.visibilityState)) {
    return
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return
  }

  const title = String(frame.title || 'WezDeck')
  const options: NotificationOptions = {
    body: String(frame.body || ''),
    tag: String(frame.tag || 'wezdeck'),
    icon: '/brand-icon.svg',
    badge: '/brand-icon.svg',
    data: { url: String(frame.url || '/console/sessions') },
  }

  trace('push-ws-notify', {
    kind: frame.kind ?? 'unknown',
    force: Boolean(frame.force),
  })

  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(title, options))
      .catch(() => {
        try {
          new Notification(title, options)
        } catch {
          // ignore browser notification refusal
        }
      })
    return
  }
  try {
    new Notification(title, options)
  } catch {
    // ignore browser notification refusal
  }
}
