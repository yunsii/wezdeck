# Tab Visibility

The tab-visibility pipeline answers: **of all tmux sessions a workspace
owns, which N should the WezTerm tab bar render directly, and how does
the user reach the rest?**

The shipped layout is **N visible tabs + 1 overflow tab**. Visible tabs
are spawned at workspace cold-open (top-N of the user's
`workspaces.lua` config order). The overflow tab is a single rotating
slot whose pane projects into a per-workspace browse session by default,
and switches to any other configured session when the user picks one
in the `Alt+x` picker. Total wezterm tab count stays at `N + 1`
regardless of how many sessions the user cycles through.

Behavior is **always-on for every workspace** — there is no opt-in
gate. `tab_visibility.is_enabled(name)` returns true for any non-empty
workspace name once the module is configured.

## Data flow — focus statistics

Each switch produces an **entry/leave pair** through the same script.
Dwell is paid only on leave, equal to the real ms the session held
focus — so a glance costs zero (dead-zone filter) and a long burst
contributes proportionally to its actual time on screen:

```
tmux client C switches from session A to session B (workspace W)
  └─ client-session-changed / client-attached hook
     └─ scripts/runtime/tab-stats-bump.sh "B" "/dev/pts/N"
        ├─ read enter-state for /dev/pts/N (if present): "A, W_A, enter_ms"
        │   └─ same session → noop (duplicate hook fire, preserve enter_ms)
        │   └─ different session → tab_stats_close_out W_A A (now-enter_ms)
        │       └─ if dwell_ms < 1s   → skip (path-through filtered)
        │       └─ otherwise          → __tab_stats_write_delta(W_A, A, dwell_ms, 0)
        ├─ resolve W (from B's @wezterm_workspace tmux option)
        ├─ tab_stats_bump W B
        │   └─ __tab_stats_write_delta(W, B, 0, 1)   (raw_count++ only, no dwell)
        └─ write enter-state for /dev/pts/N: "B, W, now_ms"
```

The shared `__tab_stats_write_delta` jq pipeline does, atomically per
workspace file:

1. decay every session's `dwell_ms` by `exp(-Δt_ms / half_life_ms * ln2)`
   (falling back to v1 `weight` when present, so a not-yet-migrated
   file still ranks)
2. set `last_bump_ms = now` for every session (so the next decay
   computes a clean age, not double-decayed)
3. on the target session: `dwell_ms += $dwell_delta`,
   `total_dwell_ms += $dwell_delta`, `raw_count += $raw_delta`
4. emit the v2 shape — **no normalize step**. Long-used sessions
   accumulate real ms (hours = millions of ms), short visits add
   thousands of ms; the magnitude difference is what keeps the
   ranking stable.
5. atomic tmp + rename into
   `%LOCALAPPDATA%\wezterm-runtime\state\tab-stats\<workspace>.json`

Throttle: bumps for the same session within 500 ms collapse to one
(entry-state file is also preserved so the dwell isn't reset). Lock:
per-file `flock -x 9` so concurrent hooks serialize without losing
writes.

Per-client enter state lives under
`%LOCALAPPDATA%\wezterm-runtime\state\tab-stats-enter\<client_slug>.txt`,
one file per tmux client (`client_tty` → slug `pts_N`). Format:
`<session>\t<workspace>\t<enter_ms>`. The workspace field lets close-out
attribute dwell correctly even if the prior session has since been
killed (we can no longer ask tmux for its @wezterm_workspace).

**Why dwell, not capped weight**: the previous v1 design paid a
saturated `weight ∈ [0,1]` on leave (30s capped to 1.0) and
renormalized to `max(weight) == 1.0` on every write. That made every
30s+ visit add the same delta regardless of actual time spent, and the
renorm step crushed the long-used session's lead — five different 30s
visits could push a 100h-cumulative session out of top-5. v2 pays raw
dwell ms (a 2h burst weighs 240x a 30s burst) and skips the renorm,
so cumulative time is preserved in absolute magnitudes.

**Why split entry from leave**: a single `Alt+x` peek that bumps both
`weight += 1` and stays sub-second would have promoted a cold session
into top-N under a hypothetical entry-only scheme. Splitting entry
(raw_count only) from leave (dwell-paid, dead-zone filtered) keeps
the rank in line with actual use time.

## State schema

One file per workspace, slug-sanitized into `<workspace>.json`:

```json
{
  "version": 2,
  "half_life_days": 7,
  "sessions": {
    "wezterm-config": {
      "dwell_ms": 7234567.89,
      "total_dwell_ms": 12998765,
      "last_bump_ms": 1777343497366,
      "raw_count": 47
    },
    "ai-video-collection": {
      "dwell_ms": 42345.0,
      "total_dwell_ms": 87654,
      "last_bump_ms": 1777343497366,
      "raw_count": 19
    }
  }
}
```

- `dwell_ms` — decayed cumulative dwell in milliseconds. **Primary
  ranking key** (top-N, picker sort). Sums each leave's actual ms (no
  cap), decayed exponentially with a 7-day half-life so idle sessions
  fade. Never renormalized — long-used sessions carry orders-of-
  magnitude more weight than short-visit competitors.
