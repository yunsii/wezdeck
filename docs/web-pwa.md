# Web console as a PWA (phone + desktop)

Status: **live 2026-11-22**: ink theme, WD icon, three phone tabs (会话 / 工单 / 我的; 现在 retired 2026-11-23), sessions with phone writes ([`remote-access.md`](./remote-access.md)). Command palette and Web Push are next. Remote transport
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
   reachable in-app (the sidebar's WezDeck mark links it). The landing page
   uses the console's ink theme ([data-deck]): one line on what it is, 打开控制台
   and the source, a still of the session list with the real status lights,
   then sessions / tickets / from anywhere. Language and theme there are
   click menus (never hover); in the console they live only in 我的 › 外观.
   `/architecture` (架构解析, linked from the landing page) is the public
   explainer: concepts and flows in prose, files / endpoints folded. Each
   diagram is a React Flow canvas (`@xyflow/react`, lazy chunk; desk only)
   above its step list, which is the keyboard path and the whole diagram on
   a phone. Data lives in `web/src/features/architecture/` (`overview.ts`,
   `flows*.ts`, `capabilities.ts`); `tests/architecture.unit.test.ts` reads
   the Runtime routes / actions, the bridge switch and the relay's
   `readRPC` / `runWrite` and fails until a new entry point is described.
2. **One route tree, layouts by width**: `<768px` phone, `768–1279px` tablet
   (split, collapsible list), `≥1280px` desktop. Fixes today's gap at
   900–1023 px (neither `max-[899px]` nor `lg:` applies).
3. **Capability-aware navigation**: loopback Runtime → every section; remote
   link only → collab sections only (no "Runtime offline" pages).
4. **Phone IA — three bottom tabs** (revised 2026-11-23; 现在 retired — its
   bands reshuffled on every agent turn and it duplicated both lists).
   会话 is the home: a status filter like `Alt+/` (全部 / 等你 / 运行中 /
   空闲, remembered per device), a 等你 band on top under 全部, then the
   repo → worktree → pane tree ordered by **visits**, never output — the
   later of the desk visit (`visited`, the access ledger behind `Alt+g` /
   `Alt+x`, `session_visits.go`) and a visit from this phone
   (`lib/session-visits.ts`); never-visited groups (ticket agents) sink by
   name (`features/session-order.ts`); 待跟进 to-dos at the bottom. In a
   session, wezdeck's session keys carry over (`session-switcher.tsx`):
   `Alt+j` / `Alt+k` / `Alt+l` (`Alt+Shift+l` back) jump to the next
   session waiting on you / finished / running in the list's order — on the
   phone a 「还有 N 个等你 ›」 chip in the header when another one waits;
   `Alt+g` / `Alt+x` or tapping the title opens a switcher sheet grouped
   like the list. Switching replaces the history entry, so back returns to
   the list. Swiping a running / waiting / done row left offers 标为已读
   (`Ctrl+X` in `Alt+/`, host `clear`; also a button in 会话信息). The + beside
   the filter (`c` on a keyboard) is 新会话 — `Ctrl+k g`: repository, dev /
   task / hotfix, subject, first message; the sheet follows the host job
   and opens the session once the agent has taken the message. 工单 has the
   same + (`n`): 新工单 — from / to repository, title, what you saw, what you
   assume, optionally start the run now. The
   agent's own name (`agent_name`, usually Claude's derived peer address
   such as `wezterm-config-93`) is only a 会话信息 metadata row, not a
   header or list tag. Rename (`/rename`) moved into
   会话信息 (ⓘ). What
   waits on you badges its own tab: 会话 counts sessions waiting on you,
   工单 the tickets (`waiting_human`). `/console/now` stays as a redirect
   to 会话 for installed apps whose manifest still starts there. 工单
   links 工单动态 (lights as in the ticket list: ▲ only 等你, opening a
   ticket or waiting on the other side ○): cross-repo ticket events as sentences — one card per
   ticket run of events under its title and from → to repo, day headings,
   a clock time per line; tool calls, checkouts, session init and worktree
   moves left out; sessions are not in it. 会话 rows: repo →
   worktree → pane tree; primary/secondary when tmux-mounted; path-based
   so ticket worktrees can join later; Grok Ask shows tappable options
   from `elicitation`) · 我的 (an index of groups, each row showing
   how it stands — 连接 / 写入权限 / 用量 / 外观 / 应用 — each group a pushed
   page `/console/me/$page` with a back bar; the tab bar stays, re-tapping
   我的 returns to the index; write access is per device: phone, tablet or
   another browser each get their own key). Filters with counts never wrap:
   the count is a smaller figure and segments size by their text, so four
   statuses plus + fit a 320 px phone; 工单's band and 工单动态 are one line
   of text links, search opens from an icon. 进行中 sorts by last activity and
   folds tickets quiet for over a week (not running, not waiting on you) into
   一周以上没动静 (`splitQuiet`); ▲ marks only 等你, waiting on the other side is
   ○; rows are real links. Ticket detail is a pushed page: facts as Field
   rows, 摘要 open, 讨论 as a conversation (`lib/ticket-thread.ts`: the CLI
   writes it newest first; the initiator on the right, the newest question
   ringed while it waits on you; a note when the API cut the oldest off at
   8000 characters); the reply box keeps a draft and sends with Ctrl+Enter.
   诊断 (local Runtime) is the same split too (console-diagnostics.tsx):
   levels with counts, search, a category select; an entry's facts as Field
   rows, copy raw line, only this trace; entry ids are stable, so the 5 s
   refresh does not move the selection; a phone opens an entry in a sheet.
   On a wide screen 工单 is the same split as 会话 (tickets-view.tsx): the
   list sticky on the left (search above it), the ticket beside it in the
   page scroll, j / k move through the list (not while typing or a sheet is
   open), rows replace instead of push. The ticket list syncs on change
   (`lib/ticket-sync.ts`): the shell polls collab health (~380 B; 3 s while a
   run is in flight, 15 s otherwise) and refetches the list (~45 KB) when its
   events head, counts or runs move, with a backstop of 10 s while running /
   5 min idle; pages read that cache without timers of their own, so going
   back to 工单 refetches nothing. A run opens in a bottom
   sheet (transcript, prompt). Connection chip in the top bar opens a
   sheet (mode, path, RTT, last direct failure, host since, mic grant).
   Re-tap active tab = scroll top + refresh; sheets swipe down / Android
   back closes. No pull-to-refresh (neither reference has it).
