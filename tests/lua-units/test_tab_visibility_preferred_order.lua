-- Phase 2a: cold-open uses brain ordering. `preferred_item_order`
-- consults the brain's ranked list to put high-frequency sessions
-- first while preserving `workspaces.lua` declared order as the
-- fallback when stats are missing or tied.
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

-- The brain's `preferred_item_order` calls `tick` internally to seed
-- `cache.ranked`. Tick reads the per-workspace stats file from
-- `<stats_dir>/<slug>.json`. We point stats_dir at a fresh tmpdir per
-- test so `tick` has a real file to read (or no file → empty cache,
-- exercising the cold-start path).
local function fresh_stats_dir()
  local dir = os.getenv('TMPDIR') or '/tmp'
  dir = dir .. '/wezterm-test-stats-' .. tostring(math.random(100000, 999999))
  os.execute('mkdir -p ' .. dir)
  return dir
end

local function write_stats(stats_dir, slug, sessions)
  local body = '{"version":1,"half_life_days":7,"sessions":'
  local parts = {}
  for name, entry in pairs(sessions) do
    parts[#parts + 1] = string.format(
      '"%s":{"weight":%s,"raw_count":%d,"last_bump_ms":%d}',
      name,
      tostring(entry.weight or 0),
      entry.raw_count or 0,
      entry.last_bump_ms or 0)
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
      recompute_interval_ms = 0,  -- disable throttle for tests
    },
  }
end

-- Mirror of work workspace items + their canonical session names. The
-- session names are stable strings the brain ranks against; we fake
-- them rather than shelling out to print-session-names.sh.
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

