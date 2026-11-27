# Web console motion

The motion spec for the web console (`web/`): which tool animates what, the
shared tokens, the rules, and how to verify. Split out of
[`web-pwa.md`](web-pwa.md) (2026-11-24) when that doc crossed its budget.

## Spec

Same stack as coco-forge (`apps/coco-platform`): Tailwind 4 for CSS state
transitions, `motion` 12 (`motion/react`) for elements entering and leaving.
Tokens live twice and must agree: CSS `styles/motion.css` (`--motion-exit
90ms / short 150 / medium 240 / long 340`, `--ease-enter / exit / standard`,
Material 3 emphasized curves) and JS `lib/motion.tsx` (`DURATION`, `EASE`,
`ENTER`, `EXIT`, presets such as `dropIn`). `MotionProvider` (root) wraps
`LazyMotion features={domAnimation} strict` — use `m.*`, not `motion.*` —
and `MotionConfig reducedMotion="user"` (opacity only under reduced motion).

| Change | How | Timing |
| --- | --- | --- |
| state: hover, press, open, a colour | Paint-only CSS `background-color` / `color` transitions (avoid `opacity` transitions inside split scrollers so Chromium never spawns `ActiveOpacityAnimation` + multi-row `Overlap` layers) | short, standard |
| an element arrives / leaves (sticky prompt, a chip, a hint) | `AnimatePresence` + `m.div` with a preset; the leaving element keeps its last content | enter medium + enter curve; leave exit + exit curve |
| a page / pane | View Transitions (`lib/view-transition.ts`) for top-level / mobile route changes; within a wide split, switching conversations swaps directly at `opacity: 1` (no `.pane-enter` dip) | 0 ms inside split; 120–240 ms on pushed pages |

