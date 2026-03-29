local wezterm = require 'wezterm'
local config = wezterm.config_builder()
local runtime_dir = wezterm.home_dir .. '/.wezterm-x'

local function load_module(name)
  return dofile(runtime_dir .. '/lua/' .. name .. '.lua')
end

local constants = load_module 'constants'
local titles = load_module 'titles'
local ui = load_module 'ui'
local workspace_manager = load_module 'workspace_manager'

config.debug_key_events = constants.diagnostics
  and constants.diagnostics.wezterm
  and constants.diagnostics.wezterm.debug_key_events == true
  or false

local workspace = workspace_manager.new {
  wezterm = wezterm,
  config = config,
  constants = constants,
}

titles.register {
  wezterm = wezterm,
  mux = wezterm.mux,
  palette = constants.palette,
}

ui.apply {
  wezterm = wezterm,
  config = config,
  constants = constants,
  workspace = workspace,
}

return config