describe('preferred_item_order', function()
  it('returns empty when items is empty / nil / non-table', function()
    configure(fresh_stats_dir(), 5)
    local items, c2s = work_fixture()
    assert_len(tab_visibility.preferred_item_order('work', {}, c2s, 5), 0)
    assert_len(tab_visibility.preferred_item_order('work', nil, c2s, 5), 0)
    assert_len(tab_visibility.preferred_item_order('work', 'oops', c2s, 5), 0)
  end)

  it('cold start (no stats file): falls back to declared order, capped at n', function()
    configure(fresh_stats_dir(), 5)
    local items, c2s = work_fixture()
    local out = tab_visibility.preferred_item_order('work', items, c2s, 5)
    assert_len(out, 5)
    assert_eq(out[1].cwd, '/home/yuns/work/ai-video-collection')
    assert_eq(out[2].cwd, '/home/yuns/work/coco-platform')
    assert_eq(out[3].cwd, '/home/yuns/work/packages')
    assert_eq(out[4].cwd, '/home/yuns/work/breeze-monkey')
    assert_eq(out[5].cwd, '/home/yuns/work/operations-monkey')
  end)

  it('cold start: cap > items length returns all items in declared order', function()
    configure(fresh_stats_dir(), 10)
    local items, c2s = work_fixture()
    local out = tab_visibility.preferred_item_order('work', items, c2s, 10)
    assert_len(out, 7)
    -- First and last preserve declared order.
    assert_eq(out[1].cwd, '/home/yuns/work/ai-video-collection')
    assert_eq(out[7].cwd, '/home/yuns/work/team-stat')
  end)

  it('with stats: ranked items first, declared fallback for the tail', function()
    -- Mirror real work.json: coco-server dominates (1.0 + refresh
    -- variants get aggregated under base name), AVC mid, others low.
    local stats_dir = fresh_stats_dir()
    write_stats(stats_dir, 'work', {
      ['wezterm_work_coco-server_ebee3ed55c']        = { weight = 1.0,  raw_count = 3, last_bump_ms = 1000 },
      ['wezterm_work_coco-server_ebee3ed55c__refresh_20260507T090418_4108862'] = { weight = 0.5, raw_count = 1, last_bump_ms = 1100 },
      ['wezterm_work_ai-video-collection_59200b16b2'] = { weight = 0.50, raw_count = 8, last_bump_ms = 900 },
      ['wezterm_work_breeze-monkey_5e2ddfe766']      = { weight = 0.30, raw_count = 2, last_bump_ms = 800 },
      ['wezterm_work_coco-platform_4cbcc8f612']      = { weight = 0.28, raw_count = 3, last_bump_ms = 700 },
    })
    configure(stats_dir, 5)
    local items, c2s = work_fixture()
    local out = tab_visibility.preferred_item_order('work', items, c2s, 5)
    assert_len(out, 5)
    -- Top 4 from brain ranking (coco-server aggregated to 1.5, beats AVC 0.50, breeze 0.30, coco-platform 0.28).
    assert_eq(out[1].cwd, '/home/yuns/work/coco-server',         'brain rank 1: coco-server')
    assert_eq(out[2].cwd, '/home/yuns/work/ai-video-collection', 'brain rank 2: AVC')
    assert_eq(out[3].cwd, '/home/yuns/work/breeze-monkey',       'brain rank 3: breeze-monkey')
    assert_eq(out[4].cwd, '/home/yuns/work/coco-platform',       'brain rank 4: coco-platform')
    -- Slot 5: declared-order fallback. packages is the first declared
    -- cwd not yet placed (AVC, coco-platform already placed; packages
    -- next in declared order; breeze-monkey already placed; operations
    -- next un-placed but packages comes first).
    assert_eq(out[5].cwd, '/home/yuns/work/packages', 'declared fallback after ranked')
  end)

  it('with stats: ranked sessions whose cwd is missing from items are skipped', function()
    local stats_dir = fresh_stats_dir()
    -- Top-ranked session corresponds to a cwd NOT in workspaces.lua —
    -- e.g. an ad-hoc session bumped under the same workspace. Should
    -- not displace a real item.
    write_stats(stats_dir, 'work', {
      ['wezterm_work_orphan_xxxxxxxxxx']             = { weight = 1.0,  raw_count = 5 },
      ['wezterm_work_coco-server_ebee3ed55c']        = { weight = 0.8, raw_count = 3 },
    })
    configure(stats_dir, 3)
    local items, c2s = work_fixture()
    local out = tab_visibility.preferred_item_order('work', items, c2s, 3)
    assert_len(out, 3)
    -- coco-server still surfaces (the orphan session has no item to
    -- bind, so brain entry is silently dropped).
    assert_eq(out[1].cwd, '/home/yuns/work/coco-server')
    -- Slot 2 + 3 fall back to declared order from the start.
    assert_eq(out[2].cwd, '/home/yuns/work/ai-video-collection')
    assert_eq(out[3].cwd, '/home/yuns/work/coco-platform')
  end)

  it('items missing from cwd_to_session map are recovered via label fallback', function()
    -- cwd_to_session lacks coco-server — simulates the
    -- print-session-names.sh helper failing for that one path. Brain
    -- has coco-server ranked top; the label-based fallback (parses
    -- `wezterm_work_<label>_<hash>` and matches against sanitized
    -- basenames) picks coco-server back up so a transient cwd→session
    -- gap doesn't silently demote a high-weight item.
    local stats_dir = fresh_stats_dir()
    write_stats(stats_dir, 'work', {
      ['wezterm_work_coco-server_ebee3ed55c'] = { weight = 1.5, raw_count = 4 },
    })
    configure(stats_dir, 3)
    local items, c2s = work_fixture()
    c2s['/home/yuns/work/coco-server'] = nil
    local out = tab_visibility.preferred_item_order('work', items, c2s, 3)
    assert_len(out, 3)
    -- Slot 1: coco-server via label fallback (basename 'coco-server'
    -- matches the session's middle segment).
    assert_eq(out[1].cwd, '/home/yuns/work/coco-server', 'label fallback recovers coco-server')
    -- Slots 2-3: declared-order fallback for remaining capacity.
    assert_eq(out[2].cwd, '/home/yuns/work/ai-video-collection')
    assert_eq(out[3].cwd, '/home/yuns/work/coco-platform')
  end)

  it('empty cwd_to_session map → label fallback still ranks high-weight items', function()
    -- compute_cwd_to_session shellout failure produces {} on the
    -- workspace_manager side. With the label-based fallback in place
    -- the ranked pass should still surface coco-server (top weight)
    -- ahead of declared order, instead of silently dropping it.
    local stats_dir = fresh_stats_dir()
    write_stats(stats_dir, 'work', {
      ['wezterm_work_coco-server_ebee3ed55c'] = { weight = 1.0, raw_count = 3 },
    })
    configure(stats_dir, 5)
    local items = work_fixture()
    local out = tab_visibility.preferred_item_order('work', items, {}, 5)
    assert_len(out, 5)
    -- coco-server recovered via label fallback at slot 1.
    assert_eq(out[1].cwd, '/home/yuns/work/coco-server', 'label fallback recovers ranked top')
    -- Slots 2-5: declared order tail, skipping coco-server (placed).
    assert_eq(out[2].cwd, '/home/yuns/work/ai-video-collection')
    assert_eq(out[3].cwd, '/home/yuns/work/coco-platform')
    assert_eq(out[4].cwd, '/home/yuns/work/packages')
    assert_eq(out[5].cwd, '/home/yuns/work/breeze-monkey')
  end)

  it('label fallback handles refresh-suffixed ranked entries', function()
    -- rank_sessions normalizes `__refresh_*` suffixes to the base
    -- session name before sorting, so ranked entries reaching
    -- preferred_item_order always carry the base name. Verify the
    -- label fallback still works when the brain ranking is driven
    -- entirely by refresh-variant rows (the base session may have no
    -- standalone stats row at all).
    local stats_dir = fresh_stats_dir()
    write_stats(stats_dir, 'work', {
      ['wezterm_work_coco-server_ebee3ed55c__refresh_20260507T090418_4108862'] = { weight = 1.2, raw_count = 2 },
      ['wezterm_work_coco-server_ebee3ed55c__refresh_20260506T174432_2661849'] = { weight = 0.5, raw_count = 1 },
    })
    configure(stats_dir, 3)
    local items = work_fixture()
    local out = tab_visibility.preferred_item_order('work', items, {}, 3)
    assert_len(out, 3)
    assert_eq(out[1].cwd, '/home/yuns/work/coco-server', 'refresh aggregate ranks coco-server top')
    assert_eq(out[2].cwd, '/home/yuns/work/ai-video-collection')
    assert_eq(out[3].cwd, '/home/yuns/work/coco-platform')
  end)

  it('items fitting under the cap return declared order regardless of brain rank', function()
    -- Regression: `config` workspace (3 items, cap 5) accumulated brain
    -- weight for WSL > wezterm-config, and cold-open spawned in brain
    -- order — pane 1=WSL, pane 2=wezterm-config — which surprised the
    -- user who expected items[1]=wezterm-config to win, and silently
    -- misrouted Alt+. to WSL when the stored wezterm_pane_id was stale.
    -- The brain rank only matters when items > cap (some items get
    -- dropped); when every item gets a tab anyway, reordering just
    -- shuffles pane-id assignment with no UX benefit. Declared order
    -- wins in that case.
    local stats_dir = fresh_stats_dir()
    write_stats(stats_dir, 'config', {
      ['wezterm_config_WSL_f87ebc5e20']           = { weight = 2.0, raw_count = 9 },
      ['wezterm_config_wezterm-config_1f5ee8662c'] = { weight = 0.5, raw_count = 2 },
    })
    configure(stats_dir, 5)
    local items = {
      { cwd = '/home/yuns/github/wezterm-config' },
      { cwd = '/home/yuns/github/WSL' },
      { cwd = '/home/yuns/github/rime-config' },
    }
    local c2s = {
      ['/home/yuns/github/wezterm-config'] = 'wezterm_config_wezterm-config_1f5ee8662c',
      ['/home/yuns/github/WSL']            = 'wezterm_config_WSL_f87ebc5e20',
      ['/home/yuns/github/rime-config']    = 'wezterm_config_rime-config_1a2823b185',
    }
    local out = tab_visibility.preferred_item_order('config', items, c2s, 5)
    assert_len(out, 3)
    assert_eq(out[1].cwd, '/home/yuns/github/wezterm-config', 'declared items[1] stays first')
    assert_eq(out[2].cwd, '/home/yuns/github/WSL')
    assert_eq(out[3].cwd, '/home/yuns/github/rime-config')
  end)

  it('items exceeding the cap still use brain rank (uncapped path inactive)', function()
    -- Confirm the new `#items <= n` shortcut only short-circuits when
    -- the items actually fit; once items exceed cap, brain rank decides
    -- the spawn set (and the existing top-N + declared-tail logic).
    local stats_dir = fresh_stats_dir()
    write_stats(stats_dir, 'work', {
      ['wezterm_work_coco-server_ebee3ed55c'] = { weight = 1.0, raw_count = 5 },
    })
    configure(stats_dir, 5)
    local items, c2s = work_fixture()
    local out = tab_visibility.preferred_item_order('work', items, c2s, 5)
    assert_len(out, 5)
    -- coco-server rose to the top via brain rank — this is the
    -- preserved capped-workspace behavior, not affected by the new gate.
    assert_eq(out[1].cwd, '/home/yuns/work/coco-server', 'brain rank still wins when capping is needed')
  end)

  it('label fallback ignores ranked entries whose label has no item', function()
    -- Orphan session under same workspace (e.g. ad-hoc bare tmux
    -- session bumped via tab-stats-bump.sh from a cwd not declared
    -- in workspaces.lua). Label fallback must skip it, falling
    -- through to declared order rather than spawning something the
    -- user never configured.
    local stats_dir = fresh_stats_dir()
    write_stats(stats_dir, 'work', {
      ['wezterm_work_orphan_xxxxxxxxxx']      = { weight = 2.0, raw_count = 9 },
      ['wezterm_work_coco-server_ebee3ed55c'] = { weight = 0.5, raw_count = 1 },
    })
    configure(stats_dir, 3)
    local items = work_fixture()
    local out = tab_visibility.preferred_item_order('work', items, {}, 3)
    assert_len(out, 3)
    -- orphan dropped (no item with basename 'orphan'); coco-server
    -- still surfaces via label fallback.
    assert_eq(out[1].cwd, '/home/yuns/work/coco-server')
    assert_eq(out[2].cwd, '/home/yuns/work/ai-video-collection')
    assert_eq(out[3].cwd, '/home/yuns/work/coco-platform')
  end)
end)

io.write(string.format('\n%d passed, %d failed\n', pass_count, fail_count))
os.exit(fail_count == 0 and 0 or 1)