- `total_dwell_ms` — lifetime cumulative dwell ms, **never decayed**.
  Used as the "you spent X hours on this" surface for the picker
  (Alt+x can sort or display by this value).
- `last_bump_ms` — wall-clock epoch ms of the most recent write.
  Drives the decay age computation on the next write.
- `raw_count` — lifetime focus-event count, never decayed. Acts as
  the dwell-tied tiebreaker in the sort and as a diagnostic chip in
  the picker.

**v1 → v2 migration**: pre-v2 files use a `weight ∈ [0,1]` field in
place of `dwell_ms`. Readers (`tab_stats_top_n`,
`tab_stats_aggregated_tsv`, `tab_visibility._rank_sessions`) fall back
to `weight` when `dwell_ms` is missing, so the rank stays sane until
the next write rewrites the file in v2 shape. Legacy weights land in
the v2 file as sub-1 ms values — effectively a soft reset, since
real-time dwell (ms scale) dominates within the first few real focus
events.

## Decay math

`dwell_ms_after = dwell_ms_before * 2 ^ ( -Δt_ms / (half_life_days * 86_400_000) )`

→ At `half_life_days = 7`, a session's decayed dwell halves every 7
days of inactivity. After 14 days the contribution is ¼; after 30
days roughly 5%. Long-vacation behavior: all sessions decay by the
same factor while the user is away, so the **relative ordering is
preserved** and the top-N set on return matches the set when the user
left. The first focus events after a long break still need to climb
back proportionally — but a session that genuinely had hundreds of
hours of cumulative dwell will retain a large absolute floor even
after months of decay, while a one-off 30s session decays to zero
within weeks. This is the property that keeps long-used projects
sticky and short-visit projects from poisoning top-N.

## Why per-workspace?

Each workspace has its own pool of repo-family tmux sessions; cross-
workspace ranking would mix unrelated projects. The `default` workspace
is also tracked (so ad-hoc shells can be diagnosed) but has no
managed-session metadata, so its bumps land on free-form session names.

## CLI helpers

`scripts/runtime/tab-stats-lib.sh` exposes:

- `tab_stats_bump <workspace> <session_name>` — entry path used by the
  hook. Throttled, atomic, decays existing rows on every call but
  only increments raw_count on the target.
- `tab_stats_close_out <workspace> <session_name> <dwell_ms>` — leave
  path. Pays the actual focus ms into the target's dwell_ms +
  total_dwell_ms (skipped under the 1s dead-zone).
- `tab_stats_read <workspace>` — print the raw JSON.
- `tab_stats_top_n <workspace> <n>` — newline-separated session names
  ordered by `dwell_ms desc, raw_count desc, name asc`.
- `tab_stats_top_n_tsv <workspace> <n>` — same but TSV with dwell_ms,
  total_dwell_ms, raw_count, last_bump_ms.
- `tab_stats_aggregated_tsv <workspace>` — every base session (after
  `__refresh_*` aggregation) as TSV: dwell_ms, total_dwell_ms,
  raw_count, last_bump_ms.

## Layout — visible tabs + overflow tab

Layout is the default for every workspace. The remaining knob is
`spawn_visible_only` in `wezterm-x/local/constants.lua`:

