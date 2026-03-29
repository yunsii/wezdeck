local wezterm = require 'wezterm'
local path_sep = package.config:sub(1, 1)

local function join_path(...)
  return table.concat({ ... }, path_sep)
end

local runtime_dir = join_path(wezterm.config_dir, '.wezterm-x')
local constants = dofile(join_path(runtime_dir, 'lua', 'constants.lua'))
local helpers = dofile(join_path(runtime_dir, 'lua', 'helpers.lua'))

local managed_launcher = nil
if constants.managed_cli and constants.managed_cli.default_profile then
  managed_launcher = constants.managed_cli.default_profile
end

local public_workspaces = {
  work = {
    defaults = {
      launcher = managed_launcher,
    },
    items = {},
  },
  config = {
    defaults = {
      launcher = managed_launcher,
    },
    items = constants.main_repo_root and {
      { cwd = constants.main_repo_root },
    } or {},
  },
}

local local_workspaces = helpers.load_optional_table(join_path(runtime_dir, 'local', 'workspaces.lua')) or {}
for name, workspace in pairs(local_workspaces) do
  public_workspaces[name] = workspace
end

return public_workspaces
