-- Phase 0 (tab-visibility hot reorder): verify that rank_sessions
-- aggregates `<base>__refresh_<ts>_<pid>` variants under the base name
-- so `refresh-current-window` resets don't fragment a project's focus
-- weight across N short-lived rows. Without aggregation a frequently
-- refreshed project gets out-ranked by less-used projects whose stats
-- happen to be in fewer rows.
--
-- Schema v3: ranking key is `dwell_ms` (decayed capped dwell credit, ms
-- scale). `total_dwell_ms` is the never-decayed lifetime counter,
-- aggregated alongside for picker display. v1 files (only `weight`)
-- fall back to weight-as-dwell during read so the rank stays sane
-- across the migration boundary.
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
local function assert_eq(actual, expected, msg)
  if actual ~= expected then
    error((msg or 'mismatch') .. ': expected ' .. tostring(expected) ..
      ', got ' .. tostring(actual), 2)
  end
end
local function assert_close(actual, expected, eps, msg)
  if math.abs((actual or 0) - expected) > (eps or 1e-9) then
    error((msg or 'mismatch') .. ': expected ~' .. tostring(expected) ..
      ', got ' .. tostring(actual), 2)
  end
end

describe('_normalize_session_name', function()
  local n = tab_visibility._normalize_session_name

  it('strips __refresh_<ts>_<pid> suffix', function()
    assert_eq(n('wezterm_work_coco-server_ebee3ed55c__refresh_20260507T090418_4108862'),
              'wezterm_work_coco-server_ebee3ed55c')
  end)

  it('leaves bare session names unchanged', function()
    assert_eq(n('wezterm_work_coco-server_ebee3ed55c'),
              'wezterm_work_coco-server_ebee3ed55c')
    assert_eq(n('wezterm_work_overflow'), 'wezterm_work_overflow')
    assert_eq(n('plain'), 'plain')
  end)

  it('does not strip suffixes that do not match the exact format', function()
    -- Letters where digits expected → not a real refresh suffix.
    assert_eq(n('foo__refresh_abc_123'), 'foo__refresh_abc_123')
    -- Missing T separator.
    assert_eq(n('foo__refresh_20260507_123'), 'foo__refresh_20260507_123')
    -- Single underscore "_refresh_" is not the marker.
    assert_eq(n('foo_refresh_20260507T010203_4'), 'foo_refresh_20260507T010203_4')
  end)

  it('handles edge inputs without crashing', function()
    assert_eq(n(''), '')
    assert_eq(n(nil), nil)
    -- non-string returns as-is (defensive — production callers should
    -- not pass non-strings, but let the rank path stay total).
    assert_eq(n(42), 42)
  end)

  it('peels only the trailing suffix when chained suffixes appear', function()
    -- Pathological input: a session refreshed, then refreshed again
    -- with the previous suffixed name as the "base". Greedy match
    -- peels the outer suffix only, which is the desired behaviour
    -- (each refresh emits one suffix layer onto the live session
    -- name; chained layers aren't a real shape today, but if they
    -- ever appear we still aggregate at one level instead of
    -- collapsing everything).
    local input = 'base__refresh_20260101T010101_1__refresh_20260102T020202_2'
    assert_eq(n(input), 'base__refresh_20260101T010101_1')
  end)
end)

