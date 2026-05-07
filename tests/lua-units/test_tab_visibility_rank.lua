-- Phase 0 (tab-visibility hot reorder): verify that rank_sessions
-- aggregates `<base>__refresh_<ts>_<pid>` variants under the base name
-- so `refresh-current-window` resets don't fragment a project's focus
-- weight across N short-lived rows. Without aggregation a frequently
-- refreshed project gets out-ranked by less-used projects whose stats
-- happen to be in fewer rows.
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

  it('passes through a single bare-name entry', function()
    local out = r {
      sessions = {
        ['wezterm_work_coco-platform_4cbcc8f612'] = {
          weight = 0.5, raw_count = 3, last_bump_ms = 1000,
        },
      },
    }
    assert_eq(#out, 1)
    assert_eq(out[1].name, 'wezterm_work_coco-platform_4cbcc8f612')
    assert_close(out[1].weight, 0.5)
    assert_eq(out[1].raw_count, 3)
    assert_eq(out[1].last_bump_ms, 1000)
  end)

  it('aggregates refresh-suffix variants under the base name', function()
    -- Mirrors the actual shape we observed in work.json: the base
    -- session and two refresh variants for coco-server, plus an
    -- unrelated coco-platform row to make sure cross-base entries
    -- don't bleed into the aggregate.
    local stats = {
      sessions = {
        ['wezterm_work_coco-server_ebee3ed55c'] = {
          weight = 1.0, raw_count = 3, last_bump_ms = 1000,
        },
        ['wezterm_work_coco-server_ebee3ed55c__refresh_20260506T174432_2661849'] = {
          weight = 0.18, raw_count = 1, last_bump_ms = 2000,
        },
        ['wezterm_work_coco-server_ebee3ed55c__refresh_20260507T090418_4108862'] = {
          weight = 0.51, raw_count = 1, last_bump_ms = 3000,
        },
        ['wezterm_work_coco-platform_4cbcc8f612'] = {
          weight = 0.29, raw_count = 3, last_bump_ms = 500,
        },
      },
    }
    local out = r(stats)
    assert_eq(#out, 2, 'expected exactly two ranked entries (one per base name)')
    -- coco-server should rank first (1.0 + 0.18 + 0.51 = 1.69 > 0.29)
    assert_eq(out[1].name, 'wezterm_work_coco-server_ebee3ed55c')
    assert_close(out[1].weight, 1.69, 1e-6, 'coco-server aggregated weight')
    assert_eq(out[1].raw_count, 5, 'coco-server aggregated raw_count')
    assert_eq(out[1].last_bump_ms, 3000, 'coco-server last_bump_ms is max across variants')
    assert_eq(out[2].name, 'wezterm_work_coco-platform_4cbcc8f612')
    assert_close(out[2].weight, 0.29)
    assert_eq(out[2].raw_count, 3)
  end)

  it('orders by weight desc, raw_count desc, name asc', function()
    local out = r {
      sessions = {
        a = { weight = 0.5, raw_count = 1 },
        -- same weight, higher raw_count → ranks first
        b = { weight = 0.5, raw_count = 5 },
        -- ties on both → name asc
        c = { weight = 0.2, raw_count = 1 },
        d = { weight = 0.2, raw_count = 1 },
        -- highest weight → ranks above all
        z = { weight = 0.9, raw_count = 0 },
      },
    }
    assert_eq(out[1].name, 'z')
    assert_eq(out[2].name, 'b')
    assert_eq(out[3].name, 'a')
    assert_eq(out[4].name, 'c')
    assert_eq(out[5].name, 'd')
  end)

  it('skips non-table session entries defensively', function()
    local out = r {
      sessions = {
        good = { weight = 0.5, raw_count = 1 },
        bad_string = 'oops',
        bad_number = 42,
      },
    }
    assert_eq(#out, 1)
    assert_eq(out[1].name, 'good')
  end)

  it('treats missing weight/raw_count/last_bump_ms fields as zero', function()
    local out = r {
      sessions = {
        partial = {},
        with_weight = { weight = 0.3 },
      },
    }
    assert_eq(#out, 2)
    -- with_weight ranks first (0.3 > 0); name-asc tiebreaker would have
    -- put 'partial' first if weights matched.
    assert_eq(out[1].name, 'with_weight')
    assert_close(out[1].weight, 0.3)
    assert_eq(out[1].raw_count, 0)
    assert_eq(out[1].last_bump_ms, 0)
    assert_eq(out[2].name, 'partial')
    assert_close(out[2].weight, 0)
  end)
end)

io.write(string.format('\n%d passed, %d failed\n', pass_count, fail_count))
os.exit(fail_count == 0 and 0 or 1)
