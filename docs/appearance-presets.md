# Appearance Presets & the Frosted-Glass (WSL-Hybrid) Model

Two named window-appearance presets, switchable with one value, plus the
hard-won model for why the frosted-glass preset is wired the way it is. Read
this before touching opacity, acrylic, tmux pane/status backgrounds, or the
tab-bar colors — it exists so the transparency work does not have to be
re-derived by trial and error.

## Switching presets

Single source of truth: `WEZTERM_APPEARANCE_PRESET` in
`wezterm-x/local/shared.env`.

- `opaque` (default) — original solid look. Fully opaque window, cream tab bar,
  dim-cream inactive panes. Machines that never opt in render exactly as before.
- `frosted` — translucent window + Windows 11 acrylic blur, with a tab bar that
  dissolves into the frost.

```sh
# in wezterm-x/local/shared.env
WEZTERM_APPEARANCE_PRESET='frosted'
```

Then run `skills/wezterm-runtime-sync/scripts/sync-runtime.sh`. Opacity and
colors hot-reload; **acrylic and `front_end` only take effect on a full WezTerm
restart** (`Alt+Shift+Q` then reopen) because they are window-creation-time
attributes. There is deliberately no runtime hot-toggle — acrylic cannot be
applied without recreating the window.

To tune a preset on one machine, add an `appearance` / `palette` block to
`wezterm-x/local/constants.lua`; it deep-merges over the preset
(`base <- preset <- local`), so you can override just `window_background_opacity`
without redefining the rest.

## Where a preset is defined (two renderers, one name)

The preset **name** is the only shared value. Each layer renders that name
independently, so keep the two in lockstep when adding/renaming a preset:

| Layer | File | What it sets |
| --- | --- | --- |
| WezTerm window | `wezterm-x/lua/config/appearance-presets.lua` | `window_background_opacity`, `win32_system_backdrop`, `front_end`, and the tab-bar `palette` colors. Consumed in `constants.lua` (`base <- preset <- local`), applied in `lua/ui.lua`. |
| tmux panes/status | `scripts/runtime/render-tmux-appearance.sh` | Emits `wezterm-x/tmux/appearance.generated.conf` (gitignored) with `status-style` / `window-style` / `window-active-style` bg. `tmux.conf` loads it via `source-file -Fq`; `sync-runtime.sh` regenerates it. |

The bash renderer reads `WEZTERM_APPEARANCE_PRESET` straight from
`local/shared.env`; the Lua side reads the same key via `shared_env`. The Lua
preset module is a pure table (no `wezterm` calls) so `lua-precheck` can dofile
`constants.lua` under its mocked wezterm.

## The frosted-glass model (why it is layered)

Frosted glass on Windows 11 is **two independent mechanisms**, and **three**
opaque layers can each hide it. All must be transparent at once:

1. **WezTerm window opacity** — `window_background_opacity < 1`. This is
   WezTerm's own alpha compositing (reliable, works on the default WebGpu
   backend). It produces translucency, not blur.
2. **DWM system backdrop** — `win32_system_backdrop = 'Acrylic'`. Windows draws
   a real blurred material *behind* the window. This is the actual "frosted"
   blur. Requires Windows 11 (build 22621+).
3. **tmux pane/status background** — tmux paints every cell. An explicit
   `window-*-style bg=<hex>` fills the whole pane with an opaque color and hides
   everything above. The frosted preset uses `bg=default` on all of
   `window-style`, `window-active-style`, `status-style` so every cell inherits
   the transparent, blurred terminal background. The active pane is distinguished
   by its *border*, not its background — see *Focus differentiation* below.
4. **Tab-bar colors** — the retro tab bar (and this repo's custom
   `titles.lua` segments) paint backgrounds from `palette.tab_bar_background` /
   `tab_inactive_bg` / `tab_active_bg`. The frosted preset sets those to
   transparent (`rgba(0,0,0,0)`) so the strip, inactive tabs, and right-status
   counters dissolve into the frost; the active tab keeps a light alpha tint so
   it stays identifiable. Attention badge colors are left opaque on purpose so
   state signaling survives.

## Focus differentiation (pane border, not background)

`bg=default` on every pane makes the frosted window uniform, which erases the
focused-pane cue (`opaque` gets it from cream-vs-dim-cream backgrounds). Two hard
constraints kill every *background*-based cue under frost, so do not retry them:

