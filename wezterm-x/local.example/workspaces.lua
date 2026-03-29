local wezterm = require 'wezterm'
local runtime_dir = wezterm.config_dir .. '/.wezterm-x'
local constants = dofile(runtime_dir .. '/lua/constants.lua')

local managed_command = nil
if constants.repo_root then
  managed_command = {
    constants.repo_root .. '/scripts/runtime/run-managed-command.sh',
    'codex-github-theme',
  }
end

return {
  work = {
    defaults = {
      command = managed_command,
    },
    items = {
      { cwd = '/home/your-user/work/project-a' },
      { cwd = '/home/your-user/work/project-b' },
      { cwd = '/home/your-user/work/project-c', command = { 'bash' } },
    },
  },
}
