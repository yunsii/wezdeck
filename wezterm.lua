local wezterm = require 'wezterm'
local path_sep = package.config:sub(1, 1)

local function join_path(...)
  return table.concat({ ... }, path_sep)
end

local function read_current_release_spec(config_dir)
  local runtime_state_dir = join_path(config_dir, '.wezterm-runtime')
  local current_path = join_path(runtime_state_dir, 'current.lua')
  local file = io.open(current_path, 'r')
  if not file then
    return nil
  end
  file:close()

  local ok, value = pcall(dofile, current_path)
  if not ok or type(value) ~= 'table' then
    return nil
  end

  if type(value.runtime_dir) ~= 'string' or value.runtime_dir == '' then
    return nil
  end

  value.state_dir = value.state_dir or runtime_state_dir
  return value
end

local function apply_runtime_globals(spec)
  _G.WEZTERM_RUNTIME_RELEASE_ID = spec.release_id
  _G.WEZTERM_RUNTIME_RELEASE_ROOT = spec.release_root
  _G.WEZTERM_RUNTIME_DIR = spec.runtime_dir
  _G.WEZTERM_RUNTIME_STATE_DIR = spec.state_dir
end

local function legacy_runtime_spec(config_dir)
  local runtime_dir = join_path(config_dir, '.wezterm-x')
  return {
    release_id = 'legacy',
    release_root = config_dir,
    runtime_dir = runtime_dir,
    state_dir = join_path(config_dir, '.wezterm-runtime'),
  }
end

local config_dir = wezterm.config_dir
local release_spec = read_current_release_spec(config_dir) or legacy_runtime_spec(config_dir)
apply_runtime_globals(release_spec)

return dofile(join_path(release_spec.runtime_dir, 'runtime-entry.lua'))