```lua
tab_visibility = {
  spawn_visible_only = true,    -- cap startup spawn to visible_count
  -- visible_count = 5,
  -- half_life_days = 7,
}
```

`spawn_visible_only` controls only the startup-spawn cap (lifecycle
change); the picker, slot-aware titles, frequency stats, and overflow
projection are unconditional now.

### Cold open (`Alt+w` to a workspace with no live window)

When `spawn_visible_only` is set:

1. `Workspace.open` reads `workspaces.lua` items, computes the
   canonical session name for each cwd via
   `scripts/runtime/tmux-worktree/print-session-names.sh` (one shell-out
   per cold-open, not per item), then asks
   `tab_visibility.preferred_item_order` for the spawn list. The brain
   ranks each item's session by aggregated decayed dwell (after
   `__refresh_*` aggregation) and caps at `visible_count`. Items whose
   session has no stats — never been focused — fall back to the
   `workspaces.lua` declared order, so the bootstrap experience before
   any focus events is identical to pre-Phase-2 behaviour. The net
   ordering for the work workspace once `coco-server` accumulates the
   most focus: `[coco-server, ai-video-collection, breeze-monkey,
   coco-platform, operations-monkey]` even though `coco-server` sits
   sixth in `workspaces.lua`.
2. Spawns those N as wezterm tabs via the existing managed-spawn path
   (`open-project-session.sh` per item).
3. Appends one extra **overflow tab** with title `…`. Its pane runs
   inline bash that creates the per-workspace browse session
   `wezterm_<slug>_overflow` if missing (cold-start safe: tmux
   `new-session -d` fires only on first open) and execs into
   `tmux attach -t <browse>`.
4. The overflow pane records its tty into
   `/tmp/wezterm-overflow-<slug>-tty.txt` before the exec. That tty is
   the stable client identifier the picker dispatch script uses to
   `tmux switch-client -c <tty>` later.

Items beyond the cap are not spawned. Their sessions don't yet exist
in tmux either — the tab bar shows N+1 tabs and the configured project
list is otherwise invisible until the user reaches for `Alt+x`.

### Hot open (`Alt+w` while the workspace window already exists)

`Workspace.open` finds the existing window and falls through to
`sync_workspace_tabs`. Cap is **soft on hot open**: `desired_items`
(the spawn loop input) is the capped set, but `prune_keep_items` (the
prune loop input) is the full configured list, and the alignment-check
fast-switch path uses `prune_keep_items`. Net behavior:

- Tabs already spawned before the cap turned on stay alive (no
  surprise kill on a stray `Alt+w`).
- Sessions that fell out of the spawn window during the same workspace
  lifetime don't re-spawn on `Alt+w` (the cap holds for the lifetime
  of that workspace window).
- `prune_workspace_tabs` and `workspace_is_aligned` both skip the
  overflow tab via `is_overflow_tab` since it is owned by tab_visibility,
  not by `workspaces.lua`.

### Live hot reorder (brain rerank while the window is open)

`titles.lua` watches `tab_visibility.visible_signature` on every
`update-status` tick. When the brain promotes a new session into the
top-N (`packages` jumps in, `operations-monkey` drops out), the signature
changes and `Workspace.maybe_hot_reorder` runs
`sync_workspace_tabs(preserve_focus = true)`.

Layout invariants under `preserve_focus`:

- The currently-active tab is **protected from prune** for this round,
  even if its session fell out of top-N. The user's focus never
  disappears mid-typing.
- The other top-N tabs **keep their existing positions** — the per-item
  MoveTab loop is skipped to avoid a focus cascade. So when one session
  is promoted in and another demoted out, the four unchanged tabs stay
  in their slots; only the demoted tab's slot turns over.
- A newly-spawned tab lands at the end of the strip (wezterm's
  `spawn_tab` always appends). After spawn + prune, `sync_workspace_tabs`
  re-positions the **overflow tab** to the tail with a single MoveTab
  if needed — so the visible order ends up `[top-N..., …]` with the
  promoted session taking the demoted session's old slot. The single
  MoveTab is not a focus storm, and the focus restore below returns
  the user to the protected tab.

