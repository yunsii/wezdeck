-- Verifies session_bridge_status.lua "absent while idle" contract.
--
-- 1. Never published / poller off / stale → nil (no always-on SB·-).
-- 2. Fresh poller → ◆ SB·N (including 0 jobs — watch-is-on is the signal).
-- 3. waiting_count > 0 uses the attention-waiting palette.
--
-- Drive with scripts/dev/test-lua-units.sh or: lua tests/lua-units/test_session_bridge_status.lua

package.path = './tests/lua-units/?.lua;./wezterm-x/lua/?.lua;' .. package.path

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

local fake_now_ms = 0
mock.time = {
  now = function()
    return setmetatable({}, {
      __index = function() return function() return tostring(fake_now_ms) end end,
    })
  end,
}

local tmpdir = os.getenv('TMPDIR') or '/tmp'
local state_path = tmpdir .. '/wezterm-sb-watch-test-status.json'

local function write_state(fields)
  local parts = {}
  for k, v in pairs(fields) do
    if type(v) == 'string' then
      table.insert(parts, string.format('"%s":"%s"', k, v))
    elseif type(v) == 'boolean' then
      table.insert(parts, string.format('"%s":%s', k, v and 'true' or 'false'))
    else
      table.insert(parts, string.format('"%s":%s', k, tostring(v)))
    end
  end
  local f = assert(io.open(state_path, 'w'))
  f:write('{' .. table.concat(parts, ',') .. '}')
  f:close()
end

os.remove(state_path)

package.loaded['session_bridge_status'] = nil
local sb = require 'session_bridge_status'
sb.configure {
  state_file = state_path,
  heartbeat_timeout_ms = 35000,
  icon = '\xE2\x97\x86', -- ◆
}

local palette = {
  tab_bar_background = '#000000',
  new_tab_fg = '#cccccc',
  tab_inactive_bg = '#222222',
  tab_inactive_fg = '#aaaaaa',
  tab_attention_waiting_bg = '#cc9900',
  tab_attention_waiting_fg = '#111111',
  tab_attention_running_bg = '#336699',
  tab_attention_running_fg = '#eeeeee',
}

local function badge_text()
  local parts = sb.render_status_segment(palette)
  if parts == nil then return nil end
  for _, p in ipairs(parts) do
    if p.Text then return p.Text end
  end
  return nil
end

local function badge_bg()
  local parts = sb.render_status_segment(palette)
  if parts == nil then return nil end
  for _, p in ipairs(parts) do
    if p.Background then return p.Background.Color end
  end
  return nil
end

io.write('\xE2\x96\xB8 session_bridge_status badge\n')

it('renders nothing before anything was ever published', function()
  fake_now_ms = 1000000
  assert_eq(sb.format_text(nil, false), nil)
  assert_eq(sb.render_status_segment(palette), nil)
end)

it('renders nothing when poller is off (no always-on SB·-)', function()
  fake_now_ms = 1000000
  write_state {
    poller_running = false,
    job_count = 0,
    waiting_count = 0,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), nil)
end)

it('renders nothing when heartbeat is stale even if poller_running was true', function()
  fake_now_ms = 1000000
  write_state {
    poller_running = true,
    job_count = 3,
    waiting_count = 0,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), ' \xE2\x97\x86 SB\xC2\xB73 ', 'sanity: fresh shows')
  fake_now_ms = 1000000 + 35001
  assert_eq(badge_text(), nil, 'stale watch leaves the bar clean')
end)

it('shows SB·0 while watch is on with no jobs', function()
  fake_now_ms = 2000000
  write_state {
    poller_running = true,
    job_count = 0,
    waiting_count = 0,
    heartbeat_at_ms = 2000000,
  }
  assert_eq(badge_text(), ' \xE2\x97\x86 SB\xC2\xB70 ')
  assert_eq(badge_bg(), '#222222', 'idle watch uses inactive palette')
end)

it('caps at SB·9+', function()
  fake_now_ms = 2000000
  write_state {
    poller_running = true,
    job_count = 12,
    waiting_count = 0,
    heartbeat_at_ms = 2000000,
  }
  assert_eq(badge_text(), ' \xE2\x97\x86 SB\xC2\xB79+ ')
end)

it('highlights when waiting_count > 0', function()
  fake_now_ms = 2000000
  write_state {
    poller_running = true,
    job_count = 2,
    waiting_count = 1,
    heartbeat_at_ms = 2000000,
  }
  assert_eq(badge_text(), ' \xE2\x97\x86 SB\xC2\xB72 ')
  assert_eq(badge_bg(), '#cc9900')
end)

it('icon empty string drops the glyph', function()
  sb.configure { state_file = state_path, heartbeat_timeout_ms = 35000, icon = '' }
  fake_now_ms = 2000000
  write_state {
    poller_running = true,
    job_count = 1,
    waiting_count = 0,
    heartbeat_at_ms = 2000000,
  }
  assert_eq(badge_text(), ' SB\xC2\xB71 ')
end)

io.write(string.format('session_bridge_status: %d passed, %d failed\n', pass_count, fail_count))
os.remove(state_path)
os.exit(fail_count == 0 and 0 or 1)
