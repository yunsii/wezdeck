-- Regression tests for attention.activate_in_gui's stale-pane-id guard.
--
-- Scenario: a workspace close + reopen (Workspace.open cold-open path
-- re-spawns by brain rank, not declared items order) leaves the long-
-- lived tmux server's $WEZTERM_PANE pointing at the previous wezterm
-- pane id. Attention hooks read that env, so entries on disk record a
-- stale wezterm_pane_id that's still alive in the live mux but now
-- hosts a different tmux session (e.g. pane 1 used to be wezterm-
-- config, after reopen pane 1 is WSL). Without cross-checking the
-- unified pane→session map, Alt+. activates pane 1 — the user lands
-- on WSL when they meant to land on the agent pane.
--
-- These tests should FAIL against the pre-fix activate_in_gui (which
-- only fell back to the reverse lookup when the stored pane id was
-- dead) and PASS once the cross-check is in place.
--
-- Drive with scripts/dev/test-lua-units.sh.

package.path = './tests/lua-units/?.lua;./wezterm-x/lua/?.lua;./wezterm-x/lua/ui/?.lua;' .. package.path

local mock = require 'wezterm_mock'
package.preload['wezterm'] = function() return mock end
_G.WEZTERM_RUNTIME_DIR = './wezterm-x'

local attention = require 'attention'
local tab_visibility = require 'tab_visibility'

local fail_count, pass_count = 0, 0
local function describe(n, fn) io.write('▸ ' .. n .. '\n') fn() end
local function it(n, fn)
  local ok, err = pcall(fn)
  if ok then pass_count = pass_count + 1 io.write('  ✓ ' .. n .. '\n')
  else fail_count = fail_count + 1 io.write('  ✗ ' .. n .. '\n    ' .. tostring(err) .. '\n') end
end
local function assert_eq(a, b, m)
  if a ~= b then error((m or '') .. ' expected=' .. tostring(b) .. ' actual=' .. tostring(a), 2) end
end
local function assert_truthy(v, m) if not v then error(m or 'expected truthy', 2) end end
local function assert_falsy(v, m) if v then error((m or 'expected falsy') .. ': ' .. tostring(v), 2) end end

local function reset()
  _G.__WEZTERM_PANE_TMUX_SESSION = {}
  _G.__WEZTERM_TAB_OVERFLOW = {}
  mock.reset_mux()
end

-- Mirror of the user's bug-report topology after `config` workspace
-- close + reopen: pane 1 = WSL, pane 2 = wezterm-config, pane 3 =
-- rime-config. Returns a closure that yields the most-recently-
-- activated pane id (or nil), populated by monkey-patching pane:activate
-- on each underlying mock pane.
local function set_config_topology()
  mock.set_mux {
    windows = {
      {
        workspace = 'config',
        tabs = {
          { id = 1, title = 'WSL',            active_pane = { id = 1 } },
          { id = 2, title = 'wezterm-config', active_pane = { id = 2 } },
          { id = 3, title = 'rime-config',    active_pane = { id = 3 } },
        },
      },
    },
  }
  local activated_pane_id
  for _, win in ipairs(mock.mux.all_windows()) do
    for _, tab in ipairs(win:tabs()) do
      for _, info in ipairs(tab:panes_with_info()) do
        local pid = info.pane.id
        info.pane.activate = function() activated_pane_id = pid end
      end
    end
  end
  return function() return activated_pane_id end
end

local WSL_SESSION  = 'wezterm_config_WSL_aaaaaaaaaa'
local WCFG_SESSION = 'wezterm_config_wezterm-config_bbbbbbbbbb'
local RIME_SESSION = 'wezterm_config_rime-config_cccccccccc'

-- ── tests ──────────────────────────────────────────────────────────────

describe('activate_in_gui — stale stored wezterm_pane_id', function()
  it('falls back to reverse lookup when stored id hosts a different session', function()
    reset()
    local get_activated = set_config_topology()
    -- Live truth: pane 1 hosts WSL, pane 2 hosts wezterm-config.
    tab_visibility.set_pane_session(1, WSL_SESSION)
    tab_visibility.set_pane_session(2, WCFG_SESSION)
    tab_visibility.set_pane_session(3, RIME_SESSION)

    -- Entry has wezterm_pane_id="1" (stale: captured before the close+
    -- reopen reordered tabs) but tmux_session points at the wezterm-
    -- config session.
    local ok = attention.activate_in_gui('1', nil, {}, { tmux_session = WCFG_SESSION })

    assert_truthy(ok, 'activate_in_gui should still report success via reverse lookup')
    assert_eq(get_activated(), 2,
      'expected reroute to pane 2 (wezterm-config host), not pane 1 (WSL)')
  end)

  it('still trusts stored id when it does host the entry session', function()
    reset()
    local get_activated = set_config_topology()
    tab_visibility.set_pane_session(2, WCFG_SESSION)

    local ok = attention.activate_in_gui('2', nil, {}, { tmux_session = WCFG_SESSION })

    assert_truthy(ok)
    assert_eq(get_activated(), 2, 'matching id should be used directly')
  end)

  it('trusts stored id when pane→session map has no entry yet (fresh pane)', function()
    reset()
    local get_activated = set_config_topology()
    -- No set_pane_session for any pane: write_live_snapshot has not
    -- run yet, so the map can't disprove the stored id. Don't drop
    -- the jump in that case — fall back to legacy "trust the id"
    -- behavior rather than misrouting through an ambiguous reverse
    -- lookup.
    local ok = attention.activate_in_gui('2', nil, {}, { tmux_session = WCFG_SESSION })

    assert_truthy(ok)
    assert_eq(get_activated(), 2)
  end)

  it('trusts stored id when caller passes no tmux_session hint', function()
    reset()
    local get_activated = set_config_topology()
    -- Legacy / non-tmux entries flow through with opts == nil. Even
    -- if the map happens to disagree, there's no hint to compare
    -- against — fall back to the historical behavior.
    tab_visibility.set_pane_session(1, WSL_SESSION)

    local ok = attention.activate_in_gui('1', nil, {}, nil)

    assert_truthy(ok)
    assert_eq(get_activated(), 1)
  end)

  it('falls through to reverse lookup when stored id is empty', function()
    reset()
    local get_activated = set_config_topology()
    tab_visibility.set_pane_session(2, WCFG_SESSION)

    -- Empty pane_id_value but a valid session hint: skip step (1)
    -- entirely and let the reverse-lookup branch find the host.
    local ok = attention.activate_in_gui('', nil, {}, { tmux_session = WCFG_SESSION })

    assert_truthy(ok)
    assert_eq(get_activated(), 2)
  end)
end)

if fail_count > 0 then
  io.write(string.format('\n%d failed, %d passed\n', fail_count, pass_count))
  os.exit(1)
end
io.write(string.format('\n%d passed\n', pass_count))
