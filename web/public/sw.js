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
// - other same-origin files (icons, manifest): stale-while-revalidate.
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev'
const PREFIX = 'wezdeck-'
const CACHE = `${PREFIX}${VERSION}`
const SHELL = ['/console/now', '/console/collab', '/console/sessions']
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
      const old = (await caches.keys()).filter((key) => key !== CACHE)
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
          if (res.ok && url.pathname.startsWith('/console')) {
            const copy = res.clone()
            event.waitUntil(
              caches.open(CACHE).then((c) => c.put(url.pathname, copy)),
            )
          }
          return res
        } catch {
          return (
            (await caches.match(url.pathname)) ??
            (await caches.match('/console/now')) ??
            Response.error()
          )
        }
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
