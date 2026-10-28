-- Verifies the guest CPU-load badge in load_status.lua.
--
-- Design properties that are easy to regress:
--
-- 1. Absent while healthy (loadavg_1 below warn). Presence is the signal.
-- 2. Classifies from loadavg_1 alone — ignores mem `level`, so a CPU storm
--    with mem ok still lights the bar (2026-10-28 shape).
-- 3. Stale heartbeat stays silent here; M· owns "recorder died" for the
--    shared status.json so the bar does not grow a duplicate `?`.
-- 4. Never-published machine renders nothing.
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

local fake_now_ms = 0
mock.time = {
  now = function()
    return setmetatable({}, {
      __index = function() return function() return tostring(fake_now_ms) end end,
    })
  end,
}

local tmpdir = os.getenv('TMPDIR') or '/tmp'
local state_path = tmpdir .. '/wezterm-load-guard-test-status.json'

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

package.loaded['load_status'] = nil
local load_status = require 'load_status'
load_status.configure {
  state_file = state_path,
  heartbeat_timeout_ms = 90000,
  warn_loadavg_1 = 8,
  crit_loadavg_1 = 16,
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
  local parts = load_status.render_status_segment(palette)
  if parts == nil then return nil end
  for _, p in ipairs(parts) do
    if p.Text then return p.Text end
  end
  return nil
end

local function badge_bg()
  local parts = load_status.render_status_segment(palette)
  if parts == nil then return nil end
  for _, p in ipairs(parts) do
    if p.Background then return p.Background.Color end
  end
  return nil
end

io.write('\xE2\x96\xB8 load_status badge\n')

it('renders nothing before anything was ever published', function()
  fake_now_ms = 1000000
  assert_eq(load_status.format_text(nil, false), nil)
end)

it('renders nothing while load is calm, even if mem level is warn', function()
  fake_now_ms = 1000000
  write_state {
    level = 'warn',
    mem_used_pct = 88,
    loadavg_1 = 1.4,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), nil, 'CPU badge must ignore mem level')
  assert_eq(load_status.render_status_segment(palette), nil)
end)

it('appears at warn with the amber pair', function()
  fake_now_ms = 1000000
  write_state {
    level = 'ok',
    mem_used_pct = 30,
    loadavg_1 = 8.2,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), ' L\xC2\xB78 ')
  assert_eq(badge_bg(), '#cc9900')
end)

it('goes red at crit (2026-10-28 storm shape)', function()
  fake_now_ms = 1000000
  write_state {
    level = 'ok',
    mem_used_pct = 33,
    loadavg_1 = 23.1,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), ' L\xC2\xB723 ')
  assert_eq(badge_bg(), '#b4574b')
end)

it('rounds loadavg for the badge text', function()
  fake_now_ms = 1000000
  write_state {
    level = 'ok',
    loadavg_1 = 15.6,
    heartbeat_at_ms = 1000000,
  }
  -- 15.6 rounds to 16, which is also the default crit gate
  assert_eq(badge_text(), ' L\xC2\xB716 ')
  assert_eq(load_status.classify_load(15.6), 'warn')
end)

it('classify_load respects configured gates', function()
  assert_eq(load_status.classify_load(7.9), 'ok')
  assert_eq(load_status.classify_load(8), 'warn')
  assert_eq(load_status.classify_load(16), 'crit')
  assert_eq(load_status.classify_load(nil), 'ok')
end)

it('stays silent when the shared recorder goes stale', function()
  fake_now_ms = 1000000
  write_state {
    level = 'ok',
    loadavg_1 = 22,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), ' L\xC2\xB722 ', 'sanity: fresh storm renders')

  fake_now_ms = 1000000 + 90001
  assert_eq(badge_text(), nil, 'stale is M· territory, not a second ?')
end)

it('recovers once the recorder publishes a calm sample', function()
  fake_now_ms = 2000000
  write_state {
    level = 'ok',
    loadavg_1 = 1.2,
    heartbeat_at_ms = 2000000,
  }
  assert_eq(badge_text(), nil)
end)

io.write(string.format('load_status: %d passed, %d failed\n', pass_count, fail_count))
os.remove(state_path)
os.exit(fail_count == 0 and 0 or 1)
