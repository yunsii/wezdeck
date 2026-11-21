-- Verifies the OPPO 互联 OppoRemote· badge (wezterm-x/plugins/oppo-remote/lua/badge.lua).
--
-- Design properties that are easy to regress:
--
-- 1. Absent when no session is active (active=false) or never published.
-- 2. Visible for the whole session: `OppoRemote·OK` while healthy.
-- 3. Stalled now → crit; shows seconds when a queue-delay reading exists,
--    otherwise the 5-min stall share (encoder-dropping stalls carry no lag).
-- 4. Recovered but ≥warn_pct of the last 5 min stalled → warn with the share.
-- 5. Active session + stale producer → `OppoRemote·?`; inactive + stale → absent.
-- 6. Label is always `OppoRemote·`, whatever the client device.
--
-- Drive with scripts/dev/test-lua-units.sh.

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

local fake_now_ms = 100000
mock.time = {
  now = function()
    return setmetatable({}, {
      __index = function() return function() return tostring(fake_now_ms) end end,
    })
  end,
}

local tmpdir = os.getenv('TMPDIR') or '/tmp'
local state_path = tmpdir .. '/wezterm-oppo-remote-test-status.json'
os.remove(state_path)

-- The badge ships as a plugin module (wezterm-x/plugins/oppo-remote).
local rs = dofile './wezterm-x/plugins/oppo-remote/lua/badge.lua'
rs.configure { state_file = state_path, heartbeat_timeout_ms = 20000, warn_pct = 10 }

local function S(t)
  t.heartbeat_at_ms = t.heartbeat_at_ms or fake_now_ms
  return t
end

io.write('\xE2\x96\xB8 remote_status badge\n')

it('never published renders nothing', function()
  assert_eq(rs.render_status_segment({}), nil)
  assert_eq(rs.format_text(nil, true), nil)
end)

it('inactive session renders nothing (fresh or stale)', function()
  assert_eq(rs.format_text(S { active = false }, true), nil)
  assert_eq(rs.format_text(S { active = false }, false), nil)
end)

it('healthy active session shows OppoRemote·OK', function()
  local text, level = rs.format_text(S { active = true, state = 'ok', stall_pct_5m = 3, device = 'OPPO Pad 5 Pro' }, true)
  assert_eq(text, ' OppoRemote·OK ')
  assert_eq(level, 'ok')
end)

it('stalled with queue delay shows seconds, crit', function()
  local text, level = rs.format_text(S { active = true, state = 'stall', lag_ms = 4430, stall_pct_5m = 40 }, true)
  assert_eq(text, ' OppoRemote·4.4s ')
  assert_eq(level, 'crit')
end)

it('stalled without queue delay shows 5-min share, crit', function()
  local text, level = rs.format_text(S { active = true, state = 'stall', lag_ms = 0, stall_pct_5m = 76 }, true)
  assert_eq(text, ' OppoRemote·76% ')
  assert_eq(level, 'crit')
end)

it('recovered but rough last 5 min is warn', function()
  local text, level = rs.format_text(S { active = true, state = 'ok', stall_pct_5m = 23 }, true)
  assert_eq(text, ' OppoRemote·23% ')
  assert_eq(level, 'warn')
end)

it('active + stale producer shows OppoRemote·?', function()
  local text, level = rs.format_text(S { active = true, state = 'ok' }, false)
  assert_eq(text, ' OppoRemote·? ')
  assert_eq(level, 'unknown')
end)

it('label does not depend on the client device', function()
  local text = rs.format_text(S { active = true, state = 'ok', device = 'Find X8' }, true)
  assert_eq(text, ' OppoRemote·OK ')
end)

it('render reads the file and honours heartbeat staleness', function()
  local f = assert(io.open(state_path, 'w'))
  f:write(string.format('{"active":true,"state":"ok","stall_pct_5m":0,"heartbeat_at_ms":%d}', fake_now_ms))
  f:close()
  local palette = { tab_inactive_bg = '#111', tab_inactive_fg = '#eee', tab_bar_background = '#000', new_tab_fg = '#999' }
  local function text_of(parts)
    for _, p in ipairs(parts or {}) do
      if p.Text then return p.Text end
    end
  end
  assert_eq(text_of(rs.render_status_segment(palette)), ' OppoRemote·OK ')
  fake_now_ms = fake_now_ms + 30000
  assert_eq(text_of(rs.render_status_segment(palette)), ' OppoRemote·? ')
end)

os.remove(state_path)
io.write(string.format('remote_status: %d passed, %d failed\n', pass_count, fail_count))
if fail_count > 0 then os.exit(1) end
