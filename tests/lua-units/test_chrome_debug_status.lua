-- Verifies the helper-liveness cache in chrome_debug_status.lua:
-- a single transient read failure of state.env must not flip the
-- badge to `?` while the previously-seen heartbeat is still fresh.

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

-- Override wezterm.time.now() so the test can drive the clock.
local fake_now_ms = 0
mock.time = {
  now = function()
    return setmetatable({}, {
      __index = function() return function() return tostring(fake_now_ms) end end,
    })
  end,
}

-- Stub out read_file by writing to a tmp path the module will read.
local tmpdir = os.getenv('TMPDIR') or '/tmp'
local state_path = tmpdir .. '/wezterm-chrome-debug-test-state.env'
local helper_path = tmpdir .. '/wezterm-chrome-debug-test-helper.env'

local function write_helper_state(heartbeat_at_ms)
  local f = assert(io.open(helper_path, 'w'))
  f:write('version=3\nready=1\nheartbeat_at_ms=' .. tostring(heartbeat_at_ms) .. '\n')
  f:close()
end

local function write_chrome_state(body)
  local f = assert(io.open(state_path, 'w'))
  f:write(body)
  f:close()
end

local function remove_helper_state()
  os.remove(helper_path)
end

-- Force-reload module so module-level cache state starts fresh each run.
package.loaded['chrome_debug_status'] = nil
local chrome_debug_status = require 'chrome_debug_status'
chrome_debug_status.configure {
  state_file = state_path,
  fallback_port = 9222,
  helper_state_file = helper_path,
  helper_heartbeat_timeout_ms = 5000,
}

-- A minimal palette stub matching the keys render_status_segment reads.
local palette = {
  tab_bar_background = '#000000',
  new_tab_fg = '#cccccc',
  tab_inactive_bg = '#222222',
  tab_inactive_fg = '#aaaaaa',
  tab_attention_running_bg = '#cc0000',
  tab_attention_running_fg = '#ffffff',
  ansi = { '#000', '#f00', '#0f0', '#ff0', '#00f', '#f0f', '#0ff', '#fff' },
}

local function badge_letter()
  local parts = chrome_debug_status.render_status_segment(palette)
  for _, p in ipairs(parts) do
    if p.Text then return p.Text:match('CDP\xC2\xB7(.)\xC2\xB7') end
  end
  return nil
end

io.write('\xE2\x96\xB8 chrome_debug_status helper-liveness cache\n')

it('reads heartbeat normally', function()
  fake_now_ms = 1000000
  write_helper_state(1000000)
  write_chrome_state('{"schema":2,"mode":"headless","port":9222,"alive":true}')
  assert_eq(badge_letter(), 'H', 'badge should be H when helper is alive')
end)

it('falls back to cached heartbeat on transient read failure', function()
  fake_now_ms = 1000100
  write_helper_state(1000100)
  badge_letter() -- prime the cache
  remove_helper_state() -- simulate read-during-rename failure
  fake_now_ms = 1000200 -- 100ms after last good heartbeat, well within 5s
  assert_eq(badge_letter(), 'H', 'transient read failure must not flip to ?')
end)

it('flips to ? once cached heartbeat is older than timeout', function()
  fake_now_ms = 1000000
  write_helper_state(1000000)
  badge_letter() -- prime
  remove_helper_state()
  fake_now_ms = 1000000 + 6000 -- 6s later, past the 5s timeout
  assert_eq(badge_letter(), '?', 'stale cache must produce ?')
end)

it('refreshes cache on next successful read', function()
  fake_now_ms = 1000000
  write_helper_state(1000000)
  badge_letter()
  remove_helper_state()
  fake_now_ms = 1000000 + 6000 -- cache now stale
  assert_eq(badge_letter(), '?', 'sanity: cache went stale')
  write_helper_state(1006000) -- helper recovers, heartbeat current
  assert_eq(badge_letter(), 'H', 'fresh read must clear staleness')
end)

os.remove(state_path)
os.remove(helper_path)

io.write(string.format('chrome_debug_status: %d passed, %d failed\n', pass_count, fail_count))
if fail_count > 0 then os.exit(1) end
