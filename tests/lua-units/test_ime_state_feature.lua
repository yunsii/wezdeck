-- Verifies the IME-state feature caches the last good {mode, lang}
-- so a single tick of helper preflight / snapshot failure (read-vs-
-- atomic-rename race on state.env) does not flip the badge to `中?`.

package.path = './tests/lua-units/?.lua;./wezterm-x/lua/?.lua;./wezterm-x/lua/host/?.lua;./wezterm-x/lua/host/features/?.lua;' .. package.path

local mock = require 'wezterm_mock'
package.preload['wezterm'] = function() return mock end

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
local function assert_truthy(v, m)
  if not v then error(m or 'expected truthy', 2) end
end

-- Build a fake runtime where the test drives preflight + snapshot + clock.
local function make_runtime()
  local self = {
    now_ms = 0,
    preflight_ok = true,
    preflight_reason = nil,
    snapshot = nil,
    snapshot_reason = nil,
    heartbeat_timeout_seconds = 5,
  }
  function self:supports_windows_helper() return true end
  function self:current_epoch_ms() return self.now_ms end
  function self:helper_state_preflight()
    return self.preflight_ok, self.preflight_reason
  end
  function self:helper_state_snapshot()
    if not self.snapshot then return nil, self.snapshot_reason or 'state_unavailable' end
    return self.snapshot
  end
  function self:helper_integration()
    return { helper_heartbeat_timeout_seconds = self.heartbeat_timeout_seconds }
  end
  return self
end

local build_feature = dofile('./wezterm-x/lua/host/features/ime_state.lua')

io.write('\xE2\x96\xB8 ime_state feature cache\n')

it('returns the live mode on a successful read', function()
  local rt = make_runtime()
  rt.snapshot = { ime_mode = 'native', ime_lang = 'zh-CN', ime_reason = '' }
  local feat = build_feature(rt)
  local res, err = feat.query('t1')
  assert_truthy(res, 'expected result, got err=' .. tostring(err))
  assert_eq(res.mode, 'native')
  assert_eq(res.lang, 'zh-CN')
end)

it('falls back to cached state when preflight fails transiently', function()
  local rt = make_runtime()
  rt.snapshot = { ime_mode = 'native', ime_lang = 'zh-CN' }
  local feat = build_feature(rt)
  rt.now_ms = 1000
  feat.query('t-prime') -- prime cache
  rt.preflight_ok = false
  rt.preflight_reason = 'state_unavailable'
  rt.now_ms = 1100 -- 100ms later, well within 5s
  local res, err = feat.query('t2')
  assert_truthy(res, 'expected cached fallback, got err=' .. tostring(err))
  assert_eq(res.mode, 'native', 'cache must preserve previous mode')
end)

it('falls back to cached state when snapshot fails transiently', function()
  local rt = make_runtime()
  rt.snapshot = { ime_mode = 'alpha', ime_lang = 'zh-CN' }
  local feat = build_feature(rt)
  rt.now_ms = 2000
  feat.query('t-prime')
  rt.snapshot = nil
  rt.snapshot_reason = 'state_unavailable'
  rt.now_ms = 2100
  local res = feat.query('t3')
  assert_truthy(res, 'expected cached fallback')
  assert_eq(res.mode, 'alpha')
end)

it('surfaces the failure once the cache is older than the timeout', function()
  local rt = make_runtime()
  rt.snapshot = { ime_mode = 'native' }
  local feat = build_feature(rt)
  rt.now_ms = 0
  feat.query('t-prime')
  rt.preflight_ok = false
  rt.preflight_reason = 'state_stale'
  rt.now_ms = 6000 -- 6s past prime, beyond the 5s heartbeat timeout
  local res, err = feat.query('t4')
  assert_eq(res, nil, 'stale cache must not be reused')
  assert_eq(err, 'state_stale')
end)

it('still returns unsupported_runtime when there is no helper at all', function()
  local rt = make_runtime()
  function rt:supports_windows_helper() return false end
  local feat = build_feature(rt)
  local res, err = feat.query('t5')
  assert_eq(res, nil)
  assert_eq(err, 'unsupported_runtime')
end)

it('updates the cache when a fresh read reflects a real IME toggle', function()
  local rt = make_runtime()
  rt.snapshot = { ime_mode = 'native' }
  local feat = build_feature(rt)
  rt.now_ms = 0
  feat.query('t-prime')
  rt.snapshot = { ime_mode = 'alpha' }
  rt.now_ms = 50
  local res = feat.query('t6')
  assert_eq(res.mode, 'alpha', 'fresh read must replace cache')
  -- And on a subsequent transient failure, the new value sticks.
  rt.preflight_ok = false
  rt.preflight_reason = 'state_unavailable'
  rt.now_ms = 60
  local cached = feat.query('t7')
  assert_eq(cached.mode, 'alpha', 'cache must hold the latest good value')
end)

it('returns state_missing_ime when ime_mode is empty and no cache exists', function()
  local rt = make_runtime()
  rt.snapshot = { ime_mode = '' }
  local feat = build_feature(rt)
  local res, err = feat.query('t8')
  assert_eq(res, nil)
  assert_eq(err, 'state_missing_ime')
end)

io.write(string.format('ime_state feature: %d passed, %d failed\n', pass_count, fail_count))
if fail_count > 0 then os.exit(1) end
