-- Tests for attention.tab_badge — the WezTerm tab-strip surface.
--
-- A repo family lives in ONE wezterm tab (its tmux windows are the
-- worktrees), so this function routinely picks a single winner out of
-- several concurrent agent sessions. Which one it picks — the most
-- recent, by `ts` — is the whole point of the surface.

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

local SESSION = 'wezterm_config_wezterm-config_aaaaaaaaaa'
local PANE_ID = 7

-- Stand up an attention state file (plus an optional tmux-focus file so
-- is_entry_focused has something to read) and return the badge for a
-- tab whose active pane hosts SESSION.
local function badge_for(entries_json, opts)
  opts = opts or {}
  local tmp = os.tmpname() .. '.d'
  os.execute('mkdir -p ' .. tmp .. '/tmux-focus')
  local state_file = tmp .. '/state.json'
  local fd = io.open(state_file, 'w')
  fd:write(entries_json)
  fd:close()
  if opts.focused_tmux_pane then
    -- Mirrors tmux-focus-emit.sh: <state_dir>/tmux-focus/<safe_socket>__<safe_session>.txt
    local ff = io.open(tmp .. '/tmux-focus/_tmp_sock__' .. SESSION .. '.txt', 'w')
    ff:write(opts.focused_tmux_pane)
    ff:close()
  end

  attention.configure { state_file = state_file }
  attention.reload_state()

  local badge = attention.tab_badge {
    active_pane = { pane_id = PANE_ID },
    is_active = opts.is_active == true,
  }
  os.execute('rm -rf ' .. tmp)
  return badge
end

local function reset()
  _G.__WEZTERM_PANE_TMUX_SESSION = {}
  _G.__WEZTERM_TAB_OVERFLOW = {}
  mock.reset_mux()
  mock.set_mux {
    windows = {
      { workspace = 'config', tabs = {
        { id = 1, title = 'wezterm-config', active_pane = { id = PANE_ID } },
      }},
    },
  }
  tab_visibility.set_pane_session(PANE_ID, SESSION)
end

-- Entry JSON for one worktree window of the repo family.
local function entry(id, window, pane, status, ts, branch)
  return ('"%s":{"session_id":"%s","wezterm_pane_id":"%d",'):format(id, id, PANE_ID)
    .. ('"tmux_session":"%s","tmux_socket":"/tmp/sock",'):format(SESSION)
    .. ('"tmux_window":"%s","tmux_pane":"%s",'):format(window, pane)
    .. ('"status":"%s","ts":%d,"git_branch":"%s","reason":"x"}'):format(status, ts, branch or '')
end

local function state(...)
  return '{"version":1,"entries":{' .. table.concat({ ... }, ',') .. '}}'
end

-- ── tests ──────────────────────────────────────────────────────────────

describe('tab_badge shows the most recent session of a repo family', function()
  it('newest ts wins regardless of status: a fresh running over an older waiting', function()
    reset()
    local now = os.time() * 1000
    local badge = badge_for(state(
      entry('stale-waiting', '@2', '%5', 'waiting', now - 120000, 'dev/auth'),
      entry('fresh-running', '@3', '%9', 'running', now - 10000, 'task/perf')
    ))
    assert_truthy(badge, 'no badge for a tab with two live sessions')
    assert_eq(badge.status, 'running', 'badge did not follow the newest entry')
  end)

  it('newest ts wins the other way too: a fresh waiting over an older running', function()
    reset()
    local now = os.time() * 1000
    local badge = badge_for(state(
      entry('older-running', '@2', '%5', 'running', now - 120000, 'dev/auth'),
      entry('fresh-waiting', '@3', '%9', 'waiting', now - 10000, 'task/perf')
    ))
    assert_eq(badge.status, 'waiting', 'badge did not follow the newest entry')
  end)

  it('a fresh done beats an older running', function()
    reset()
    local now = os.time() * 1000
    local badge = badge_for(state(
      entry('older-running', '@2', '%5', 'running', now - 60000, 'dev/auth'),
      entry('fresh-done', '@3', '%9', 'done', now, 'task/perf')
    ))
    assert_eq(badge.status, 'done', 'badge did not follow the newest entry')
  end)

  it('carries no label — the tab strip keeps its original bare block', function()
    reset()
    local now = os.time() * 1000
    local badge = badge_for(state(
      entry('running', '@2', '%5', 'running', now, 'dev/auth')
    ))
    assert_eq(badge.marker, '█', 'marker changed')
    assert_falsy(badge.label, 'badge grew a label again; that was reverted on purpose')
  end)

  it('returns nil when the tab hosts no live entry', function()
    reset()
    assert_falsy(badge_for('{"version":1,"entries":{}}'), 'badge appeared with no entries')
  end)

  it('ignores entries belonging to another tmux session', function()
    reset()
    local now = os.time() * 1000
    local other = '"foreign":{"session_id":"foreign","wezterm_pane_id":"99",'
      .. '"tmux_session":"wezterm_work_other_bbbbbbbbbb","tmux_socket":"/tmp/sock",'
      .. '"tmux_window":"@1","tmux_pane":"%1","status":"waiting","ts":' .. now
      .. ',"git_branch":"master","reason":"x"}'
    local badge = badge_for('{"version":1,"entries":{' .. other .. '}}')
    assert_falsy(badge, 'another repo family leaked onto this tab')
  end)
end)

describe('tab_badge focus suppression', function()
  it('suppresses waiting on the focused worktree but keeps a sibling window visible', function()
    reset()
    local now = os.time() * 1000
    -- The user is looking at %5 (window @2). That worktree's waiting is
    -- acked by the glance; the sibling worktree's done must still show —
    -- even though the suppressed entry is the newer of the two.
    local badge = badge_for(state(
      entry('focused-waiting', '@2', '%5', 'waiting', now, 'dev/auth'),
      entry('sibling-done', '@3', '%9', 'done', now - 30000, 'task/perf')
    ), { is_active = true, focused_tmux_pane = '%5' })
    assert_truthy(badge, 'suppressing the focused waiting also dropped the sibling')
    assert_eq(badge.status, 'done', 'focused waiting was not suppressed')
  end)

  it('keeps running visible on the focused worktree (informational)', function()
    reset()
    local now = os.time() * 1000
    local badge = badge_for(state(
      entry('focused-running', '@2', '%5', 'running', now, 'dev/auth')
    ), { is_active = true, focused_tmux_pane = '%5' })
    assert_truthy(badge, 'running was suppressed on the focused pane')
    assert_eq(badge.status, 'running', 'unexpected status')
  end)

  it('does not suppress anything on an inactive tab', function()
    reset()
    local now = os.time() * 1000
    local badge = badge_for(state(
      entry('bg-waiting', '@2', '%5', 'waiting', now, 'dev/auth')
    ), { is_active = false, focused_tmux_pane = '%5' })
    assert_eq(badge.status, 'waiting', 'inactive tab suppressed its own waiting')
  end)
end)

io.write(string.format('\n%d passed, %d failed\n', pass_count, fail_count))
os.exit(fail_count == 0 and 0 or 1)
