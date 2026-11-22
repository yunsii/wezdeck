# Web console as a PWA (phone + desktop)

Status: **live 2026-11-22**: ink theme, WD icon, four phone tabs (现在 / 工单 / 会话 / 我的), sessions with phone writes ([`remote-access.md`](./remote-access.md)). Command palette and Web Push are next. Remote transport
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
4. **Phone IA — four bottom tabs** (revised): 现在 (three bands — needs you
   (tickets + sessions waiting on you), running now, recently active top-5
   by conversation activity including idle, with a link to all sessions;
   工单动态 is one link down: cross-repo ticket events as sentences — one
   card per ticket run of events under its title and from → to repo, day
   headings, a clock time per line; tool calls, checkouts, session init and
   worktree moves left out; sessions are not in it) · 工单 · 会话 (repo →
   worktree → pane tree; primary/secondary when tmux-mounted; path-based
   so ticket worktrees can join later; Grok Ask shows tappable options
   from `elicitation`) · 我的 (connection, phone writing, install, theme,
   language). Ticket detail is a pushed page; a run opens in a bottom
   sheet (transcript, prompt). Connection chip in the top bar opens a
   sheet (mode, path, RTT, last direct failure, host since, mic grant).
   Re-tap active tab = scroll top + refresh; sheets swipe down / Android
   back closes. No pull-to-refresh (neither reference has it).
5. **Desktop keyboard**: `j`/`k` move, `Enter` open, `Esc` back, `/` filter,
   `g`+letter section jump, `Ctrl+K` command palette; one registry, hints in
   the UI.
6. **Writes**: ticket reply (and reply-and-continue) plus session send /
   keys, signed by an approved device key; close / re-run / new ticket still
   deferred.
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
- Query cache persisted to IndexedDB (7 d, buster = contract hash): collab
  reads plus the remote session list and conversations, so a session opens
  from cache at once and new messages stream in after the refresh; a session
  shows 「暂时拿不到最新内容，显示的是 HH:MM 的内容」 above the composer when a
  refresh fails or the device is offline.
- `viewport-fit=cover`, safe-area padding, 44 px targets on coarse pointers.

## Visual language (2026-11-22, revised)

Chosen on the design canvas (icon 1, theme A): the console is **ink on
paper** — no brand color in the interface; the only chroma is the status
lights (● running, ▲ waiting, ✓ shipped, ✕ failed, ○ idle;
`web/src/components/deck/led.tsx`), so whatever is lit needs attention.

- Icon: a **WD monogram** in round-capped strokes on an ink tile
  (`web/public/brand-icon.svg`; the favicon uses heavier strokes for 16 px).
  Repo brand assets (`assets/brand/`, README banner) still use the old deck
  icon.
- Tokens: `[data-deck]` in `web/src/styles.css` (light `#f6f7f9` paper /
  `#ffffff` surface / `#11151c` ink; dark `#14181f` / `#1e232c` / `#f1f3f6`),
  console only. System font (PingFang / Noto Sans SC / Segoe UI), tabular
  numbers.
- Phone patterns: large title that scrolls with the page, grouped inset
  lists, a three-way segmented control on 工单 (进行中 / 等你 / 已结束),
  settings as segmented rows instead of popovers, a translucent bottom bar
  with four tabs (hidden on detail pages, which are full screen).