Trade-off still standing: when `preserve_focus` is on, the top-N
internal order can drift from `desired_items`'s dwell-desc order — the
*set* matches and the demoted-slot replacement is in-place, but a
rerank within the existing top-N doesn't reshuffle positions until the
next cold-open. That's intentional — we trade theoretical rank order
for muscle memory on the visible strip.

**Overflow → visible-tab handoff.** When the protected tab IS the
overflow tab and overflow is hosting a session that just got promoted
into top-N (i.e. the same session that the spawn loop just created a
proper visible tab for), focus is handed to the new visible tab
instead of being restored to overflow. Rationale: the user was
watching `platform-core-tech-weekly` via overflow projection; the
session graduated to its own permanent tab; their attention should
follow the *session*, not the now-redundant rotating slot. The
caller passes `opts.cwd_to_session` (already computed in
`maybe_cap_items` for ranking) into `sync_workspace_tabs`, which
reverse-looks up the overflow's hosted session, finds the matching
desired item, then matches it to a visible tab via `tab_matches_item`.
Without this branch the user would see their session move into a new
tab but their cursor stay glued to `…`, and `maybe_clear_overflow_
collision` would defer indefinitely (active-pane protection) until
they manually navigated away.

### Overflow auto-detach when a projected session promotes in

When the user has been viewing a session through the overflow pane
(via an earlier `Alt+x` pick) and that session accumulates enough
focus to enter top-N, the hot-reorder path spawns a new visible tab
for it via `open-project-session.sh`. That script reuses the existing
tmux session (`tmux has-session` → `tmux attach-session -t <name>`),
so for a brief window **both wezterm panes — the new visible tab and
the overflow pane — are tmux clients of the same session**. tmux
mirrors the display across clients, which surfaces as the new tab's
loading state being duplicated inside the `…` tab.

`Workspace.maybe_clear_overflow_collision` resolves this on every
`update-status` tick:

1. Read `_G.__WEZTERM_TAB_OVERFLOW[<workspace>]` for the overflow
   pane's current target session.
2. If the target is the per-workspace browse session
   (`wezterm_<slug>_overflow`), no-op — already at browse.
3. If `tab_visibility.is_in_visible(<workspace>, <session>)` is false,
   no-op — overflow is still projecting an out-of-top-N session, which
   is the steady state and not a collision.
4. If the focused pane (`_G.__WEZTERM_FOCUSED_PANE_ID`) equals the
   overflow pane, **defer** — same active-pane protection pattern as
   `preserve_focus` prune in `sync_workspace_tabs`. Retargeting the
   user's view mid-watch would be jarring; the next tick after the
   user navigates away will catch the collision.
5. Otherwise: invoke `scripts/runtime/tab-overflow-attach.sh
   <workspace> wezterm_<slug>_overflow` via
   `wezterm.background_child_process`, then mirror the new (pane →
   browse_session) edge into `set_overflow_attach` /
   `set_pane_session` so subsequent ticks early-return on the
   `session == browse_session` guard.

The shell-out and the new visible tab's `tmux attach-session` are
parallel but independent — `switch-client -c <overflow_tty>` only
touches the overflow client, while the new tab opens its own client.
Either landing order leaves overflow on browse and the visible tab
attached to the promoted session alone.

The call is idempotent and cheap (a handful of map lookups when no
collision; a single `background_child_process` when there is one), so
it runs unconditionally each tick rather than being gated on the
brain's signature change — the defer branch needs to re-evaluate when
the user moves focus away from overflow, and signature changes don't
fire on that.

### `Alt+x` — single-tab session rotation

`Alt+x` (manifest id `tab.overflow-picker`, wezterm layer, forwarded
into the active tmux pane via user-key 4) opens a `tmux display-popup`
running the Go picker (`native/picker/bin/picker overflow`) with
**every configured session across every workspace whose items snapshot
has been written**, marked by current state:

- `●` visible — already a wezterm tab.
- `◐` warm    — tmux session exists but not in a wezterm tab (currently
  living detached or projected into the overflow pane).
- `○` cold    — no tmux session yet.

