#!/usr/bin/env lua5.4
-- Probe the synced wezterm-x runtime by mocking wezterm so constants.lua
-- can be loaded outside wezterm.exe. Exits non-zero with a diagnostic
-- snapshot on failure, so sync aborts before launching wezterm and tmux.

local function fail(reason, extra)
  io.stderr:write('[lua-precheck] FAIL: ' .. reason .. '\n')
  if extra then io.stderr:write(extra .. '\n') end
  os.exit(2)
end

local target_runtime_dir = arg[1]
if not target_runtime_dir or target_runtime_dir == '' then
  fail('missing target_runtime_dir argument')
end

local function noop() return {} end
local mock = setmetatable({
  config_dir = target_runtime_dir,
  target_triple = 'x86_64-pc-windows-msvc',
  GLOBAL = {},
  log_info = function() end,
  log_warn = function() end,
  log_error = function() end,
  font = noop,
  font_with_fallback = noop,
  color_scheme = noop,
  format = noop,
  on = function() end,
  gui = {},
  mux = {},
  plugin = {},
  action = setmetatable({}, { __index = function() return noop end }),
}, { __index = function() return noop end })
package.preload['wezterm'] = function() return mock end
_G.WEZTERM_RUNTIME_DIR = target_runtime_dir

local constants_path = target_runtime_dir .. '/lua/constants.lua'
local ok, c = pcall(dofile, constants_path)
if not ok then
  fail('failed to dofile ' .. constants_path, tostring(c))
end

local mc = c.managed_cli or {}
local profiles = mc.profiles or {}

local function profile_names()
  local names = {}
  for k in pairs(profiles) do names[#names + 1] = k end
  table.sort(names)
  return table.concat(names, ', ')
end

if not mc.default_profile or mc.default_profile == '' then
  fail('managed_cli.default_profile is empty', 'profiles=[' .. profile_names() .. ']')
end

local base = profiles[mc.default_profile]
if not base or not base.command or #base.command == 0 then
  fail('default_profile "' .. mc.default_profile .. '" has no command',
    'profiles=[' .. profile_names() .. ']')
end

if not mc.default_resume_profile or mc.default_resume_profile == '' then
  fail('managed_cli.default_resume_profile is empty',
    'profiles=[' .. profile_names() .. ']')
end

if mc.default_resume_profile == mc.default_profile then
  fail('default_resume_profile fell back to bare default_profile "' .. mc.default_profile ..
    '" — the <base>_resume profile registration was lost. ' ..
    'Likely cause: repo-side worktree-task.env was not reachable from wezterm-x ' ..
    '(check repo-worktree-task.env in the runtime dir and constants.lua loader).',
    'profiles=[' .. profile_names() .. ']')
end

local resume = profiles[mc.default_resume_profile]
if not resume or not resume.command or #resume.command == 0 then
  fail('default_resume_profile "' .. mc.default_resume_profile .. '" has no command',
    'profiles=[' .. profile_names() .. ']')
end

local joined = table.concat(resume.command, ' ')
-- Sentinels accepted (any of):
--   • `--continue` / `resume`  — the literal CLI flags used by older
--     resume-command strings written directly into worktree-task.env
--     (`sh -c 'claude --continue || exec claude'`, etc.).
--   • `agent-launcher.sh`      — the canonical entrypoint that wraps
--     resume-or-fresh logic and runtime-env loading. After the launcher
--     refactor, the resume command exposed to lua is just
--     `<repo>/scripts/runtime/agent-launcher.sh <profile>`; the
--     `--continue` / `resume` literals live inside the launcher and are
--     no longer visible at this layer. Treat the launcher path as
--     sufficient evidence that the resume profile is wired up.
local sentinel = joined:find('%-%-continue')
  or joined:find('resume')
  or joined:find('agent%-launcher%.sh')
if not sentinel then
  fail('default_resume_profile command does not look like a resume command',
    'command="' .. joined .. '"')
end

io.stdout:write('[lua-precheck] ok default_resume_profile=' .. mc.default_resume_profile ..
  ' command="' .. joined .. '" profiles=[' .. profile_names() .. ']\n')
