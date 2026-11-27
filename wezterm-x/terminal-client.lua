local wezterm = require 'wezterm'
local config = wezterm.config_builder()

config.enable_tab_bar = false
config.exit_behavior = 'CloseOnCleanExit'
config.window_background_opacity = 1.0

return config