Each Alt+x press calls
`Workspace.refresh_all_items_snapshots` from the wezterm-side handler
in `action_registry.lua` before forwarding into tmux, so every
managed-launcher workspace's `<slug>-items.json` is rewritten
synchronously from the live `workspaces.lua` table. Edits to
`workspaces.lua` (after a sync that reloads the wezterm config)
therefore surface in the picker on the next press without forcing a
workspace cold reopen. Workspaces whose items declare raw
`command = { ... }` with no launcher (e.g. the `mock-deck`
dev/demo workspace) are filtered out by
`_maybe_write_items_snapshot_impl`: nothing to manage means nothing
worth picking, and any stale snapshot from a prior configuration is
removed in the same step so the picker stays in lockstep. Hot `Alt+w`
still skips the write to keep workspace-switch latency at its
baseline; the snapshot is only consumed by Alt+x, so paying that cost
there is correct.

The popup shows a workspace badge column next to each row. Rows are
ranked by **accumulated dwell time** (decayed dwell_ms from
`tab-stats/<slug>.json`, aggregated across `__refresh_*` variants
under their base session name): the active workspace's rows still
group at the top, but within that block the sessions you actually
spend the most time in come first — a project that sits at row 6 in
`workspaces.lua` will jump to row 1 in the picker once it accumulates
the most hours. Cross-workspace rows interleave by dwell too (a
heavily-used session in workspace B can rank above a barely-used
session in workspace A while you're on A); the workspace badge keeps
identity visible. When stats haven't yet differentiated rows (cold
start, or a tie at dwell 0), the `workspaces.lua` declared order acts
as the within-workspace tiebreaker so the picker stays usable before
any focus events accumulate. Always-on substring filter
matches **workspace + label + cwd** lowercase, so `cfg neo` lands on
`config · neovim` regardless of starting workspace; `Tab` toggles the
scope between *all workspaces* (default) and *current workspace only*.
`Esc` clears the filter when non-empty, otherwise closes; a second
`Alt+x` always closes (toggle behaviour). When the Go binary is missing
the picker falls back to the legacy single-workspace `tmux display-menu`.

Picker dispatch (`tab-overflow-dispatch.sh`):

| State | Path | Result |
| --- | --- | --- |
| `●` visible | emit `tab.activate_visible` event | `Workspace.activate_only` brings that wezterm tab forward |
| `◐` warm | `tab-overflow-attach.sh` runs `tmux switch-client -c <tty> -t <session>` + emits `tab.activate_overflow` | overflow pane retargets to that session, wezterm jumps to overflow tab |
| `○` cold | `tab-overflow-cold-spawn.sh` runs `tmux new-session -A -d -s <session>` + the same attach + activate path | new bare bash session created, projected into overflow tab |

**Cross-workspace activation.** Each `tab.*` handler in `titles.lua`
calls `ensure_workspace_foregrounded(workspace_name)` before invoking
the mux-side activate function. The helper is a no-op when the gui's
active workspace already matches; otherwise it issues `SwitchToWorkspace
{ name = workspace_name }` on the first gui window so the user sees the
workspace they picked. The mux-side functions
(`Workspace.activate_only`, `Workspace.activate_overflow`,
`Workspace.spawn_or_activate`) themselves are workspace-agnostic — they
look up the target via `tabs.workspace_windows(workspace_name)` — so no
other change is needed for cross-workspace picks. If the target
workspace has no mux window the activate functions return false; the
user can `Alt+w` it open and re-press `Alt+x`.

**Total wezterm tab count stays at `visible_count + 1` per workspace
regardless of how many sessions the user rotates through**; the pool
is held in tmux server memory, the wezterm side is a finite porthole.

### Cold-start agent gap

`tab-overflow-cold-spawn.sh` creates a **bare bash session**, not the
managed agent (claude / codex). The agent launch command is composed
lua-side from `constants.managed_cli` and is not currently available
to the bash dispatch path; plumbing it through belongs to the warm
preheat work below. For now, after rotating into a cold session the
user runs `claude --continue` themselves — better than the previous
behavior of silently spawning a new wezterm tab outside the cap.

### Long-vacation behavior