Rules: states move one way (a list row is hover 9 % → pressed 12 % → open
15 % of the accent, `.list-row`, never white → grey → blue); never ease
between two unrelated `box-shadow`s (a 999 px veil into a 3 px bar painted
the row solid blue); prefer `opacity` / `transform` over `background-color`
for anything that changes while content renders (a background transition
froze ~140 ms and jumped); travel stays small (≤ 8 px). Verify with
`scripts/dev/web-frame-probe.sh` ([`remote-access.md`](remote-access.md#testing-locally)):
`grey-step`, `snap`, `row-fill` and the other findings fail the run, `jank`
(main-thread stalls) is reported as a warning.

## Compositor layer discipline (Chromium HiDPI)

On fractional-DPR displays (`1.25×` / `2.625×`, Chrome 152 / Android tablet Vulkan + Skia Graphite), Chromium `CompositeAfterPaint` promotes any CSS `opacity` or `transform` animation (`ActiveOpacityAnimation` / `ActiveTransformAnimation`) to a dedicated GPU layer and then overlap-promotes (`Overlap`) adjacent rows, dividers, and scrolling containers into temporary GPU squashing layers. Creating or destroying those layers toggles text between LCD subpixel and grayscale antialiasing and re-snaps fractional coordinates, reading as multi-row or title-bar flicker (2026-11-27).

Enforced rules:
- **Ambient status indicators** (`.led-running`): animate paint-only SVG `fill-opacity` on `.led-running circle`, never CSS `opacity` on the `<svg>` or stacked `animate-[pulse]`.
- **Split-list row states** (`.list-row` / `::before`): use paint-only `background-color` transitions, never `opacity` transitions on pseudo-elements.
- **Loading skeletons** (`components/ui/skeleton.tsx`, `session-skeleton.tsx`, `host-file-body.tsx`): keep individual `<Skeleton>` bars static (`bg-brand-soft`) and wrap each skeleton block in ONE `<SkeletonGroup>` (`.skeleton-pulse`: `opacity 1 ↔ 0.52` + `contain: layout paint`) inside a static outer card, with screen-reader-only `aria-label` (no visible `Loading…` text) and a 120 ms modal delay (`host-file-sheet.tsx`) without `mt-auto` bottom-pinned bars — animating per-bar `opacity` spawns N GPU layers, and animating `background-color` re-rasterizes the full HiDPI scroller (7M+ physical px) every vsync; a single contained group composites 1 GPU texture at 0 px repaint without overlapping headers.
- **Headers & fullscreen readers** (`host-file-sheet.tsx`, `sheet.tsx`): never mount `animate-spin` (`ActiveTransformAnimation`) inside a persistent title bar; open opaque `fullscreen` sheets directly at `opacity: 1` sized to `h-full` with an integer `min-h-16` (64 px) header (no hidden `Drawer.Backdrop`, no full-viewport `transition-opacity`, no fractional scroller top).
- **Automated guard**: `split-list-stability.cdp.test.ts` queries CDP `LayerTree.compositingReasons` across `idle ↔ running` switches and fails if any `ActiveOpacityAnimation` or `ActiveTransformAnimation` layer appears.

## Split switches

Measured frame by frame on real
conversations, a switch also had to: skip router scroll restoration on a
detail page (`restoresScroll`: the router carried the old item's offset
onto a location it had no entry for and applied it after render, so the
new conversation showed its middle and the sticky prompt flashed); land
a conversation at its bottom before the first paint (`chat-scroll.ts`,
a layout effect; the rAF landing stays for late layout); hide the sticky
prompt while the thread is pinned (`following`; content landing under a
pinned thread put the bottom > 48 px away for the glide's few frames);
warm a conversation before it opens (`prefetchSession` on row hover /
focus / press and j / k's neighbours: an uncached one drew a Loading…
frame with the page collapsed); and hold the previous ticket, inert,
until the next arrives (`keepPrevious`, no Loading… between tickets),
scrolled to its top. `split-switch.cdp.test.ts` samples every frame
after a switch.

The split list itself must stay pixel-still across switches (2026-11-27):
`Draft` pills (`chat-draft`, `ticket-draft`) use `text-meta leading-none py-0.5`
(16 px inside a 20 px `leading-5` caption line) so hiding/showing a draft on
selection never changes row height (±4 px before), and `SessionSubRow` computes
its `compact` mode from the raw saved draft rather than `visibleDraft` so an
empty idle sub-row with a draft never collapses its second line (±13.5 px
before). List rows and wide-shell chrome use integer multiple-of-8 dimensions (`72 px`
left rail, `32 px` bottom status bar, `min-h-16` 64 px / `min-h-14` 56 px rows,
`h-8` 32 px repo headings, `56 px` inset-shadow split head) so neither `.vt-split-list`
nor `.list-row` transitions land on half-pixel boundaries at 1.25x or 2.625x DPR
(e.g. a `68 px` rail sits at `178.5` physical px on a 2.625x tablet and caused
5,752 changed pixels across switches). Wide splits (`session-split.tsx`, `tickets-view.tsx`, `console-me.tsx`,
`console-diagnostics.tsx`) lock the split grid to `h-[100cqh] overflow-hidden`,
isolate `.vt-split-list` and `.vt-split-pane` with `contain: strict`, and on
real conversations give `SessionDetail` a fixed 3-row shell (static
`SessionHeader`, dedicated `session-thread-scroll` `.overflow-y-auto` middle
row, and non-sticky bottom `<form>` with `ComposerBox` + `SessionStatusBar`)
so `session-detail` stays bounded to viewport height and scrolling messages
never tear behind the bottom status bar. Wide-split conversation switches also
omit `.pane-enter` (`opacity: 0.4 → 1` over 120 ms) and swap directly at
`opacity: 1` like tickets (2026-11-27): fading the whole detail pane dipped the
static header/composer chrome on every click and promoted/demoted a full-pane
GPU layer on HiDPI screens, reading as a blink; `SessionHeader` also seeds its
avatar and title from the already-loaded session list row so cold switches
never flash `Loading…`. In the same pass, `SwipeActions` omits idle
`translateX(0px)` layers and hidden underlay buttons until a horizontal drag
starts, `motion.css` scopes `view-transition-name` to
`html:active-view-transition`, `TagLine` keeps its observers stable and caps
single-line height to prevent statusbar height bounces (paired with stale-on-timeout
git/worktree caching in `git_status.go` / `session_env.go`). Both `.list-row`
state tints/accent bar and `.led-running` breathing dots stay paint-only
(`background-color` on `.list-row` / `::before`, SVG `fill-opacity` on
`.led-running circle`, no duplicate `animate-[pulse]` on `AgentAvatar`) so
Chromium spawns zero `ActiveOpacityAnimation` layers and zero multi-row
`Overlap` squashing layers in the session list or right-pane thread across
`idle ↔ running` switches (verified via CDP `LayerTree.compositingReasons` in
`split-list-stability.cdp.test.ts` alongside `split-switch.cdp.test.ts`).

Live-device list-flicker observability (2026-11-27): `client-trace.ts` records
`layout-shift` (`PerformanceObserver` CLS ≥ 0.001, ignoring recent input, noting
whether a shifted source is inside `.vt-split-list`) and includes `listScroller`
(rect, row count, viewport scroll offset/height) in every diagnostics snapshot;
`split-column.tsx` emits `split-list-scroll` on unprompted `scrollTop` jumps
(≥ 4 px with no user scroll/touch/pointer in the previous 600 ms);
`session-list-trace.ts` emits `session-list-diff` on row order/membership/status
churn or rapid render bursts (≥ 6 renders/s); and `host-diag.ts` supports the
read-only `sample-list` step (`wezdeck-wsl diag --steps '[{"do":"sample-list","ms":2000}]'`)
to sample every row's `getBoundingClientRect()` and `.vt-split-list` `scrollTop`
across `requestAnimationFrame` frames and report `shiftedFrames`, `maxDx`/`maxDy`/`maxDh`,
`scrollJumps`, and `subpixelRows`.

Rendering cost of a switch (2026-11-24, CPU profile of a real conversation,
symbolized against a source-mapped build): one ~76 ms long task — React
render ~30 ms, markdown (streamdown → remark / rehype) ~25 ms, the forced
layout of landing ~15 ms — plus ~120 ms of native style / layout / paint for
the whole page of messages. Now a conversation opens with its newest 12
items and adds the earlier ones 20 at a time on idle callbacks, as a
transition (`useProgressiveFloor`, `chat-thread.tsx`; the browser's scroll
anchoring keeps the view still as they land above; once complete, 加载更早
renders at once as before), and each item is a `.chat-item` block with
`content-visibility: auto` (`contain-intrinsic-size: auto 120px`) so off-screen
messages skip style / layout / paint. Result: no long task in three profiled
switches (was 76 ms); web-frame-probe's worst main-thread stall per press
went from 109–124 ms to 0–56 ms. The relative-time formatter
(`formatAgo`) is cached per locale — building one per row was the top app
cost of a ticket switch, where every row re-renders.

Opening a conversation never scrolls with animation: after it lands, the
thread keeps growing for a moment (markdown laid out, the progressive
render adding earlier items), and a pinned thread used to glide after it —
a scroll animation on every switch (1910 → 2694 over ~150 ms). For
`LANDING_MS` after landing (extended while it grows) growth jumps to the
landing target inside the ResizeObserver callback, which runs before paint
(`useLandBeforePaint` / `grewWhileLanding`, `chat-scroll.ts`; `chat-landing.ts`):
normally the bottom, or — when newly completed (`status === 'done'`) or
running (`status === 'running'`, with no waiting prompt card or pending send)
and the latest message itself is taller than the viewport — the start of that
latest message (leaving `StickyPrompt` clearance when unpinned, so the reader
starts from the top instead of only seeing the tail, with `JumpLatest` to skip
to the end; traced as `chat-land`; `chat-landing.cdp`, 交互调试 › 进入会话的长回复落点). Later
opens (`idle`) land straight at the bottom. Messages brought in by the first
post-mount fetch over a persisted IndexedDB cache also advance the reveal
baseline (`nextBaseline`, `ChatThread` `syncing`) so already-finished replies
render statically instead of replaying through the streaming animation. The
glide is kept for a streaming reply. web-frame-probe's `glide` finding checks
it on painted frames.

The turn line (运行中… / 用时) at the thread's end stays mounted: it used to
render only once every new message was revealed, so each poll of a running
turn that brought a reply unmounted it and brought it back with its
entrance — a jitter every second or two, and 运行中 gone mid-turn. While
messages are still being revealed a turn the host calls done reads working
(`revealingTurnState`, `chat-turn.tsx`), so 完成 never shows above text still
unfolding. It and the queued bubbles enter only when they appear in an
open conversation: switching to a running session slid the turn line in on
its own (2026-11-25).

Switching to a running session also jittered: the thread's easing box
(`SmoothGrow`, `chat-grow.tsx`) held its height from mount and caught up a
frame later, so every growth while the conversation landed painted a frame
cut off at the old height — blank, content, blank. Until `LANDING_MS` it now
follows its content (no height) and holds from then on. Check it with
`web-frame-probe.sh sessions --ids A,B --status running` (20 changed pane
frames per run → 8, the swap plus the list row's tint). The probe's `blank`
finding flags a painted frame with the pane flat (no conversation): that
jitter, or the fade first tried from opacity 0.

Session tags (`components/deck/session-tags.tsx`, `.session-tag` in
`deck.css`) are coloured by meaning, a translucent fill of their tone (so an
accent tag still shows on the open row's accent tint): an agent wears its
own colour and mark (Claude clay + starburst, Codex green + terminal, Grok
ink + bolt; `--agent-*` per theme), 主 the accent and 副 neutral, a status its
tone (running / waiting / done), a branch and a repo neutral with their git
icons. The list rows and the session header share them.

