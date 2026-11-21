-- Verifies defaults.default_windows_runtime_helper_ipc_endpoint, which must
-- stay in lockstep with Get-ManagerPaths in
-- wezterm-x/scripts/ensure-wezdeck-runtime.ps1: live keeps the historical
-- pipe, the sync canary (…\wezterm-runtime\canary) gets its own, so the
-- canary never shares a pipe / single-instance mutex with the live helper.
--
-- Drive with scripts/dev/test-lua-units.sh.

package.path = './tests/lua-units/?.lua;./wezterm-x/lua/?.lua;./wezterm-x/lua/config/?.lua;' .. package.path

local fail_count, pass_count = 0, 0
local function it(n, fn)
  local ok, err = pcall(fn)
  if ok then
    pass_count = pass_count + 1
    io.write('  \xE2\x9C\x93 ' .. n .. '\n')
  else
    fail_count = fail_count + 1
    io.write('  \xE2\x9C\x97 ' .. n .. '\n    ' .. tostring(err) .. '\n')
  end
end
local function assert_eq(a, b, m)
  if a ~= b then error((m or '') .. ' expected=' .. tostring(b) .. ' actual=' .. tostring(a), 2) end
end

local real_getenv = os.getenv
local fake_env = { LOCALAPPDATA = 'C:\\Users\\Yuns\\AppData\\Local' }
os.getenv = function(k) if fake_env[k] ~= nil then return fake_env[k] end return real_getenv(k) end

local defaults = dofile('./wezterm-x/lua/config/defaults.lua')
local f = defaults.default_windows_runtime_helper_ipc_endpoint
local LIVE = '\\\\.\\pipe\\wezdeck-runtime-v1'

io.write('\xE2\x96\xB8 helper ipc endpoint per instance\n')

it('non-windows host has no endpoint', function()
  assert_eq(f('linux', 'C:\\x'), nil)
end)

it('live runtime dir keeps the historical pipe', function()
  assert_eq(f('windows', 'C:\\Users\\Yuns\\AppData\\Local\\wezterm-runtime'), LIVE)
end)

it('live match ignores case, slash style and trailing separator', function()
  assert_eq(f('windows', 'c:/users/yuns/appdata/local/WEZTERM-RUNTIME/'), LIVE)
end)

it('canary state dir gets its own pipe', function()
  assert_eq(f('windows', 'C:\\Users\\Yuns\\AppData\\Local\\wezterm-runtime\\canary'), LIVE .. '-canary')
end)

it('missing state dir falls back to live', function()
  assert_eq(f('windows', nil), LIVE)
end)

it('unsafe characters in the leaf are sanitized', function()
  assert_eq(f('windows', 'D:\\tmp\\My Runtime'), LIVE .. '-my_runtime')
end)

os.getenv = real_getenv
io.write(string.format('helper_ipc_endpoint: %d passed, %d failed\n', pass_count, fail_count))
if fail_count > 0 then os.exit(1) end
