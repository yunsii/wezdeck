local wezterm = require 'wezterm'
local runtime_dir = wezterm.config_dir .. '/.wezterm-x'
local helpers = dofile(runtime_dir .. '/lua/helpers.lua')

local function read_repo_root_override()
  local override_path = runtime_dir .. '/repo-root.txt'
  local file = io.open(override_path, 'r')
  if not file then
    return nil
  end
  local value = file:read('*l')
  file:close()
  if value and value ~= '' then
    return value
  end
  return nil
end

local local_constants = helpers.load_optional_table(runtime_dir .. '/local/constants.lua') or {}

local base_constants = {
  repo_root = nil,
  default_domain = nil,
  windows_cmd = 'cmd.exe',
  windows_powershell = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  windows_runtime_dir = wezterm.home_dir .. '\\.wezterm-x',
  fonts = {
    terminal = wezterm.font 'Fira Code Retina',
    window = wezterm.font { family = 'Segoe UI', weight = 'Bold' },
  },
  palette = {
    background = '#f1f0e9',
    foreground = '#393a34',
    cursor_bg = '#8c6c3e',
    cursor_fg = '#f8f5ee',
    cursor_border = '#8c6c3e',
    selection_bg = '#e6e0d4',
    selection_fg = '#2f302c',
    scrollbar_thumb = '#d8d3c9',
    split = '#e3ded3',
    ansi = {
      '#393a34',
      '#ab5959',
      '#5f8f62',
      '#b07d48',
      '#4d699b',
      '#7e5d99',
      '#4c8b8b',
      '#d7d1c6',
    },
    brights = {
      '#6f706a',
      '#c96b6b',
      '#73a56e',
      '#c7925b',
      '#6b86b7',
      '#9a79b4',
      '#68a5a5',
      '#f6f3eb',
    },
    tab_bar_background = '#f1f0e9',
    tab_inactive_bg = '#f1f0e9',
    tab_inactive_fg = '#6f685f',
    tab_hover_bg = '#e2dbcd',
    tab_hover_fg = '#2f302c',
    tab_active_bg = '#d2c5ae',
    tab_active_fg = '#221f1a',
    new_tab_bg = '#f1f0e9',
    new_tab_fg = '#908b83',
    new_tab_hover_bg = '#e2dbcd',
    new_tab_hover_fg = '#2f302c',
    tab_edge = '#ddd8cd',
    tab_accent = '#b07d48',
  },
  launch_menu = {
    {
      label = 'Windows PowerShell',
      args = { 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', '-NoLogo' },
      domain = { DomainName = 'local' },
    },
  },
  chrome_debug_browser = {
    executable = 'chrome.exe',
    remote_debugging_port = 9222,
    user_data_dir = nil,
  },
  diagnostics = {
    wezterm = {
      enabled = false,
      level = 'info',
      file = wezterm.home_dir .. '\\.wezterm-x\\wezterm-debug.log',
      debug_key_events = false,
      categories = {},
    },
  },
}

local constants = helpers.deep_merge(base_constants, local_constants)
constants.repo_root = read_repo_root_override() or constants.repo_root

return constants
