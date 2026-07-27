-- Verifies the guest memory-pressure badge in mem_status.lua.
--
-- Three properties carry the design, and all three are easy to regress:
--
-- 1. The badge is absent while healthy. Its presence *is* the signal, so
--    rendering an empty segment or an always-on number defeats the point.
--    Two exceptions that must keep rendering: a stale recorder (the monitor
--    itself is what needs attention) and a reading with no usable percent.
-- 2. It reports whichever of memory / swap is worse. Through the 2026-07-26
--    livelock memory read a calm 88% for four hours while swap drained to
--    zero, and it was the swap exhaustion that ended the distro. A
--    memory-only badge would have understated it the entire time.
-- 3. A machine that never published anything renders nothing, so installing
--    the badge without the guard does not leave a permanent `?` in the bar.
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

-- Override wezterm.time.now() so the test can drive the staleness clock.
local fake_now_ms = 0
mock.time = {
  now = function()
    return setmetatable({}, {
      __index = function() return function() return tostring(fake_now_ms) end end,
    })
  end,
}

local tmpdir = os.getenv('TMPDIR') or '/tmp'
local state_path = tmpdir .. '/wezterm-oom-guard-test-status.json'

local function write_state(fields)
  local parts = {}
  for k, v in pairs(fields) do
    if type(v) == 'string' then
      table.insert(parts, string.format('"%s":"%s"', k, v))
    else
      table.insert(parts, string.format('"%s":%s', k, tostring(v)))
    end
  end
  local f = assert(io.open(state_path, 'w'))
  f:write('{' .. table.concat(parts, ',') .. '}')
  f:close()
end

os.remove(state_path)

package.loaded['mem_status'] = nil
local mem_status = require 'mem_status'
mem_status.configure {
  state_file = state_path,
  heartbeat_timeout_ms = 90000,
}

local palette = {
  tab_bar_background = '#000000',
  new_tab_fg = '#cccccc',
  tab_inactive_bg = '#222222',
  tab_inactive_fg = '#aaaaaa',
  tab_attention_waiting_bg = '#cc9900',
  tab_attention_waiting_fg = '#111111',
  disk_crit_bg = '#b4574b',
  disk_crit_fg = '#fbf1ef',
}

local function badge_text()
  local parts = mem_status.render_status_segment(palette)
  if parts == nil then return nil end
  for _, p in ipairs(parts) do
    if p.Text then return p.Text end
  end
  return nil
end

local function badge_bg()
  local parts = mem_status.render_status_segment(palette)
  if parts == nil then return nil end
  for _, p in ipairs(parts) do
    if p.Background then return p.Background.Color end
  end
  return nil
end

io.write('\xE2\x96\xB8 mem_status badge\n')

it('renders nothing before anything was ever published', function()
  fake_now_ms = 1000000
  assert_eq(mem_status.format_text(nil, false), nil,
    'a machine without the guard must keep a clean bar')
end)

it('renders nothing at all while healthy', function()
  fake_now_ms = 1000000
  write_state {
    level = 'ok',
    mem_used_pct = 42,
    swap_used_pct = 3,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), nil, 'a healthy guest must not occupy the bar')
  assert_eq(mem_status.render_status_segment(palette), nil, 'segment must be nil, not empty')
end)

it('appears at warn with the amber pair', function()
  fake_now_ms = 1000000
  write_state {
    level = 'warn',
    mem_used_pct = 88,
    swap_used_pct = 20,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), ' M\xC2\xB788% ')
  assert_eq(badge_bg(), '#cc9900', 'warn uses the attention-waiting color')
end)

it('goes red at crit', function()
  fake_now_ms = 1000000
  write_state {
    level = 'crit',
    mem_used_pct = 94,
    swap_used_pct = 30,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), ' M\xC2\xB794% ')
  assert_eq(badge_bg(), '#b4574b', 'crit falls back to the disk-crit red')
end)

-- The 2026-07-26 shape: memory looks survivable, swap is the thing about to
-- end the distro. Reporting the memory number here would have been honest and
-- useless.
it('reports swap when swap is the worse axis', function()
  fake_now_ms = 1000000
  write_state {
    level = 'crit',
    mem_used_pct = 88,
    swap_used_pct = 100,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), ' S\xC2\xB7100% ', 'the dominant axis carries the badge')
end)

it('prefers memory on a tie, since that is the actionable number', function()
  fake_now_ms = 1000000
  write_state {
    level = 'warn',
    mem_used_pct = 86,
    swap_used_pct = 86,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), ' M\xC2\xB786% ')
end)

it('stays absent on a swapless guest, where swap 0% is not a signal', function()
  fake_now_ms = 1000000
  write_state {
    level = 'ok',
    mem_used_pct = 50,
    swap_used_pct = 0,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), nil)
end)

it('falls back to ? when the level is bad but no percent parsed', function()
  fake_now_ms = 1000000
  write_state {
    level = 'warn',
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), ' M\xC2\xB7? ')
end)

-- A recorder that stopped publishing is itself the problem, so this one case
-- must render even though every other healthy path renders nothing.
it('shows ? and goes italic once the recorder goes stale', function()
  fake_now_ms = 1000000
  write_state {
    level = 'ok',
    mem_used_pct = 42,
    swap_used_pct = 3,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), nil, 'sanity: fresh and healthy renders nothing')

  fake_now_ms = 1000000 + 90001
  assert_eq(badge_text(), ' M\xC2\xB7? ', 'a dead recorder must surface even at level ok')
  assert_eq(badge_bg(), '#000000', 'stale uses the bar background, not an alert color')
end)

it('recovers to absent once the recorder publishes again', function()
  fake_now_ms = 2000000
  write_state {
    level = 'ok',
    mem_used_pct = 42,
    swap_used_pct = 3,
    heartbeat_at_ms = 2000000,
  }
  assert_eq(badge_text(), nil)
end)

io.write(string.format('mem_status: %d passed, %d failed\n', pass_count, fail_count))
os.remove(state_path)
os.exit(fail_count == 0 and 0 or 1)