- Session header (`session-header.tsx`), pinned while the thread scrolls:
  back, session name (+ branch), one status word (full sentence as the
  tooltip), and meters — context, Claude 5 h / 7 d limits with reset time
  ([`remote-access.md` Account limits](remote-access.md#account-limits)),
  background tasks — filled by share, amber from 75 %, red from 90 %;
  tapping them shows model, tokens, cache hit, limit freshness and the
  background task list. Its height is `--session-head`, which the sticky
  prompt sits under.
- Session chat (`chat-thread.tsx`, `chat-markdown.tsx`): replies rendered
  with Vercel's Streamdown (react-markdown replacement that renders
  half-written Markdown); new messages are revealed one at a time and a new
  reply writes itself in phrase-sized batches every 120 ms at ~350 chars/s
  (0.6–3 s), each batch ending at punctuation or a space and fading in by
  opacity alone (Streamdown `animated` fadeIn 650 ms, stagger 6 ms capped at
  260 ms; a per-word blur + lift made the leading edge shimmer), kept
  animating 700 ms after the last batch so the tail never pops; a backlog
  over 8 jumps to the newest; the page stays pinned to the bottom while a reply grows
  (`chat-scroll.ts`: content growth glides — each frame covers a fifth of
  the distance left — while a scroller resize (keyboard) jumps; only a
  finger, wheel or key can unpin it, never the
  page's own scrolling; a finger dragging the history down unpins at once
  and nothing auto-scrolls while a finger is down; back near the bottom
  re-pins; while unpinned a "回到最新 / N 条新消息" button jumps back)
  (tables and code scroll in their own box); messages run full width and
  are told apart by background alone (user: ink `brand-text` with deck text,
  reply: `brand-surface`); runs of tool calls collapse into one line, each call
  expands to its diff / preview / command and result; the newest run while
  the agent works is open, shows its last 3 calls ("N earlier calls" above)
  with a breathing light on the call in flight (host `pending`: sent, no
  result yet) and a check on finished ones, and collapses once the run is
  over (a tap still opens it in full); "N messages, showing M" with 加载更早 keeping the reading
  position; messages sent from the phone queue above the composer until the
  transcript shows them; motion only for what just arrived (slide-in, a new
  reply unfolds over ≤ 500 ms, typing dots while the agent works, smooth
  follow at the bottom), all off under reduced motion; polling 1 s while the
  agent works. Keyboard: `interactive-widget=resizes-content` keeps the
  composer above it, and a pinned thread follows the shrinking scroller
  (ResizeObserver on the scroller + `visualViewport` resize) so the newest
  message stays in view; composer focus / blur and viewport resizes also
  hold a pinned thread at the bottom every frame for up to 1 s, and a tap's
  wobble (< 8 px) never counts as scrolling away; a finger dragging the
  history down keeps it unpinned until it lifts (re-pinning from scroll
  events mid-drag flapped the state every frame). The follow observes the
  whole page content, so a growing composer (toolbar, thumbnails, a long
  draft) keeps a pinned thread at the bottom too. The reveal cursor never
  stays inside a run of tool calls that grew after it was shown
  (`settleCursor`, `npm run test:unit`), which had stalled the thread until
  the page reopened. The toolbar above the composer (图片 / 诊断) attaches
  the client diagnostics snapshot and screenshots (what a tool opens
  renders above the row); a **快捷 / Keys** chip above the composer opens a
  pad of allowlisted pane keys (`Enter` / `Esc` / `Ctrl+C` / ↑↓ / `Tab` /
  `1`–`4`) so the phone can confirm, cancel, or interrupt without typing
  (host `key` RPC; `C-c` is required to stop Grok). The chip stays visible
  even before phone writing is enabled (keys inside stay disabled with a
  hint); the confirmation strip that appears when `waiting_kind` is set
  still offers the same keys inline. The composer is
  set off from the thread by a
  full-width hairline and an upward shadow, and the chat page uses 10 px
  side gutters (other pages 16 px). Reading back, the user's message that
  owns the content at the top of the screen pins there as one truncated
  line once it has scrolled out (`chat-sticky.tsx`, zero-height sticky box
  so it never moves the thread); tapping it glides back to that message,
  shown in full with a short highlight (`chat-jump-prompt` trace). Unsent
  composer text is kept per session in `localStorage`
  (`wezdeck.draft.<id>`, cleared on a successful send); errors have a
  one-tap copy; a "desk was just used" refusal counts down and resends
  (`session-send.ts`)
  ([`remote-access.md` Attachments](remote-access.md#attachments)). The sticky composer rests flush with the scroller
  bottom (`-mb-4` cancels `#console-main`'s `pb-4`), otherwise it drops by
  that padding the moment a drag starts. Back from the background the page
  refetches at once and shows 正在拉取最新消息（上次 HH:MM:SS）→ 已同步
  (`useResumeSync`), instead of silently showing old messages.

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
