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
local pane_session_files = require 'pane_session_files'

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
-- The workspace's overflow placeholder (`…`). Its own pane id, so the
-- suite can put a managed tab and the placeholder side by side.
local OVERFLOW_PANE_ID = 8
local OVERFLOW_USER_VARS = { we_tab_role = 'overflow' }

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
    active_pane = {
      pane_id = opts.pane_id or PANE_ID,
      -- PaneInformation exposes user vars as a plain field (MuxPane uses
      -- a getter); this is the shape format-tab-title hands tab_badge.
      user_vars = opts.user_vars,
    },
    tab_title = opts.tab_title,
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

  it('carries status only — nothing that would occupy width in the tab', function()
    reset()
    local now = os.time() * 1000
    local badge = badge_for(state(
      entry('running', '@2', '%5', 'running', now, 'dev/auth')
    ))
    assert_eq(badge.status, 'running', 'status missing')
    -- The tab renders status by recoloring its own title. Anything
    -- returned here that the caller would print re-flows the tab strip
    -- as turns start and end — the `marker = '█'` cell did exactly that
    -- until 2026-08-19, and a label was reverted before it.
    assert_falsy(badge.marker, 'badge grew a marker cell again; that jitters the tab strip')
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

-- Regression: the overflow placeholder must resolve its session from
-- the in-memory tier only. wezterm recycles pane ids across restarts and
-- open-project-session.sh never deletes the `pane-session/<id>.txt` it
-- writes for managed panes, so a fresh placeholder routinely inherits an
-- id whose leftover file names the previous occupant's session. Honouring
-- that file made one running agent paint its badge on both its own tab
-- and `…` (observed 2026-08-19 on the work workspace: pane 6 read an
-- 08-03 file naming coco-forge). The snapshot's staleness guard cannot
-- catch it — the leftover names a session in the *same* workspace.
describe('tab_badge on the overflow placeholder', function()
  local function overflow_reset()
    reset()
    pane_session_files.clear()
    -- The placeholder holds no in-memory edge: this is the post-reload
    -- state, where _G was wiped but the leftover file survives.
    tab_visibility.forget_pane_session(OVERFLOW_PANE_ID)
    pane_session_files.write(OVERFLOW_PANE_ID, SESSION)
  end

  local function running_state()
    return state(entry('running', '@2', '%5', 'running', os.time() * 1000, 'dev/auth'))
  end

  it('still badges the real tab hosting the session (control)', function()
    overflow_reset()
    local badge = badge_for(running_state())
    assert_truthy(badge, 'the managed tab lost its badge')
    assert_eq(badge.status, 'running', 'unexpected status on the managed tab')
  end)

  it('ignores a recycled pane id leftover file (user_var marker)', function()
    overflow_reset()
    local badge = badge_for(running_state(), {
      pane_id = OVERFLOW_PANE_ID,
      user_vars = OVERFLOW_USER_VARS,
    })
    assert_falsy(badge, 'overflow tab inherited the previous occupant session badge')
  end)

  it('ignores it for a pre-marker placeholder too (title fallback)', function()
    overflow_reset()
    local badge = badge_for(running_state(), {
      pane_id = OVERFLOW_PANE_ID,
      tab_title = '…',
    })
    assert_falsy(badge, 'title-identified overflow tab honoured the leftover file')
  end)

  it('still badges a real projection (Alt+x) held in memory', function()
    overflow_reset()
    -- What tab.activate_overflow writes after a switch-client: the
    -- placeholder genuinely displays SESSION, so the badge belongs here.
    tab_visibility.set_pane_session(OVERFLOW_PANE_ID, SESSION)
    local badge = badge_for(running_state(), {
      pane_id = OVERFLOW_PANE_ID,
      user_vars = OVERFLOW_USER_VARS,
    })
    assert_truthy(badge, 'projected session lost its badge on the overflow tab')
    assert_eq(badge.status, 'running', 'unexpected status on the overflow tab')
    pane_session_files.clear()
  end)
end)

describe('badge_colors paints an unfocused tab its status block', function()
  -- The focused tab keeps the active pair regardless of status
  -- (titles.lua priority 1), so this map only ever reaches unfocused
  -- tabs — and it is the same block pairing the right-status counters
  -- use, which is why both surfaces read as one system.
  local PALETTE = {
    tab_bar_background = '#f1f0e9',
    tab_accent = '#b07d48',
    tab_attention_waiting_bg = '#ddbe9f',
    tab_attention_waiting_fg = '#493624',
    tab_attention_done_bg = '#b2cdac',
    tab_attention_done_fg = '#2f402c',
    tab_attention_running_bg = '#bfd3eb',
    tab_attention_running_fg = '#364960',
  }

  it('returns the block pair for every status', function()
    for status, want in pairs({
      waiting = { '#ddbe9f', '#493624' },
      done = { '#b2cdac', '#2f402c' },
      running = { '#bfd3eb', '#364960' },
    }) do
      local bg, fg = attention.badge_colors(PALETTE, status)
      assert_eq(bg, want[1], status .. ' bg')
      assert_eq(fg, want[2], status .. ' fg')
    end
  end)

  it('hands an unknown status something drawable rather than nil', function()
    -- A nil here would reach wezterm.format as a Color and take the
    -- whole tab bar down, so the fallback is load-bearing.
    local bg, fg = attention.badge_colors(PALETTE, 'bogus')
    assert_eq(bg, PALETTE.tab_bar_background, 'unknown status bg')
    assert_eq(fg, PALETTE.tab_accent, 'unknown status fg')
  end)
end)

io.write(string.format('\n%d passed, %d failed\n', pass_count, fail_count))
os.exit(fail_count == 0 and 0 or 1)