- **A TUI paints its own cell background.** tmux `window-active-style bg=default`
  only styles the cells an app leaves at "default"; an app like Claude Code or
  vim paints an explicit background on its cells, which tmux passes straight
  through to WezTerm. A pane running such a TUI therefore ignores the tmux pane
  background entirely — you cannot make its interior transparent *or* tint it
  from tmux. (Plain shell panes, which leave cells at default, do follow the tmux
  pane background — that is why an empty shell pane goes transparent but a Claude
  pane does not.)
- **`text_background_opacity` is global and must be low for frost.** To let the
  acrylic blur show *through* app panes, `text_background_opacity` is low (~0.25);
  that same value makes ANY explicit fill (e.g. an inactive `bg=#eae9e1`)
  translucent too. So "app panes frosted" and "inactive panes a solid color"
  cannot both hold — they ride the same knob.

So the focus cue is the **pane border**, set in `tmux.conf` (independent of pane
background, survives the frost, works no matter what runs in the pane):

- `pane-active-border-style fg=#8c6c3e` — the focused pane gets a bright accent
  (the palette's cursor gold) frame.
- `pane-border-style fg=#e6e1d7` — inactive panes get a faint grey frame.

Caveat: pane borders only render when a window is split into ≥2 panes; a single
full-window pane has no border (and needs no cue).

## Gotchas (each cost a debugging round — do not repeat)

- **Acrylic needs a LOW opacity to be visible.** The blur is *behind* the
  window; a high `window_background_opacity` over the light background
  (`#f1f0e9`) paints too much solid color over the acrylic and it washes out to
  nothing — looking fully opaque even though it "applied". Pair acrylic with
  `window_background_opacity ≈ 0.4`; higher values progressively hide the blur.
- **"Acrylic looks fully solid" is almost always opacity too high, not acrylic
  failing.** Over the light background even `window_background_opacity = 0.4` can
  paint enough solid color to wash the blur out to nothing — it looks opaque even
  though acrylic "applied". Before blaming acrylic, confirm it *can* work:
  Windows "Transparency effects" ON (Settings → Personalization → Colors; registry
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\EnableTransparency = 1`)
  and Windows 11. Then pair acrylic with a LOW opacity (~0.2–0.3) so the blur
  shows. Diagnose by **isolating the window-transparency layer first**: a
  standalone probe with *only* `window_background_opacity` (no acrylic, no tmux)
  proves plain opacity works; a second probe adding acrylic at the *same low*
  opacity shows whether acrylic blurs. Only if the acrylic probe is still solid at
  low opacity is acrylic genuinely unavailable — then disable it per machine in
  `local/constants.lua` with `appearance = { win32_system_backdrop = false }`
  (plain opacity, no blur). Backdrop changes are window-creation-time → need a
  full WezTerm restart to apply; opacity changes hot-reload.
- **For the blur to show through an app pane, `text_background_opacity` must also
  be low.** A TUI paints its own opaque cell background; at
  `text_background_opacity = 1.0` that background covers the acrylic and the app
  pane stays solid even though the window is frosted. Set it low (matching
  `window_background_opacity`, ~0.25) so the blur shows through app panes too.
- **Do NOT set `front_end = 'OpenGL'` with acrylic.** OpenGL does not compose
  the DWM backdrop (the blur disappears). The default WebGpu backend composes it
  correctly. `front_end` exists only as an escape hatch for GPUs that render the
  default to an opaque swapchain and kill plain opacity — not for acrylic.
- **tmux is the biggest masker.** Plain opacity can work while the pane still
  looks solid because `window-active-style bg=<hex>` is painting over it. Always
  verify the tmux side is `bg=default` before blaming WezTerm.
- **`sync-runtime.sh` re-sources `tmux.conf`.** Live `tmux set -g` tweaks get
  reset on the next sync. Persist pane/status colors through the preset
  (renderer), never as ad-hoc live sets.
- **The retro tab bar does honor transparency** (via `rgba()` / 8-digit-hex
  alpha on the tab-bar colors). It is not stuck opaque.
- **Verify with a standalone window**, not just the running one:
  `wezterm-gui.exe --config-file <minimal.lua> start` renders an isolated config
  and is how the layered causes above were separated without disturbing the live
  session.

## Verification

- `scripts/dev/test-lua-units.sh` — unchanged runtime unit suites still pass.
- `sync-runtime.sh` runs `lua-precheck` (dofiles `constants.lua` incl. the
  preset merge) and regenerates `appearance.generated.conf`.
- Toggle `WEZTERM_APPEARANCE_PRESET` between `opaque`/`frosted`, sync, and
  confirm `wezterm-x/tmux/appearance.generated.conf` flips between the cream
  hexes and `bg=default`; restart WezTerm to see acrylic apply/clear.
