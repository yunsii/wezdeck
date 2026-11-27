// Service worker: cache the app shell and code so the installed app opens
// without network; data comes from the persisted TanStack Query cache
// (src/lib/query-provider.tsx), never from here. Adapted from forge / fe1
// (docs/web-pwa.md). Registered from src/lib/pwa.tsx as /sw.js?v=<build>, so
// each deploy installs a new worker that takes over immediately; the
// "new version" toast compares build ids separately.
//
// Rules:
// - /relay/*, /api/*, non-GET, cross-origin and cache:"no-store" requests are
//   not touched (live data, update checks);
// - navigations: network first (pages are SSR); on failure the cached copy of
//   the same path, else the cached console shell;
// - /assets/*: content-hashed, cache first across the current and previous
//   build (ignoreVary), never caching an HTML fallback as a chunk;
// - fonts (/assets/*.woff2): cache first in their own cache that outlives
//   builds — the files are content-hashed and almost never change, and the
//   CJK font is ~100 slices a page fetches only as its characters need;
// - other same-origin files (icons, manifest): stale-while-revalidate.
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev'
const PREFIX = 'wezdeck-'
const CACHE = `${PREFIX}${VERSION}`
const FONTS = `${PREFIX}fonts`
const SHELL = ['/console/sessions', '/console/collab']
const CONCURRENCY = 4

const isAsset = (res) =>
  res.ok && !(res.headers.get('content-type') || '').includes('text/html')

async function copyOrFetch(cache, url) {
  const hit = await caches.match(url, { ignoreVary: true })
  if (hit && isAsset(hit)) return cache.put(url, hit)
  const res = await fetch(url)
  if (!isAsset(res)) throw new Error(`${url} ${res.status}`)
  await cache.put(url, res)
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      const entry = new Set()
      for (const path of SHELL) {
        const res = await fetch(path, { cache: 'no-cache' })
        const html = await res.clone().text()
        await cache.put(path, res)
        for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g))
          entry.add(m[1])
      }
      await Promise.all([...entry].map((url) => copyOrFetch(cache, url)))
      await cache.addAll(['/brand-icon.svg', '/manifest.webmanifest'])
      let assets = []
      try {
        const res = await fetch('/precache.json', { cache: 'no-cache' })
        if (res.ok) ({ assets = [] } = await res.json())
      } catch {
        // offline / old deploy: chunks get cached on first use
      }
      const queue = assets.filter((url) => !entry.has(url))
      const worker = async () => {
        while (queue.length) {
          try {
            await copyOrFetch(cache, queue.shift())
          } catch {
            // cached on first use instead
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const old = (await caches.keys()).filter(
        (key) => key !== CACHE && key !== FONTS,
      )
      const keep = old.filter((key) => key.startsWith(PREFIX)).at(-1)
      for (const key of old) if (key !== keep) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (
    request.method !== 'GET' ||
    request.cache === 'no-store' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/relay/') ||
    url.pathname.startsWith('/api/')
  )
    return

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(request)
          if (res.ok && /^(\/zh)?\/console(\/|$)/.test(url.pathname)) {
            const copy = res.clone()
            event.waitUntil(
              caches.open(CACHE).then((c) => c.put(url.pathname, copy)),
            )
          }
          return res
        } catch {
          return (
            (await caches.match(url.pathname)) ??
            (await caches.match('/console/sessions')) ??
            Response.error()
          )
        }
      })(),
    )
    return
  }

  if (url.pathname.startsWith('/assets/') && url.pathname.endsWith('.woff2')) {
    event.respondWith(
      (async () => {
        const fonts = await caches.open(FONTS)
        const hit = await fonts.match(request)
        if (hit) return hit
        const res = await fetch(request)
        if (isAsset(res)) event.waitUntil(fonts.put(request, res.clone()))
        return res
      })(),
    )
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const hit = await caches.match(request, { ignoreVary: true })
        if (hit && isAsset(hit)) return hit
        const res = await fetch(request)
        if (isAsset(res)) {
          const copy = res.clone()
          event.waitUntil(caches.open(CACHE).then((c) => c.put(request, copy)))
        }
        return res
      })(),
    )
    return
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const hit = await cache.match(request)
      const update = fetch(request).then((res) => {
        if (res.ok) cache.put(request, res.clone())
        return res
      })
      if (hit) {
        event.waitUntil(update.catch(() => undefined))
        return hit
      }
      return update
    })(),
  )
})

// Unified Web Push (sessions + collab tickets): shows low-noise notifications
// without leaking source code or prompts, syncs App Badge, and deep-links on click.
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data = {}
      try {
        data = event.data ? event.data.json() : {}
      } catch {
        data = { title: 'WezDeck', body: event.data ? event.data.text() : '' }
      }
      if (typeof data.badge === 'number') {
        try {
          if (data.badge > 0 && 'setAppBadge' in self.navigator) {
            await self.navigator.setAppBadge(data.badge)
          } else if (data.badge === 0 && 'clearAppBadge' in self.navigator) {
            await self.navigator.clearAppBadge()
          }
        } catch {
          // badge API unsupported on this platform
        }
        // Cross-device read sync: when pending count hits 0, clear stale alerts.
        if (data.badge === 0 && self.registration.getNotifications) {
          try {
            const open = await self.registration.getNotifications()
            for (const n of open) {
              if (n.tag !== 'wezdeck:test') n.close()
            }
          } catch {
            // ignore platform refusal
          }
        }
      }
      if (data.silent) return
      const title = String(data.title || 'WezDeck')
      const options = {
        body: String(data.body || ''),
        tag: String(data.tag || 'wezdeck'),
        renotify: true,
        icon: '/brand-icon.svg',
        badge: '/brand-icon.svg',
        data: { url: String(data.url || '/console/sessions') },
      }
      await self.registration.showNotification(title, options)
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const rawUrl =
    (event.notification.data && event.notification.data.url) ||
    '/console/sessions'
  const targetUrl = new URL(rawUrl, self.location.origin).toString()
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      for (const client of list) {
        if (!client.url.startsWith(self.location.origin)) continue
        try {
          await client.focus()
          if ('navigate' in client) await client.navigate(targetUrl)
          return
        } catch {
          // fall through to openWindow
        }
      }
      await self.clients.openWindow(targetUrl)
    })(),
  )
})
