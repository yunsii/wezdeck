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
| state: hover, press, open, a colour | CSS transition, preferably of `opacity` on a pseudo-element layer (compositor: smooth while the main thread renders) | short, standard |
| an element arrives / leaves (sticky prompt, a chip, a hint) | `AnimatePresence` + `m.div` with a preset; the leaving element keeps its last content | enter medium + enter curve; leave exit + exit curve |
| a page / pane | View Transitions (`lib/view-transition.ts`); none within a wide split | — |

Rules: states move one way (a list row is hover 4 % → pressed 8 % → open
10 % of the accent, `.list-row`, never white → grey → blue); never ease
between two unrelated `box-shadow`s (a 999 px veil into a 3 px bar painted
the row solid blue); prefer `opacity` / `transform` over `background-color`
for anything that changes while content renders (a background transition
froze ~140 ms and jumped); travel stays small (≤ 8 px). Verify with
`scripts/dev/web-frame-probe.sh` ([`remote-access.md`](remote-access.md#testing-locally)):
`grey-step`, `snap`, `row-fill` and the other findings fail the run, `jank`
(main-thread stalls) is reported as a warning.

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
bottom inside the ResizeObserver callback, which runs before paint
(`useLandBeforePaint` / `grewWhileLanding`, `chat-scroll.ts`); the glide is
kept for a streaming reply. web-frame-probe's `glide` finding checks it on
painted frames.

