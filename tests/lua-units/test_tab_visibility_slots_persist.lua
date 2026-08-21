-- Sticky-slot persistence: after a process restart (cache clear), cold-open
-- must hydrate the previous slot order from <slug>.slots.json so visible
-- tabs do not reshuffle solely because WezTerm restarted.
package.path = './tests/lua-units/?.lua;./wezterm-x/lua/?.lua;./wezterm-x/lua/ui/?.lua;' .. package.path

local mock = require 'wezterm_mock'
package.preload['wezterm'] = function() return mock end
_G.WEZTERM_RUNTIME_DIR = './wezterm-x'

local tab_visibility = require 'tab_visibility'

local fail_count, pass_count = 0, 0
local function describe(n, fn) io.write('▸ ' .. n .. '\n') fn() end
local function it(n, fn)
  local ok, err = pcall(fn)
  if ok then pass_count = pass_count + 1 io.write('  ✓ ' .. n .. '\n')
  else fail_count = fail_count + 1 io.write('  ✗ ' .. n .. '\n    ' .. tostring(err) .. '\n') end
end
local function assert_eq(a, e, m)
  if a ~= e then error((m or 'mismatch') .. ': expected ' .. tostring(e) .. ', got ' .. tostring(a), 2) end
end
local function assert_len(arr, n, m)
  if #arr ~= n then error((m or 'length') .. ': expected ' .. n .. ', got ' .. #arr, 2) end
end

local function fresh_stats_dir()
  local dir = os.getenv('TMPDIR') or '/tmp'
  dir = dir .. '/wezterm-test-slots-' .. tostring(math.random(100000, 999999))
  os.execute('mkdir -p ' .. dir)
  return dir
end

local function write_stats(stats_dir, slug, sessions)
  local body = '{"version":4,"half_life_days":7,"sessions":'
  local parts = {}
  for name, entry in pairs(sessions) do
    parts[#parts + 1] = string.format(
      '"%s":{"activity_score":%s,"activity_count":%d,"last_activity_ms":%d}',
      name,
      tostring(entry.activity_score or entry.weight or 0),
      entry.activity_count or entry.raw_count or 1,
      entry.last_activity_ms or entry.last_bump_ms or 0)
  end
  body = body .. '{' .. table.concat(parts, ',') .. '}}'
  local fd = io.open(stats_dir .. '/' .. slug .. '.json', 'w')
  fd:write(body); fd:close()
end

local function configure(stats_dir, visible_count)
  tab_visibility._reset()
  tab_visibility.configure {
    wezterm = mock,
    config = {
      stats_dir = stats_dir,
      visible_count = visible_count or 5,
      recompute_interval_ms = 0,
    },
  }
end

local function work_fixture()
  local items = {
    { cwd = '/home/yuns/work/ai-video-collection' },
    { cwd = '/home/yuns/work/coco-platform' },
    { cwd = '/home/yuns/work/packages' },
    { cwd = '/home/yuns/work/breeze-monkey' },
    { cwd = '/home/yuns/work/operations-monkey' },
    { cwd = '/home/yuns/work/coco-server' },
    { cwd = '/home/yuns/work/team-stat' },
  }
  local cwd_to_session = {
    ['/home/yuns/work/ai-video-collection'] = 'wezterm_work_ai-video-collection_59200b16b2',
    ['/home/yuns/work/coco-platform']        = 'wezterm_work_coco-platform_4cbcc8f612',
    ['/home/yuns/work/packages']             = 'wezterm_work_packages_4a3bc1a83a',
    ['/home/yuns/work/breeze-monkey']        = 'wezterm_work_breeze-monkey_5e2ddfe766',
    ['/home/yuns/work/operations-monkey']    = 'wezterm_work_operations-monkey_18bb6f2daa',
    ['/home/yuns/work/coco-server']          = 'wezterm_work_coco-server_ebee3ed55c',
    ['/home/yuns/work/team-stat']            = 'wezterm_work_team-stat_fa8980fb6e',
  }
  return items, cwd_to_session
end

describe('sticky slots persist across cache reset', function()
  it('writes .slots.json and hydrates the same order after _reset', function()
    local stats_dir = fresh_stats_dir()
    write_stats(stats_dir, 'work', {
      ['wezterm_work_coco-server_ebee3ed55c']        = { activity_score = 100, activity_count = 3, last_activity_ms = 1000 },
      ['wezterm_work_ai-video-collection_59200b16b2'] = { activity_score = 50,  activity_count = 8, last_activity_ms = 900 },
      ['wezterm_work_breeze-monkey_5e2ddfe766']      = { activity_score = 30,  activity_count = 2, last_activity_ms = 800 },
      ['wezterm_work_coco-platform_4cbcc8f612']      = { activity_score = 28,  activity_count = 3, last_activity_ms = 700 },
      ['wezterm_work_packages_4a3bc1a83a']           = { activity_score = 10,  activity_count = 1, last_activity_ms = 600 },
    })
    configure(stats_dir, 5)
    local items, c2s = work_fixture()
    local first = tab_visibility.preferred_item_order('work', items, c2s, 5)
    assert_len(first, 5)
    assert_eq(first[1].cwd, '/home/yuns/work/coco-server')

    local slots_file = tab_visibility._slots_path_for_test('work')
    local fd = io.open(slots_file, 'rb')
    assert_eq(fd ~= nil, true, 'slots file should exist after preferred_item_order')
    fd:close()

    -- Simulate WezTerm restart: clear in-memory cache, keep files.
    tab_visibility._reset()
    tab_visibility.configure {
      wezterm = mock,
      config = {
        stats_dir = stats_dir,
        visible_count = 5,
        recompute_interval_ms = 0,
      },
    }
    local second = tab_visibility.preferred_item_order('work', items, c2s, 5)
    assert_len(second, 5)
    for i = 1, 5 do
      assert_eq(second[i].cwd, first[i].cwd, 'slot ' .. i .. ' stable after restart')
    end
  end)
end)

io.write(string.format('\n%d passed, %d failed\n', pass_count, fail_count))
if fail_count > 0 then os.exit(1) end