5. **Wide screens (≥ 768 px, 2026-11-23)**: no phone layout blown up.
   会话 and 工单 are the same split (`session-split.tsx`): the list
   sticky on the left with its own scroll, the open conversation beside it
   on the page scroll (so the chat's pin-to-bottom is unchanged), capped at
   900 px; the current row is highlighted, picking another replaces the
   history entry, j / k move through the list's order and the URL follows;
   no back button. 我的 shows its groups on the left and the chosen one
   beside them (default 连接; group links replace). Sheets become a centred
   dialog (fade + scale, no grab handle). 工单's run / cache / cost band is
   folded into one Disclosure (the sidebar links 工单动态).
6. **Desktop keyboard**: `j`/`k` move, `Enter` open, `Esc` back, `/` filter,
   `g`+letter section jump, `Ctrl+K` command palette; one registry, hints in
   the UI.
7. **Writes**: ticket reply (and reply-and-continue) plus session send /
   keys, signed by an approved device key; close / re-run / new ticket still
   deferred.
8. **Notifications: Web Push** for "waiting on you" / "failed" plus
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
  shows 「暂时拿不到最新内容，显示的是 HH:MM 的内容」 above the composer only
  after 3 polls in a row failed (`useFailedPolls`; one flaky poll on a phone
  link stays quiet) or at once when the device is offline.
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
- Type (2026-11-23): one font stack everywhere — **Inter** (Latin),
  **Noto Sans SC** (CJK, full-width punctuation), **JetBrains Mono** (code),
  self-hosted from `@fontsource-variable/*` (OFL), not the Google Fonts CDN
  (unreliable from mainland China, unusable offline). `--font-sans` /
  `--font-mono` in `web/src/styles/tokens.css` feed Tailwind's preflight and
  `font-mono`; before, each OS rendered its own system pair (Segoe UI + 微软雅黑,
  Roboto + Noto CJK…) with mismatched weights and x-heights. Noto Sans SC is
  ~100 unicode-range slices: a first visit across the 我的 pages fetched 13–16
  slices, 0.7–0.9 MB; the service worker keeps fonts in `wezdeck-fonts`, a
  cache that outlives builds, so later visits fetch none. `text-spacing-trim`
  + `text-autospace` tighten full-width punctuation and space Chinese from
  Latin; tabular digits only where numbers line up (`tabular-nums`), no longer
  page-wide. Loading follows `next/font`: the Latin Inter file (~48 KB, on
  every page) is `<link rel=preload>`ed from `__root.tsx` (same hashed asset
  the `@font-face` uses), and `Inter Fallback` — local Arial with next/font's
  `size-adjust` / ascent / descent overrides for Inter — stands in until it
  loads, so the swap does not shift the layout. CJK slices are not preloaded
  (which ones depends on the page) and need no metric fallback.
- Tokens: `[data-deck]` in `web/src/styles/deck.css` (light `#f6f7f9` paper /
  `#ffffff` surface / `#11151c` ink; dark `#14181f` / `#1e232c` / `#f1f3f6`),
  console only. `web/src/styles.css` only imports `web/src/styles/*.css`
  (tokens, base, deck, chat, motion, scrollbar, architecture, code) in
  cascade order; add a rule to the file of its domain. System font (PingFang / Noto Sans SC / Segoe UI), tabular
  numbers.
- **Controls come from `web/src/components/ui`, never a native element**
  (2026-11-23). Business code may not write `<button>`, `<input>`,
  `<select>`, `<textarea>`, `<details>` / `<summary>` — an eslint
  `no-restricted-syntax` rule in `web/eslint.config.js` fails the
  pre-commit check; `components/` is where the natives live. The set (Base
  UI underneath): `Button` (variants `solid` dark call to action, `key`
  surface key, `link` quiet text action, `ghost`, `outline`, `plain` for
  rows that lay themselves out; sizes `lg` / `md` touch targets, `round`
  icon), `Input` (`field` phone form field, `bare` inside a styled box,
  `default` dense desktop), `Textarea` (`field` / `bare`), `Select`
  (`size="lg"` on phones; popup above the z-50 sheets), `Checkbox`,
  `Disclosure` (a folding section: title + turning ›, `chevron={false}` for
  a custom row), `Sheet` (the phone's bottom sheet on Base UI Drawer — swipe
  down to dismiss (a short drag springs back; inside scrolled content the
  drag scrolls first), focus trap, Esc, backdrop tap, scroll lock; the swipe
  moves it through `--drawer-swipe-movement-y`; paper colour kept, set apart from the
  page by a 50 % backdrop, a top edge with a shadow and a grab handle: the
  old sheet had no visible edge on the dark theme; only the body under the
  title scrolls), `Field` / `FieldList` (label / value rows to read and copy,
  the Telegram profile way: tap or click copies the value, long-press or
  right-click opens copy value / copy "label: value"; a phone stacks the
  value over a small label, a wide screen keeps two columns sharing one
  label width via subgrid and lights the row on hover), plus `Segmented`,
  `Popover` (ink card, tokens carried into its portal; its menus are click-only), `Tooltip`. A
  missing control is added there first, then used. Tests address them by
  role: a Select is `combobox` + `option` (the popup is portalled to body),
  a Checkbox is `checkbox`.
- Phone patterns: large title that scrolls with the page, grouped inset
  lists, a three-way segmented control on 工单 (进行中 / 等你 / 已结束),
  settings as segmented rows instead of popovers, a translucent bottom bar
  with four tabs (hidden on detail pages, which are full screen).
- Screen stays on while a session page is open (`lib/wake-lock.ts`, Screen
  Wake Lock): taken on entry and again when the page comes back to the
  front (browsers drop it while hidden), released on leaving; unsupported
  browsers just don't get it, and every outcome is a `wake-lock` client
  trace event, so a diagnostics snapshot tells which happened.
- Session header (`session-header.tsx`), pinned while the thread scrolls:
  back, session title (tap to `/rename`) over an agent chip + branch, a
  「需要你处理」 chip only while the agent waits for the human (running and
  done are visible in the thread itself: the working line, the reply), and **ⓘ
  会话信息** at the far right; then meters, each shown only once it is close
  to full (≥ 75 %, `NEAR_FULL`) — context, Claude 5 h / 7 d limits with
  reset time ([`remote-sessions.md` Account limits](remote-sessions.md#account-limits));
  a limit snapshot whose reset time has passed is ignored — plus background
  tasks when there are any; the row disappears when nothing qualifies (all
  numbers stay in 会话信息). Fill is amber from 75 %, red from 90 %; tapping
  the meters shows model, tokens, cache hit, limit freshness and the
  background task list. Its height is
  `--session-head`, which the sticky prompt sits under.
- Back from a detail page (`lib/go-back.ts` `useGoBack`, adapted from
  forge's `TopBar`): came from inside the app → `history.back()` (the list
  returns where it was); opened directly (shared link, refresh, PWA cold
  start, notification) → `replace` to the list, no extra history entry.
  It reads TanStack Router's `useCanGoBack` (the in-app index in each
  entry's state), never `window.history.length`, which counts pages from
  before the app — "back" used to leave the app from a directly opened page.
- First-level pages (the bottom tabs and the desktop sections) only ever
  hold the first history entry, forge's rule (`lib/go-to-tab.ts`, Android
  Navigation's `popUpTo(start)`): back on one leaves the app. Tabs, sidebar
  links and `g`+letter go back to entry 0 in one step, then replace it;
  `keepTabsFirst` collapses any first-level page found at index > 0 (entries
  an older build pushed survive in the tab's history; in-page links such as
  the header badge). A language switch replaces. The `#pair=` cleanup keeps
  the router's entry state — `replaceState(null)` had wiped `__TSR_index`.
- The chosen language survives a cold start: the manifest `start_url` is
  `/console/sessions` (no locale prefix), so a language switch stores the
  `wezdeck-locale` cookie (`lib/locale-pref.ts`) and the Worker
  (`src/locale-redirect.ts`, from `server.ts`) 302s a prefix-less `/console`
  request to `/zh/…` when it says zh — or, with no cookie yet, when
  `Accept-Language` prefers zh. The hash (a `#pair=` token) survives the
  redirect; the service worker caches `/zh/console` pages too.
- Motion (`styles/motion.css` "Motion tokens"): every transition takes its timing
  from `--motion-exit` 90 ms / `--motion-short` 150 / `--motion-medium` 240 /
  `--motion-long` 340 and `--ease-enter` / `--ease-exit` / `--ease-standard`
  (Material 3 emphasized curves): enter slower and decelerating, leave faster
  and accelerating, one thing moving at a time, never two whole pages
  half-transparent on top of each other; reduced motion keeps short fades
  only. Overlays: `Sheet` slides up (phone) or fades and scales in (desk) —
  its enter states are `@starting-style` (Tailwind `starting:`), because the
  popup loses `data-starting-style` before its first style resolution, and
  callers keep it mounted with `open` (a `{open ? <Sheet/> : null}` or an
  early `return null` skipped the exit); menus / popovers grow from the
  trigger (`motion-pop`), tooltips fade (`motion-fade`), `Disclosure` panels
  animate their height (`motion-collapse`); `Select` animates in only — Base
  UI keeps a closed select popup mounted and an exit transition left it in
  the DOM, unhidden.
- Page transitions (`lib/view-transition.ts`, `styles/motion.css`): View Transitions
  through the router's `defaultViewTransition`, in layers. The shell — status
  band (`vt-band`), sidebar (`vt-sidebar`), tab bar — never moves; the root
  snapshot keeps only the background. A switch to another section (sidebar,
  tabs, palette) has no transition at all — a view transition snapshots the
  page first and only delays the switch (measured on a phone: about 300 ms
  with the old cross-fade, 7–35 ms without); the section is ready instead:
  the shell keeps the ticket list and the session list warm, both persist to
  IndexedDB, and every section's route code is preloaded once idle
  (`useWarmSections`). Within a section (`within`) a phone pushes like iOS —
  the new page slides in whole and opaque with a shadow, the old one steps
  back 28 %; back reverses it with the leaving page on top — and a wide
  screen fades out, then nudges the new page in 16 px; in a wide split
  (会话, 我的) the list (`vt-split-list`) holds still and only the pane
  (`vt-split-pane`) fades through. The content column (`vt-page`) has its own
  background and the snapshots no plus-lighter blend: a transparent snapshot
  of two pages blended together was the ghost on push. The shell reads the
  resolved location, so on back its title does not switch before the page
  (it used to end up in the leaving page's snapshot). Toasts sit in a
  `toast-layer` that never moves.
- 会话信息 (`session-info.tsx`), a bottom sheet portalled to `<body>` (the
  header's backdrop blur would trap a fixed sheet): 复制会话引用 (the
  host-built `reference` block for another agent: id, transcript path, cwd,
  tmux pane), then the host's `meta` groups — 会话, 运行位置, 会话记录, 状态 —
  plus 用量 and 能力 (the adapter's `capabilities`); tap any row to copy its
  value; Esc, the backdrop or × closes it.
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
  reply: `brand-surface`); runs of tool calls collapse into one line (`chat-tools.tsx`), each call
  expands to its diff / preview / command and result — in the list
  every call is one truncated line — the tool name (quiet) and its target
  (text colour) split by a hairline, from the host's "<name> <target>"
  summary; opening a call shows its whole
  description, and bodies wrap instead of scrolling sideways; the newest run while
  the agent works is open, shows its last 3 calls ("N earlier calls" above)
  with a breathing light on the call in flight (host `pending`: sent, no
  result yet) and a check on finished ones, and collapses once the run is
  over (a tap still opens it in full); "N messages, showing M" with 加载更早 keeping the reading
  position; a message sent from the phone shows at once at the end of the
  thread as a dashed bubble (发送中… → 排队中 / 已送达, like Claude Code's
  queued input) and becomes a normal user bubble only when the transcript
  shows it — the agent may take queued ones in any order; each transcript
  line after the send settles one bubble (`settle`, `chat-thread.tsx`), and
  a bubble is never dropped while the agent works, only a minute after it is
  idle; motion only for what just arrived (slide-in, a new
  reply unfolds over ≤ 500 ms, one working line (running light + 运行中… elapsed · tokens) while the agent works, the same shape whether or not a tool call is out, smooth
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
  the page reopened. One toolbar row above the composer holds every tool:
  快捷 (always shown; disabled with a hint until write access is enabled on this device),
  then 图片 once the phone may write, then the picked thumbnails.
  What a tool opens renders above the row in one card style, never as a
  popover: 快捷 opens three labelled keys — `Enter` confirm, `Esc` cancel,
  `Ctrl+C` interrupt (host `key` RPC; `C-c` is what stops Grok) — and
  closes once a key is sent (diagnostics are pulled by the host, see
  remote-sessions.md "Diagnostics on demand"). Choices (digits,
  arrows, `Tab`) are deliberately not keys: questions, plans and
  permission prompts get their own tap targets on the page
  (`session-elicitation.tsx`, the confirmation strip). The composer is
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
  ([`remote-sessions.md` Attachments](remote-sessions.md#attachments)). The sticky composer rests flush with the scroller
  bottom (`-mb-4` cancels `#console-main`'s `pb-4`), otherwise it drops by
  that padding the moment a drag starts. Back from the background the page
  refetches at once, silently (`useResumeRefetch`; the old 正在拉取 → 已同步
  line on every return was noise) — the stale note above covers a refetch
  that keeps failing.

## Supported browser (2026-11-23)

Install the phone app from **Chrome** (Android). Firefox for Android 162 as
an installed PWA mishandles the back gesture on the app's first history
entry: the page is unloaded (`visibilitychange → hidden`, `pagehide`, **no**
`popstate`) and the window stays open on a blank gray shell; only a second
back closes it, and nothing in the page can intercept the first one. Measured
with host-pulled diagnostics (boot `length:1 index:0`, then `previous`
ending in `pagehide` only), so the app's own history is correct — first-level
pages hold entry 0. Same symptom as Mozilla
[bug 1967825](https://bugzilla.mozilla.org/show_bug.cgi?id=1967825) (fixed
in 140; back on 162). Chrome closes the app on that back press like any
Android app. Open question: [`diagnostics.md`](diagnostics.md#open-questions).

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
page (no sheet yet); jump keys are `g x/i/c/a/m` (总览 / `g o` is gone too: its Runtime, IME and WSL facts are 我的 › 本机 on this computer, `/console` opens 会话 on every device; 开发 and its `g d` are gone — 会话's worktree tree covers it, 在 VS Code 中打开 lives in 会话信息 on this computer, `/console/development` redirects to 会话); `?remote=1` is sticky
per tab (sessionStorage) so in-app navigation keeps the remote path.

## Observability

- Remote link reports mode changes (`mode`, `path`, `rtt`, `same_public`) as a
  frame the host logs (`category=relay event=client_mode`).
- Worker logs `sw_update_offered`, `install`, `push_subscribed`,
  `push_sent` rows.
- Client trace: `boot` (load URL without hash, navigation type, history
  length / router index), `popstate` (landing path, router index, whether the
  app wrote that entry) and `after-back` (what `#console-main` shows 0.5 s
  later); the last 60 events are saved to localStorage on hide / back and
  come back as `previous` in the next snapshot, even after the app was
  closed.
- Client trace (pulled with `wezdeck-wsl diag`) keeps a `nav` row per navigation (`path`, history
  `index`, `length`) and `nav-collapse` when a first-level page is folded
  back to the first entry.

## Phases and verification

| Phase | Scope | Verified by |
| --- | --- | --- |
| 1 PWA shell | manifest + icons, SW, update toast, safe area, install entry, persisted cache, capability-aware nav, breakpoint fix | installability check in Chrome; offline reopen shows "as of" in headless CDP; real phone install |
| 2 Phone shell | bottom tabs, inbox, pushed detail, run sheet, connection sheet | CDP at 390×844 with touch emulation |
| 3 Desktop keyboard | list keys, command palette, hints | keyboard-only CDP flows |
| 4 Writes | deferred (decision 6) | — |
| 5 Push | Web Push + app badge | real phone notification opens the ticket |
