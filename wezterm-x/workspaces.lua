local wezterm = require 'wezterm'
local runtime_dir = wezterm.config_dir .. '/.wezterm-x'
local constants = dofile(runtime_dir .. '/lua/constants.lua')
local helpers = dofile(runtime_dir .. '/lua/helpers.lua')

local managed_command = nil
if constants.repo_root then
  managed_command = {
    constants.repo_root .. '/scripts/runtime/run-managed-command.sh',
    'codex-github-theme',
  }
end

local public_workspaces = {
  work = {
    defaults = {
      command = managed_command,
    },
    items = {},
  },
  config = {
    defaults = {
      command = managed_command,
    },
    items = constants.repo_root and {
      { cwd = constants.repo_root },
    } or {},
  },
}

local local_workspaces = helpers.load_optional_table(runtime_dir .. '/local/workspaces.lua') or {}
for name, workspace in pairs(local_workspaces) do
  public_workspaces[name] = workspace
end

return public_workspaces
