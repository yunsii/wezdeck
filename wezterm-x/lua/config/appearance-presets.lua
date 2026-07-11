-- appearance-presets.lua
--
-- Named appearance presets shared by two rendering layers:
--   * WezTerm window side (this file) — consumed in lua/constants.lua, which
--     merges the selected preset's `appearance` + `palette` over the base
--     defaults (base <- preset <- local/constants.lua, so a machine can still
--     override individual values locally).
--   * tmux pane/status side — scripts/runtime/render-tmux-appearance.sh emits
--     wezterm-x/tmux/appearance.generated.conf for the SAME preset name.
--
-- The single source of truth for which preset is active is
-- `WEZTERM_APPEARANCE_PRESET` in wezterm-x/local/shared.env (read by both the
-- Lua side here and the bash renderer). Keep the two renderers in lockstep:
-- when you add/rename a preset here, update render-tmux-appearance.sh too.
--
-- Pure table module (no `wezterm` calls) so lua-precheck's mocked wezterm can
-- still dofile constants.lua. Full model + rationale: docs/appearance-presets.md.

local M = {}

-- Default when shared.env does not set WEZTERM_APPEARANCE_PRESET. 'opaque'
-- reproduces the pre-transparency look, so machines that never opt in render
-- exactly as before.
M.default = 'opaque'

M.presets = {
  -- Original solid look: fully opaque window, opaque cream tab bar.
  opaque = {
    appearance = {
      window_background_opacity = 1.0,
      text_background_opacity = 1.0,
      win32_system_backdrop = nil,
      front_end = nil,
    },
    palette = {
      tab_bar_background = '#f1f0e9',
      tab_inactive_bg = '#f1f0e9',
      tab_active_bg = '#d2c5ae',
      tab_hover_bg = '#e2dbcd',
    },
  },

  -- Frosted glass: translucent window + Windows 11 acrylic blur, with a
  -- tab bar that dissolves into the frost. Requires the tmux side to use
  -- bg=default (render-tmux-appearance.sh handles that for this preset).
  -- Acrylic only shows at a LOW window_background_opacity over the light
  -- background; do NOT set front_end (OpenGL does not compose the acrylic).
  frosted = {
    appearance = {
      window_background_opacity = 0.4,
      text_background_opacity = 1.0,
      win32_system_backdrop = 'Acrylic',
      front_end = nil,
    },
    palette = {
      -- strip / inactive tab / right-status segments dissolve into the frost;
      -- active tab keeps a light alpha tint so it stays identifiable.
      tab_bar_background = 'rgba(0,0,0,0)',
      tab_inactive_bg = 'rgba(0,0,0,0)',
      tab_active_bg = 'rgba(210,197,174,0.55)',
      tab_hover_bg = 'rgba(210,197,174,0.18)',
    },
  },
}

function M.resolve(name)
  if name and M.presets[name] then
    return M.presets[name], name
  end
  return M.presets[M.default], M.default
end

return M
