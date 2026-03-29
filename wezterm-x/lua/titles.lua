local wezterm = require 'wezterm'
local path_sep = package.config:sub(1, 1)

local function join_path(...)
  return table.concat({ ... }, path_sep)
end

local runtime_dir = join_path(wezterm.config_dir, '.wezterm-x')

local function load_module(name)
  return dofile(join_path(runtime_dir, 'lua', name .. '.lua'))
end

local helpers = load_module 'helpers'

local M = {}

function M.register(opts)
  local wezterm = opts.wezterm
  local mux = opts.mux
  local palette = opts.palette

  local function format_workspace_label(name)
    return wezterm.format {
      { Background = { Color = palette.tab_bar_background } },
      { Foreground = { Color = palette.tab_accent } },
      { Attribute = { Intensity = 'Bold' } },
      { Text = ' ' .. name .. ' ' },
    }
  end

  wezterm.on('format-window-title', function(tab, pane, tabs, panes, config_overrides)
    local dirs = helpers.unique_dirs_from_panes(panes)
    if #dirs == 0 then
      return tab.active_pane.title
    end

    return '📂 ' .. table.concat(dirs, ' | ')
  end)

  wezterm.on('format-tab-title', function(tab, tabs, panes, config_overrides, hover, max_width)
    local title
    if tab.tab_title and tab.tab_title ~= '' then
      local pane_count = 0
      local mux_tab = mux.get_tab(tab.tab_id)
      if mux_tab then
        pane_count = #mux_tab:panes_with_info()
      end

      local summary = tab.tab_title
      if pane_count > 1 then
        summary = summary .. ' +' .. (pane_count - 1)
      end

      title = summary
    else
      local mux_tab = mux.get_tab(tab.tab_id)
      local dirs = mux_tab and helpers.unique_dirs_from_panes(mux_tab:panes_with_info()) or {}

      if #dirs > 0 then
        title = helpers.summarize_dirs(dirs, math.max(max_width - 2, 1))
      else
        title = tab.active_pane.title
      end
    end

    title = wezterm.truncate_right(title, math.max(max_width - 2, 1))

    local bg = palette.tab_inactive_bg
    local fg = palette.tab_inactive_fg

    if tab.is_active then
      bg = palette.tab_active_bg
      fg = palette.tab_active_fg
    elseif hover then
      bg = palette.tab_hover_bg
      fg = palette.tab_hover_fg
    end

    return {
      { Background = { Color = bg } },
      { Foreground = { Color = fg } },
      { Attribute = { Intensity = tab.is_active and 'Bold' or 'Normal' } },
      { Text = ' ' .. title .. ' ' },
    }
  end)

  wezterm.on('update-status', function(window, pane)
    local overrides = window:get_config_overrides()
    if overrides and next(overrides) ~= nil then
      window:set_config_overrides({})
      return
    end

    local workspace = window:active_workspace() or 'default'
    window:set_left_status(format_workspace_label(workspace))
    window:set_right_status ''
  end)
end

return M
