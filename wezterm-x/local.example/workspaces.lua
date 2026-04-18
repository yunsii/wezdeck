local wezterm = require 'wezterm'
local path_sep = package.config:sub(1, 1)

local function join_path(...)
  return table.concat({ ... }, path_sep)
end

local runtime_dir = rawget(_G, 'WEZTERM_RUNTIME_DIR')
if not runtime_dir or runtime_dir == '' then
  runtime_dir = join_path(wezterm.config_dir, '.wezterm-x')
end
local constants = dofile(join_path(runtime_dir, 'lua', 'constants.lua'))

local managed_launcher = nil
if constants.managed_cli and constants.managed_cli.default_profile then
  managed_launcher = constants.managed_cli.default_profile
end

return {
  work = {
    defaults = {
      launcher = managed_launcher,
    },
    items = {
      { cwd = '/home/your-user/work/project-a' },
      { cwd = '/home/your-user/work/project-b' },
      { cwd = '/home/your-user/work/project-c', command = { 'bash' } },
    },
  },
}
