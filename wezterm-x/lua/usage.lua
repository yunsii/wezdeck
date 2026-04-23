-- Hotkey usage counter: fire-and-forget bumps to
-- scripts/runtime/hotkey-usage-bump.sh. See that script for the JSON
-- counter file layout. This module is intentionally thin — it only
-- resolves the bump script and spawns it; no in-memory state, no logging
-- on the hot path, so a missing script or unavailable WSL distro is a
-- silent no-op.

local path_sep = package.config:sub(1, 1)
local function join_path(...)
  return table.concat({ ... }, path_sep)
end

local module_dir = join_path(rawget(_G, 'WEZTERM_RUNTIME_DIR') or '.', 'lua', 'ui')
local common = dofile(join_path(module_dir, 'common.lua'))

local M = {}

function M.new(opts)
  local wezterm = opts.wezterm
  local constants = opts.constants
  local runtime_mode = (constants and constants.runtime_mode) or 'hybrid-wsl'
  local host_os = constants and constants.host_os or 'linux'

  local repo_root = constants and constants.repo_root
  local script_path = nil
  if repo_root and repo_root ~= '' then
    script_path = repo_root .. '/scripts/runtime/hotkey-usage-bump.sh'
  end

  local wsl_distro = nil
  if runtime_mode == 'hybrid-wsl' and host_os == 'windows' then
    wsl_distro = common.wsl_distro_from_domain(constants.default_domain)
  end

  local function build_args(hotkey_id)
    if not script_path then return nil end
    if runtime_mode == 'hybrid-wsl' and host_os == 'windows' then
      if not wsl_distro then return nil end
      return { 'wsl.exe', '-d', wsl_distro, '--', 'bash', script_path, hotkey_id }
    end
    return { 'bash', script_path, hotkey_id }
  end

  local function bump(hotkey_id)
    if type(hotkey_id) ~= 'string' or hotkey_id == '' then return end
    local args = build_args(hotkey_id)
    if not args then return end
    pcall(function() wezterm.background_child_process(args) end)
  end

  return { bump = bump }
end

return M
