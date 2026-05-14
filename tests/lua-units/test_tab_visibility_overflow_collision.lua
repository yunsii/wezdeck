-- Verifies the `is_in_visible` accessor that
-- Workspace.maybe_clear_overflow_collision uses to decide whether the
-- overflow pane is currently projecting a session that just got
-- promoted into top-N. The collision dispatch itself lives in
-- workspace_manager.lua (load_actions_mod + background_child_process)
-- and is exercised manually after sync; this test pins down the
-- membership predicate's contract so callers can trust it for the
-- defer-on-active-pane logic.
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
local function assert_truthy(v, m) if not v then error(m or 'expected truthy', 2) end end
local function assert_falsy(v, m) if v then error((m or 'expected falsy') .. ': ' .. tostring(v), 2) end end

local function fresh_stats_dir()
  local dir = os.getenv('TMPDIR') or '/tmp'
  dir = dir .. '/wezterm-test-collision-' .. tostring(math.random(100000, 999999))
  os.execute('mkdir -p ' .. dir)
  return dir
end

local function write_stats(stats_dir, slug, sessions)
  local parts = {}
  for name, entry in pairs(sessions) do
    parts[#parts + 1] = string.format(
      '"%s":{"weight":%s,"raw_count":%d,"last_bump_ms":%d}',
      name,
      tostring(entry.weight or 0),
      entry.raw_count or 0,
      entry.last_bump_ms or 0)
  end
  local body = '{"version":1,"half_life_days":7,"sessions":{' .. table.concat(parts, ',') .. '}}'
  local fd = io.open(stats_dir .. '/' .. slug .. '.json', 'w')
  fd:write(body); fd:close()
end

local function configure(stats_dir, visible_count)
  tab_visibility._reset()
  tab_visibility.configure {
    wezterm = mock,
    config = {
      stats_dir = stats_dir,
      visible_count = visible_count or 3,
      recompute_interval_ms = 0,
    },
  }
end

describe('is_in_visible', function()
  it('returns false when workspace has no cache yet', function()
    configure(fresh_stats_dir(), 3)
    assert_falsy(tab_visibility.is_in_visible('work', 'wezterm_work_skills_abc1234567'),
      'no cache → not in visible')
  end)

  it('returns false for empty / nil arguments', function()
    configure(fresh_stats_dir(), 3)
    assert_falsy(tab_visibility.is_in_visible(nil, 'x'), 'nil workspace')
    assert_falsy(tab_visibility.is_in_visible('', 'x'), 'empty workspace')
    assert_falsy(tab_visibility.is_in_visible('work', nil), 'nil session')
    assert_falsy(tab_visibility.is_in_visible('work', ''), 'empty session')
  end)

  it('reports membership for the top-N visible set', function()
    local stats_dir = fresh_stats_dir()
    write_stats(stats_dir, 'work', {
      ['wezterm_work_coco-server_aaaaaaaaaa']    = { weight = 1.0, raw_count = 30 },
      ['wezterm_work_skills_bbbbbbbbbb']         = { weight = 0.9, raw_count = 25 },
      ['wezterm_work_coco-platform_cccccccccc']  = { weight = 0.4, raw_count = 10 },
      ['wezterm_work_team-stat_dddddddddd']      = { weight = 0.2, raw_count = 5 },
      ['wezterm_work_packages_eeeeeeeeee']       = { weight = 0.1, raw_count = 3 },
    })
    configure(stats_dir, 3)
    tab_visibility.tick('work', 1000)

    -- top-3 (by weight): coco-server, skills, coco-platform.
    assert_truthy(tab_visibility.is_in_visible('work', 'wezterm_work_coco-server_aaaaaaaaaa'))
    assert_truthy(tab_visibility.is_in_visible('work', 'wezterm_work_skills_bbbbbbbbbb'))
    assert_truthy(tab_visibility.is_in_visible('work', 'wezterm_work_coco-platform_cccccccccc'))
    -- team-stat and packages fall out of the cap.
    assert_falsy(tab_visibility.is_in_visible('work', 'wezterm_work_team-stat_dddddddddd'))
    assert_falsy(tab_visibility.is_in_visible('work', 'wezterm_work_packages_eeeeeeeeee'))
    -- Unknown session never appears.
    assert_falsy(tab_visibility.is_in_visible('work', 'wezterm_work_does-not-exist_ffffffffff'))
  end)

  it('models the overflow→top-N promotion path the collision check guards', function()
    -- Scenario from docs/tab-visibility.md "Live hot reorder": the user
    -- has been viewing `skills` through the overflow pane (Alt+x earlier),
    -- focus stats accumulate, then `skills` displaces a lower-weight
    -- session out of top-N. After the brain ticks, is_in_visible(skills)
    -- flips from false → true — that's the edge maybe_clear_overflow_
    -- collision watches for.
    local stats_dir = fresh_stats_dir()
    -- Initial state: skills not yet in top-N (low weight).
    write_stats(stats_dir, 'work', {
      ['wezterm_work_a_aaaaaaaaaa']      = { weight = 1.0, raw_count = 30, last_bump_ms = 1000 },
      ['wezterm_work_b_bbbbbbbbbb']      = { weight = 0.9, raw_count = 25, last_bump_ms = 1000 },
      ['wezterm_work_c_cccccccccc']      = { weight = 0.8, raw_count = 20, last_bump_ms = 1000 },
      ['wezterm_work_skills_dddddddddd'] = { weight = 0.1, raw_count = 2,  last_bump_ms = 500  },
    })
    configure(stats_dir, 3)
    tab_visibility.tick('work', 2000)
    assert_falsy(tab_visibility.is_in_visible('work', 'wezterm_work_skills_dddddddddd'),
      'skills starts outside top-N — overflow projecting it is fine')

    -- Now skills accumulates focus and surpasses session `c`.
    write_stats(stats_dir, 'work', {
      ['wezterm_work_a_aaaaaaaaaa']      = { weight = 1.0, raw_count = 30, last_bump_ms = 3000 },
      ['wezterm_work_b_bbbbbbbbbb']      = { weight = 0.9, raw_count = 25, last_bump_ms = 3000 },
      ['wezterm_work_c_cccccccccc']      = { weight = 0.8, raw_count = 20, last_bump_ms = 3000 },
      ['wezterm_work_skills_dddddddddd'] = { weight = 0.95, raw_count = 8, last_bump_ms = 3500 },
    })
    tab_visibility.tick('work', 4000)
    assert_truthy(tab_visibility.is_in_visible('work', 'wezterm_work_skills_dddddddddd'),
      'after promotion → collision check should fire')
    assert_falsy(tab_visibility.is_in_visible('work', 'wezterm_work_c_cccccccccc'),
      'c demoted out — overflow projecting c stays harmless (not in visible)')
  end)
end)

io.write(string.format('\n%d passed, %d failed\n', pass_count, fail_count))
os.exit(fail_count == 0 and 0 or 1)