Indexed exponential decay is order-preserving: 14 days off with no
bumps shrinks every session's dwell_ms by the same factor, so the
top-N set is identical when you return. The first focus events after
a break weigh in raw ms (uncapped) just like before; a session with a
large dwell floor stays large for many more half-lives than a session
with a small floor. New sessions can promote into top-N within a few
days of heavy use as decayed competitors fall behind. The ranking
still drives the picker's sort order even though it does not
re-shuffle the visible tabs (those are pinned to whatever `Workspace
.open` decided at cold-open).

### Pieces

| Layer | File | Role |
| --- | --- | --- |
| Brain | `wezterm-x/lua/ui/tab_visibility.lua` | top-N computation, `is_enabled` / `spawn_capped` predicates, workspace slug |
| Constants | `wezterm-x/lua/constants.lua` | `tab_visibility` config block (visible_count, enabled_workspaces, spawn_visible_only, …) |
| Spawn cap + items snapshot | `wezterm-x/lua/workspace_manager.lua` | caps `Workspace.open` via `tab_visibility.preferred_item_order` (frequency-first selection with declared-order bootstrap fallback), threads `prune_keep_items` through `sync_workspace_tabs`, writes per-workspace items snapshot at cold-open, exposes `Workspace.refresh_all_items_snapshots` for the Alt+x handler's on-demand pre-refresh, runs `Workspace.maybe_clear_overflow_collision` each tick so a promoted overflow session hands its tmux client back to the new visible tab |
| Session-name compute | `scripts/runtime/tmux-worktree/print-session-names.sh` | bulk `cwd → canonical session name` map for the workspace, single subprocess invocation; the lua side uses this to join `workspaces.lua` items against `tab-stats/<slug>.json` ranking |
| Overflow tab spawn | `wezterm-x/lua/workspace/tabs.lua` `spawn_overflow_tab` | creates the `…` tab, browse session, records tty |
| Manifest + handler | `wezterm-x/commands/manifest.json` + `wezterm-x/lua/ui/action_registry.lua` | `tab.overflow-picker` → `Alt+x`, forwards user-key 4 |
| tmux user-key | `tmux.conf` | `bind-key -n User4` runs `tab-overflow-menu.sh` |
| Picker menu | `scripts/runtime/tab-overflow-menu.sh` | enumerates every `<slug>-items.json`, marks visible/warm/cold per row, joins `tab_stats_aggregated_tsv` dwell_ms per session, sorts by `is_current desc, dwell_ms desc, raw_count desc, snap_idx asc` (dwell-time-first within and across workspaces; current workspace stays grouped on top), launches `picker overflow` in a `tmux display-popup` (falls back to `tmux display-menu` for the active workspace when the Go binary is missing) |
| Picker TUI | `native/picker/cmd_overflow.go` | reads the prefetch TSV, fuzzy-filters across workspace + label + cwd, renders the workspace-badged row list, `tmux run-shell -b` dispatches |
| Dispatch | `scripts/runtime/tab-overflow-dispatch.sh` | per-state routing (event, attach, cold-spawn) |
| switch-client | `scripts/runtime/tab-overflow-attach.sh` | `tmux switch-client -c <tty> -t <session>` |
| Cold spawn | `scripts/runtime/tab-overflow-cold-spawn.sh` | `tmux new-session -A -d` + attach |
| Event handlers | `wezterm-x/lua/titles.lua` | `tab.activate_visible` / `tab.activate_overflow` / `tab.spawn_overflow` (cold fallback) |

### Attention picker fallback

`tmux-attention-menu.sh` previously rendered `?/?/...` for any
attention entry whose `wezterm_pane_id` had no matching live wezterm
pane (capped session, archived recent row whose pane is gone, etc.).
The picker now falls back to parsing the `tmux_session` name shape
`wezterm_<workspace>_<repo_label>_<10hex>` so the row shows
`work/<repo>/...` instead of `?/?/...`.

### Unified pane→tmux_session map (drives attention focus + jumps)

`wezterm_pane_id` is mux-global and lifecycle-bound: spawn-cap
eviction, workspace close + reopen, refresh-session, and overflow
rotation all change the id without changing the session identity.
The `tmux_session` name (computed by `tmux_worktree_session_name_for_path`
from workspace + cwd) is the stable handle. Attention's render and
jump paths therefore resolve focus by **"which session does this
wezterm pane currently host?"** and match against `entry.tmux_session`,
never by the stored `wezterm_pane_id`.

