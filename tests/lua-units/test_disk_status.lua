-- Verifies the host-disk badge in disk_status.lua.
--
-- Two properties carry the design, and both are easy to regress into a
-- permanently-lit status bar:
--
-- 1. The badge is absent while healthy. Its presence *is* the signal, so
--    rendering an empty segment or an always-on number defeats the point.
--    Two exceptions that must keep rendering: a stale sampler (the monitor
--    itself is what needs attention) and missing headroom.
-- 2. It shows headroom — host avail plus the reusable gap inside the vhdx —
--    because that is the only number answering "how much more can the distro
--    write". Neither `df` does: the guest reports the vhdx's virtual
--    capacity, the host reports only unclaimed space. The gap itself never
--    surfaces; on a dedicated WSL volume it is reserve, not waste.
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
local state_path = tmpdir .. '/wezterm-disk-guard-test-status.json'

local GiB = 1073741824

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

package.loaded['disk_status'] = nil
disk_status = require "disk_status"
disk_status.configure {
  state_file = state_path,
  heartbeat_timeout_ms = 780000,
}

local palette = {
  tab_bar_background = '#000000',
  new_tab_fg = '#cccccc',
  tab_inactive_bg = '#222222',
  tab_inactive_fg = '#aaaaaa',
  tab_attention_running_bg = '#0000cc',
  tab_attention_running_fg = '#ffffff',
  tab_attention_waiting_bg = '#cc9900',
  tab_attention_waiting_fg = '#111111',
  disk_crit_bg = '#b4574b',
  disk_crit_fg = '#fbf1ef',
}

local function badge_text()
  local parts = disk_status.render_status_segment(palette)
  if parts == nil then return nil end
  for _, p in ipairs(parts) do
    if p.Text then return p.Text end
  end
  return nil
end

local function badge_bg()
  local parts = disk_status.render_status_segment(palette)
  if parts == nil then return nil end
  for _, p in ipairs(parts) do
    if p.Background then return p.Background.Color end
  end
  return nil
end

io.write('\xE2\x96\xB8 disk_status badge\n')

it('renders nothing at all while healthy', function()
  fake_now_ms = 1000000
  write_state {
    level = 'ok',
    host_mount = '/mnt/d',
    host_avail_bytes = 25 * GiB,
    gap_bytes = 126 * GiB,
    headroom_bytes = 151 * GiB,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), nil, 'a healthy disk must not occupy the bar')
  assert_eq(disk_status.render_status_segment(palette), nil, 'segment must be nil, not empty')
end)

it('stays absent even with a huge gap, since gap is reserve not a problem', function()
  fake_now_ms = 1000000
  write_state {
    level = 'ok',
    host_mount = '/mnt/d',
    host_avail_bytes = 1 * GiB,
    gap_bytes = 200 * GiB,
    headroom_bytes = 201 * GiB,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), nil)
end)

it('appears at warn with the amber pair', function()
  fake_now_ms = 1000000
  write_state {
    level = 'warn',
    host_mount = '/mnt/d',
    host_avail_bytes = 8 * GiB,
    gap_bytes = 10 * GiB,
    headroom_bytes = 22 * GiB,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), ' D\xC2\xB722G ')
  assert_eq(badge_bg(), '#cc9900', 'warn uses the attention-waiting color')
end)

it('shows headroom, not host avail, once it does appear', function()
  fake_now_ms = 1000000
  write_state {
    level = 'warn',
    host_mount = '/mnt/d',
    host_avail_bytes = 2 * GiB,
    gap_bytes = 20 * GiB,
    headroom_bytes = 22 * GiB,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), ' D\xC2\xB722G ', 'the number is the sum, not host avail')
end)

it('crit level uses its own red, not the attention amber', function()
  fake_now_ms = 1000000
  write_state {
    level = 'crit',
    host_mount = '/mnt/d',
    host_avail_bytes = 4 * GiB,
    gap_bytes = 7 * GiB,
    headroom_bytes = 11 * GiB,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), ' D\xC2\xB711G ')
  assert_eq(badge_bg(), '#b4574b', 'crit must be visually distinct from waiting')
end)

it('crit falls back to the amber pair when a palette omits disk_crit_*', function()
  fake_now_ms = 1000000
  write_state {
    level = 'crit',
    host_mount = '/mnt/d',
    headroom_bytes = 11 * GiB,
    heartbeat_at_ms = 1000000,
  }
  local minimal = {}
  for k, v in pairs(palette) do minimal[k] = v end
  minimal.disk_crit_bg = nil
  minimal.disk_crit_fg = nil
  local parts = disk_status.render_status_segment(minimal)
  local bg
  for _, p in ipairs(parts) do
    if p.Background then bg = p.Background.Color end
  end
  assert_eq(bg, '#cc9900', 'a preset without disk_crit_* must still render')
end)

it('a stale sampler surfaces even though the last level was ok', function()
  fake_now_ms = 1000000
  write_state {
    level = 'ok',
    host_mount = '/mnt/d',
    headroom_bytes = 120 * GiB,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), nil, 'sanity: healthy and fresh is invisible')
  fake_now_ms = 1000000 + 780001 -- one ms past the timeout
  assert_eq(badge_text(), ' D\xC2\xB7? ',
    'a dead monitor is itself actionable, so silence would hide the failure')
end)

it('never-published renders nothing, so an uninstalled guard is invisible', function()
  package.loaded['disk_status'] = nil
  local fresh_module = require 'disk_status'
  fresh_module.configure { state_file = tmpdir .. '/wezterm-disk-guard-absent.json' }
  assert_eq(fresh_module.render_status_segment(palette), nil)
  -- Restore the suite's module instance and its state path.
  package.loaded['disk_status'] = nil
  disk_status = require 'disk_status'
  disk_status.configure { state_file = state_path, heartbeat_timeout_ms = 780000 }
end)

it('non-drive mount falls back to a neutral label', function()
  fake_now_ms = 1000000
  write_state {
    level = 'warn',
    host_mount = '/some/other/path',
    headroom_bytes = 40 * GiB,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), ' HOST\xC2\xB740G ')
end)

it('missing headroom degrades to ? without losing the mount label', function()
  fake_now_ms = 1000000
  write_state {
    level = 'unknown',
    host_mount = '/mnt/d',
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), ' D\xC2\xB7? ')
end)

it('terabyte-scale volumes collapse to a T suffix', function()
  fake_now_ms = 1000000
  write_state {
    level = 'warn',
    host_mount = '/mnt/e',
    headroom_bytes = 2048 * GiB,
    heartbeat_at_ms = 1000000,
  }
  assert_eq(badge_text(), ' E\xC2\xB72.0T ', 'four-digit gigabytes would widen the bar')
end)

it('format_text is pure and needs no file', function()
  assert_eq(disk_status.format_text({
    level = 'warn',
    host_mount = '/mnt/c',
    headroom_bytes = 12 * GiB,
  }, true), ' C\xC2\xB712G ')
  assert_eq(disk_status.format_text({ level = 'ok', headroom_bytes = 99 * GiB }, true), nil)
  assert_eq(disk_status.format_text(nil, false), nil)
end)

os.remove(state_path)

io.write(string.format('disk_status: %d passed, %d failed\n', pass_count, fail_count))
if fail_count > 0 then os.exit(1) end
