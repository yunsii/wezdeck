local wezterm = require 'wezterm'
local path_sep = package.config:sub(1, 1)

local function join_path(...)
  return table.concat({ ... }, path_sep)
end

local function apply_runtime_globals(spec)
  _G.WEZTERM_RUNTIME_RELEASE_ID = spec.release_id
  _G.WEZTERM_RUNTIME_RELEASE_ROOT = spec.release_root
  _G.WEZTERM_RUNTIME_DIR = spec.runtime_dir
  _G.WEZTERM_RUNTIME_STATE_DIR = spec.state_dir
end

local function runtime_spec(config_dir)
  local runtime_dir = join_path(config_dir, '.wezterm-x')
  return {
    release_id = 'stable',
    release_root = config_dir,
    runtime_dir = runtime_dir,
    state_dir = join_path(config_dir, '.wezterm-runtime'),
  }
end

local config_dir = wezterm.config_dir
local release_spec = runtime_spec(config_dir)
apply_runtime_globals(release_spec)

return dofile(join_path(release_spec.runtime_dir, 'runtime-entry.lua'))