`tab_visibility.lua` owns one map: `_G.__WEZTERM_PANE_TMUX_SESSION
[pane_id] = session_name`. Two storage tiers:

1. **In-memory** — `spawn_overflow_tab` populates the overflow pane
   with its initial browse session (`wezterm_<slug>_overflow`).
   `titles.lua`'s `tab.activate_overflow` event handler refreshes the
   value after each Alt+x pick (`set_pane_session(overflow_pane_id,
   target_session)`). Covers the rotating overflow pane.
2. **On-disk** — `scripts/runtime/open-project-session.sh` writes
   `<runtime_state>/state/pane-session/<wezterm_pane_id>.txt` with
   the `session_name` it just created or reused at managed-session
   creation. Covers visible managed tabs whose pane id is fixed for
   the lifetime of that wezterm tab.

Public readers in `tab_visibility.lua`:

- `session_for_pane(pane_id)` — in-memory tier, fall back to file.
- `pane_for_session(session_name)` — reverse lookup; in-memory walk,
  fall back to scanning the on-disk dir.

Consumers (all in `attention.lua`):

- `is_entry_focused(entry, focused_pane_id)` — `session_for_pane(focused_pane_id) == entry.tmux_session`, plus the existing tmux-pane-level guard for split-pane sessions.
- `activate_in_gui(pane_id_value, window, source, opts)` — when `opts.tmux_session` is set, `pane_for_session` finds the wezterm pane currently hosting it (visible tab or overflow) and that pane gets activated. Workspace switch is automatic when the target lives elsewhere. Falls back to literal `pane_id_value` when no session hint is present.
- `tab_badge(tab_info)` — active pane's hosted session selects the matching attention entry; `done` is suppressed only when `is_entry_focused` says yes.
- `forget_by_tmux_session(tmux_session)` — archive every active entry on a session into recent[]. Called by `titles.lua`'s `tab.activate_overflow` handler when the overflow slot stops hosting a session, so attention entries don't dangle past the rotation. The wezterm tab is a slot — when the slot stops hosting `prev_session`, attention follows.

**Picker payload** (Alt+/) appends the resolved session name as the
trailing v1 field: `v1|jump|<sid>|<wp>|<sock>|<win>|<pane>|<session>`
(and `v1|recent|...|<session>`). Both Go picker (`cmd_attention.go`)
and bash fallback (`tmux-attention-picker.sh`) producers resolve the
name via `tmux -S <socket> display-message -t <window> '#S'`. Lua's
`parse_jump_payload` is nil-tolerant — older payloads without the
trailing field still parse and drop into the legacy literal-pane
fallback.

### Overflow tab identity via pane user_var

Pruning / alignment-check uses `tab:active_pane():get_user_vars()
['we_tab_role'] == 'overflow'` to identify the overflow tab —
`spawn_overflow_tab` sets that user var on the placeholder pane.
Title-based detection was fragile: any code path that called
`tab:set_title` (refresh-session, user-driven rename) silently
de-classified the tab and let prune kill it. The user_var marker is
set by lua and only touched by lua, so external resets cannot drop it.

The browse session also gets a server-side tag:
`tmux set-option -t wezterm_<slug>_overflow -q @wezterm_session_role
tab_visibility_overflow_browse`. Future tooling can identify the
session deterministically without parsing the name.

Full attention render + transition rules: see
[`docs/agent-attention.md`](./agent-attention.md), particularly the
*Focus-based auto-ack* subsection's "Match by `tmux_session`" point.

## What's not done yet

- **No warm preheat layer.** A natural next step is to keep the next
  M ranks beyond `visible_count` running as detached tmux sessions
  (`tmux new-session -d -s <name> ... <managed-agent>`) so promotions
  through the picker incur ~16ms switch-client instead of ~500ms cold
  start. Requires plumbing the managed-agent launch command into bash.
- **Cold-spawn agent.** Same plumbing — once it lands, cold sessions
  picked from `Alt+x` can come up with the agent already running.
- **No automatic session lifecycle.** Sessions live as long as their
  tmux session lives. Killing detached sessions on demotion / TTL
  belongs to the warm-preheat work above.
