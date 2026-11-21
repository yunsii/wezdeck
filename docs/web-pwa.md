# Web console as a PWA (phone + desktop)

Status: **phases 1–2 live 2026-11-22** (plus desktop `j`/`k` and `g`+letter); command palette, run sheet and Web Push are next. Remote transport
(WebRTC / WebSocket relay) is [`remote-access.md`](./remote-access.md); this
doc is the app shell, layout and interaction on top of it.

## Prior art

Surveyed fe1 (`~/work/fe1/cloud/apps/team`) and forge
(`~/github/forge/apps/web`), both personal-scale PWAs on Cloudflare:

| Topic | forge | fe1 | wezdeck |
| --- | --- | --- | --- |
| Service worker | hand-written, shell-only, build-id update toast | same; explicitly no API caching | **adopt** both |
| Offline data | TanStack Query persisted to IndexedDB (7 d) | none | **adopt forge**: show last tickets "as of HH:MM" |
| Safe area / touch | `viewport-fit=cover`, `env(safe-area-*)`, 44 px targets, hover only on `(hover: hover)` | missing; ~32 px buttons | adopt forge |
| Phone navigation | bottom tab bar, pushed second-level pages, sheets | header dropdown | adopt forge |
| Desktop | none (phone only) | split list/detail | adopt fe1 split **plus** keyboard (repo stance) |
| Install entry | settings page; iOS / WeChat text guidance | ⚙ menu, same guidance | adopt |
| Notifications | none | Feishu bot | **new: Web Push** |

## Decisions (2026-11-22)

1. **Manifest scope is the whole site** (`id`/`scope` `/`), `start_url`
   `/console`; installed app opens the console, the landing page stays
   reachable in-app.
2. **One route tree, layouts by width**: `<768px` phone, `768–1279px` tablet
   (split, collapsible list), `≥1280px` desktop. Fixes today's gap at
   900–1023 px (neither `max-[899px]` nor `lg:` applies).
3. **Capability-aware navigation**: loopback Runtime → every section; remote
   link only → collab sections only (no "Runtime offline" pages).
4. **Phone IA — four bottom tabs**: 待处理 (waiting on me + failed, badge
   count) · 工单 (all, filter + search) · 动态 (event timeline) · 我的
   (connection, pairing, install, theme, language). Ticket detail is a pushed
   page; a run opens in a bottom sheet (transcript, prompt). Connection chip
   in the top bar opens a sheet (mode, path, RTT, last direct failure, host
   since, mic grant). Re-tap active tab = scroll top + refresh; sheets swipe
   down / Android back closes. No pull-to-refresh (neither reference has it).
5. **Desktop keyboard**: `j`/`k` move, `Enter` open, `Esc` back, `/` filter,
   `g`+letter section jump, `Ctrl+K` command palette; one registry, hints in
   the UI.
6. **Writes (reply / close / re-run / new ticket) deferred**; the detail page
   reserves a bottom action bar for them.
7. **Notifications: Web Push** for "waiting on you" / "failed" plus
   `setAppBadge` count; subscription stored in the HostRelay DO, pushed when
   the host relays the event. iOS needs 16.4+ and an installed app.

## PWA plumbing (phase 1)

- `public/manifest.webmanifest`: standalone, theme colors per scheme, icons
  192 / 512 / maskable generated from `brand-icon.svg`.
- `public/sw.js` (hand-written, registered as `/sw.js?v=<build>` in
  production only): navigations network-first with the cached console shell
  as offline fallback; hashed `/assets/*` cache-first across the current and
  previous build; `/relay/*`, `/api/*`, non-GET and `no-store` bypass. Pages
  are SSR (TanStack Start), so the fallback is a cached `/console` document.
- Update: compare build id on `visibilitychange` (≤ every 10 min) → toast
  "有新版本 · 刷新"; one reload on chunk preload error.
- Query cache persisted to IndexedDB (7 d, buster = contract hash); stale
  banner "主机离线 · 数据截至 HH:MM".
- `viewport-fit=cover`, safe-area padding, 44 px targets on coarse pointers.

## As built (2026-11-22)

| Piece | Code |
| --- | --- |
| Manifest, icons (rendered from `brand-icon.svg`) | `web/public/manifest.webmanifest`, `web/public/icons/` |
| Service worker | `web/public/sw.js` (shell `/console`, `/console/inbox`; per-path navigation cache) |
| Build id, precache list | `pwaBuildInfo` in `web/vite.config.ts` → `dist/client/build.json`, `precache.json` |
| Registration, update toast, install state | `web/src/lib/pwa.ts`, `web/src/features/pwa-boot.tsx` |
| Persisted query cache (collab reads only) | `web/src/lib/query-provider.tsx`; keep-last-good reads `web/src/lib/collab-query.ts` |
| Shell: sidebar / phone top bar + tabs, `g`+letter, `/` | `web/src/features/console-shell.tsx`; mode `console-mode.ts` |
| Inbox / tickets (split vs pushed detail) | `web/src/features/tickets-view.tsx`, `console-collab.tsx` |
| Activity, Settings | `console-activity.tsx`, `console-me.tsx` |
| Acceptance | `web/tests/pwa.cdp.test.ts` (`WEZDECK_PWA_PROD=1` adds worker + offline) |

Deviations from the plan: the run detail stays inline on the pushed ticket
page (no sheet yet); jump keys are `g o/d/x/i/c/a/m`; `?remote=1` is sticky
per tab (sessionStorage) so in-app navigation keeps the remote path.

## Observability

- Remote link reports mode changes (`mode`, `path`, `rtt`, `same_public`) as a
  frame the host logs (`category=relay event=client_mode`).
- Worker logs `sw_update_offered`, `install`, `push_subscribed`,
  `push_sent` rows.

## Phases and verification

| Phase | Scope | Verified by |
| --- | --- | --- |
| 1 PWA shell | manifest + icons, SW, update toast, safe area, install entry, persisted cache, capability-aware nav, breakpoint fix | installability check in Chrome; offline reopen shows "as of" in headless CDP; real phone install |
| 2 Phone shell | bottom tabs, inbox, pushed detail, run sheet, connection sheet | CDP at 390×844 with touch emulation |
| 3 Desktop keyboard | list keys, command palette, hints | keyboard-only CDP flows |
| 4 Writes | deferred (decision 6) | — |
| 5 Push | Web Push + app badge | real phone notification opens the ticket |