describe('_rank_sessions', function()
  local r = tab_visibility._rank_sessions

  it('returns empty array for nil / malformed stats', function()
    assert_eq(#r(nil), 0)
    assert_eq(#r({}), 0)
    assert_eq(#r({ sessions = nil }), 0)
    assert_eq(#r({ sessions = 'not-a-table' }), 0)
  end)

  it('passes through a single bare-name v2 entry', function()
    local out = r {
      sessions = {
        ['wezterm_work_coco-platform_4cbcc8f612'] = {
          dwell_ms = 1500000, total_dwell_ms = 1800000, raw_count = 3, last_bump_ms = 1000,
        },
      },
    }
    assert_eq(#out, 1)
    assert_eq(out[1].name, 'wezterm_work_coco-platform_4cbcc8f612')
    assert_close(out[1].dwell_ms, 1500000)
    assert_eq(out[1].total_dwell_ms, 1800000)
    assert_eq(out[1].raw_count, 3)
    assert_eq(out[1].last_bump_ms, 1000)
  end)

  it('aggregates refresh-suffix variants under the base name (v2)', function()
    -- All four variants of coco-server collapse to one row; their
    -- dwell_ms (~25 minutes total credit across the three variants) and
    -- total_dwell_ms (lifetime, even larger) both sum.
    local stats = {
      sessions = {
        ['wezterm_work_coco-server_ebee3ed55c'] = {
          dwell_ms = 1000000, total_dwell_ms = 5000000, raw_count = 3, last_bump_ms = 1000,
        },
        ['wezterm_work_coco-server_ebee3ed55c__refresh_20260506T174432_2661849'] = {
          dwell_ms = 180000, total_dwell_ms = 200000, raw_count = 1, last_bump_ms = 2000,
        },
        ['wezterm_work_coco-server_ebee3ed55c__refresh_20260507T090418_4108862'] = {
          dwell_ms = 510000, total_dwell_ms = 800000, raw_count = 1, last_bump_ms = 3000,
        },
        ['wezterm_work_coco-platform_4cbcc8f612'] = {
          dwell_ms = 290000, total_dwell_ms = 400000, raw_count = 3, last_bump_ms = 500,
        },
      },
    }
    local out = r(stats)
    assert_eq(#out, 2, 'expected exactly two ranked entries (one per base name)')
    -- coco-server ranks first (1000000 + 180000 + 510000 = 1690000 > 290000)
    assert_eq(out[1].name, 'wezterm_work_coco-server_ebee3ed55c')
    assert_close(out[1].dwell_ms, 1690000, 1e-6, 'coco-server aggregated dwell_ms')
    assert_eq(out[1].total_dwell_ms, 6000000, 'coco-server aggregated total_dwell_ms')
    assert_eq(out[1].raw_count, 5, 'coco-server aggregated raw_count')
    assert_eq(out[1].last_bump_ms, 3000, 'coco-server last_bump_ms is max across variants')
    assert_eq(out[2].name, 'wezterm_work_coco-platform_4cbcc8f612')
    assert_close(out[2].dwell_ms, 290000)
    assert_eq(out[2].raw_count, 3)
  end)

  it('orders by dwell_ms desc, raw_count desc, name asc', function()
    local out = r {
      sessions = {
        a = { dwell_ms = 500, raw_count = 1 },
        -- same dwell_ms, higher raw_count → ranks first among the tie
        b = { dwell_ms = 500, raw_count = 5 },
        -- ties on both → name asc
        c = { dwell_ms = 200, raw_count = 1 },
        d = { dwell_ms = 200, raw_count = 1 },
        -- highest dwell_ms → ranks above all
        z = { dwell_ms = 900, raw_count = 0 },
      },
    }
    assert_eq(out[1].name, 'z')
    assert_eq(out[2].name, 'b')
    assert_eq(out[3].name, 'a')
    assert_eq(out[4].name, 'c')
    assert_eq(out[5].name, 'd')
  end)

  it('long-used session is not demoted by a few short-visit competitors', function()
    -- Regression for the renormalize-to-1.0 bug fixed by dwell-ms ranking:
    -- session `a` accumulated 30m of ranking credit over time. Three
    -- other sessions each got one 30s visit (30K ms). Under v1 with
    -- normalization the four sessions would tie at weight=1.0 and `a`
    -- could fall out of top-N. Under v3 `a` is still 60x ahead and stays.
    local out = r {
      sessions = {
        a = { dwell_ms = 1800000, raw_count = 50 },  -- one capped long burst
        b = { dwell_ms = 30000,   raw_count = 1 },   -- single 30s visit
        c = { dwell_ms = 30000,   raw_count = 1 },
        d = { dwell_ms = 30000,   raw_count = 1 },
      },
    }
    assert_eq(out[1].name, 'a', 'long-used session must stay at rank 1')
    assert_close(out[1].dwell_ms / out[2].dwell_ms, 60, 0.001,
      'rank-1 dwell credit should be 60x rank-2')
  end)

  it('clamps legacy v2 uncapped dwell by raw_count before ranking', function()
    local out = r {
      version = 2,
      sessions = {
        frequent = { dwell_ms = 1734813895, total_dwell_ms = 4202636013, raw_count = 45 },
        overnight = { dwell_ms = 5013459119, total_dwell_ms = 5013668127, raw_count = 5 },
      },
    }
    assert_eq(out[1].name, 'frequent', 'frequent focus should beat one/few overnight dwells')
    assert_close(out[1].dwell_ms, 45 * 1800000)
    assert_eq(out[2].name, 'overnight')
    assert_close(out[2].dwell_ms, 5 * 1800000)
  end)

  it('skips non-table session entries defensively', function()
    local out = r {
      sessions = {
        good = { dwell_ms = 500, raw_count = 1 },
        bad_string = 'oops',
        bad_number = 42,
      },
    }
    assert_eq(#out, 1)
    assert_eq(out[1].name, 'good')
  end)

  it('treats missing dwell_ms/raw_count/last_bump_ms fields as zero', function()
    local out = r {
      sessions = {
        partial = {},
        with_dwell = { dwell_ms = 300 },
      },
    }
    assert_eq(#out, 2)
    -- with_dwell ranks first (300 > 0); name-asc tiebreaker would have
    -- put 'partial' first if dwells matched.
    assert_eq(out[1].name, 'with_dwell')
    assert_close(out[1].dwell_ms, 300)
    assert_eq(out[1].raw_count, 0)
    assert_eq(out[1].last_bump_ms, 0)
    assert_eq(out[1].total_dwell_ms, 0)
    assert_eq(out[2].name, 'partial')
    assert_close(out[2].dwell_ms, 0)
  end)

  it('falls back to legacy v1 `weight` field when `dwell_ms` is missing', function()
    -- Migration sanity: a v1 file that hasn't been rewritten yet
    -- still produces a usable rank. Weight values land verbatim as
    -- dwell_ms (so rank order is preserved); they'll be overtaken
    -- once real ms-scale dwells start accumulating.
    local out = r {
      sessions = {
        old_top    = { weight = 1.0, raw_count = 10, last_bump_ms = 1000 },
        old_middle = { weight = 0.5, raw_count = 5,  last_bump_ms = 1000 },
        old_bottom = { weight = 0.1, raw_count = 1,  last_bump_ms = 1000 },
      },
    }
    assert_eq(#out, 3)
    assert_eq(out[1].name, 'old_top')
    assert_close(out[1].dwell_ms, 1.0)
    assert_eq(out[1].total_dwell_ms, 0, 'no total_dwell_ms in v1 → 0')
    assert_eq(out[2].name, 'old_middle')
    assert_close(out[2].dwell_ms, 0.5)
    assert_eq(out[3].name, 'old_bottom')
  end)

  it('mixes v1 and v2 entries when migration is mid-rewrite', function()
    -- Half of the file's entries have been rewritten in ms-scale shape,
    -- the other half still have v1 `weight`
    -- because only their `last_bump_ms` row was touched. Both should
    -- rank together.
    local out = r {
      sessions = {
        already_migrated = { dwell_ms = 60000, total_dwell_ms = 60000, raw_count = 3 },
        not_yet_migrated = { weight = 0.9, raw_count = 1 },
      },
    }
    assert_eq(#out, 2)
    -- already_migrated has 60000 ms which dwarfs 0.9 (legacy weight)
    assert_eq(out[1].name, 'already_migrated')
    assert_eq(out[2].name, 'not_yet_migrated')
  end)
end)

io.write(string.format('\n%d passed, %d failed\n', pass_count, fail_count))
os.exit(fail_count == 0 and 0 or 1)
