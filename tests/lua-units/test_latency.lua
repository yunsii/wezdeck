-- Verifies latency.lua threshold gating and emit_all / categories rules.
-- Drive with scripts/dev/test-lua-units.sh.

package.path = './tests/lua-units/?.lua;./wezterm-x/lua/?.lua;' .. package.path

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
local function assert_true(v, m)
  if not v then error(m or 'expected true', 2) end
end
local function assert_false(v, m)
  if v then error(m or 'expected false', 2) end
end

package.loaded['latency'] = nil
local latency = require 'latency'

it('should_log_slow respects threshold inclusive', function()
  assert_false(latency.should_log_slow(49, 50))
  assert_true(latency.should_log_slow(50, 50))
  assert_true(latency.should_log_slow(120, 50))
  assert_false(latency.should_log_slow(nil, 50))
  assert_false(latency.should_log_slow(50, nil))
end)

it('config defaults match documented thresholds', function()
  local cfg = latency.config({})
  assert_eq(cfg.hotkey_slow_ms, 50)
  assert_eq(cfg.status_slow_ms, 40)
  assert_false(cfg.emit_all)
end)

it('config reads overrides and ignores empty categories for emit_all', function()
  local cfg = latency.config {
    diagnostics = {
      wezterm = {
        categories = {},
        latency = {
          hotkey_slow_ms = 30,
          status_slow_ms = 25,
          emit_all = false,
        },
      },
    },
  }
  assert_eq(cfg.hotkey_slow_ms, 30)
  assert_eq(cfg.status_slow_ms, 25)
  assert_false(cfg.emit_all)
end)

it('emit_all true when flag set', function()
  local cfg = latency.config {
    diagnostics = {
      wezterm = {
        latency = { emit_all = true },
      },
    },
  }
  assert_true(cfg.emit_all)
end)

it('emit_all true when allowlist names latency.perf', function()
  local cfg = latency.config {
    diagnostics = {
      wezterm = {
        categories = { latency = true, ['latency.perf'] = true },
        latency = { emit_all = false },
      },
    },
  }
  assert_true(cfg.emit_all)
end)

it('observe skips below threshold and emits slow event above', function()
  local calls = {}
  local logger = {
    info = function(category, message, fields)
      calls[#calls + 1] = { category = category, message = message, fields = fields }
    end,
  }
  local cfg = { hotkey_slow_ms = 50, status_slow_ms = 40, emit_all = false }

  assert_false(latency.observe(logger, cfg, {
    kind = 'hotkey',
    duration_ms = 12,
    fields = { hotkey_id = 'workspace.switch' },
  }))
  assert_eq(#calls, 0, 'no log below threshold')

  assert_true(latency.observe(logger, cfg, {
    kind = 'hotkey',
    duration_ms = 88,
    fields = { hotkey_id = 'workspace.switch' },
  }))
  assert_eq(#calls, 1)
  assert_eq(calls[1].category, 'latency')
  assert_eq(calls[1].message, 'slow key handler')
  assert_eq(calls[1].fields.duration_ms, 88)
  assert_eq(calls[1].fields.hotkey_id, 'workspace.switch')
  assert_eq(calls[1].fields.threshold_ms, 50)
end)

it('observe emits latency.perf when emit_all even if under threshold', function()
  local calls = {}
  local logger = {
    info = function(category, message, fields)
      calls[#calls + 1] = { category = category, message = message, fields = fields }
    end,
  }
  local cfg = { hotkey_slow_ms = 50, status_slow_ms = 40, emit_all = true }
  assert_false(latency.observe(logger, cfg, {
    kind = 'status',
    duration_ms = 5,
  }))
  assert_eq(#calls, 1)
  assert_eq(calls[1].category, 'latency.perf')
  assert_eq(calls[1].message, 'status tick timing')
end)

it('observe slow status uses status message and threshold', function()
  local calls = {}
  local logger = {
    info = function(category, message, fields)
      calls[#calls + 1] = { category = category, message = message, fields = fields }
    end,
  }
  local cfg = { hotkey_slow_ms = 50, status_slow_ms = 40, emit_all = false }
  assert_true(latency.observe(logger, cfg, {
    kind = 'status',
    duration_ms = 41,
  }))
  assert_eq(calls[1].message, 'slow status tick')
  assert_eq(calls[1].fields.threshold_ms, 40)
end)

io.write(string.format('latency: %d passed, %d failed\n', pass_count, fail_count))
if fail_count > 0 then os.exit(1) end
