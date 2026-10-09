-- Reachability sweep on write_live_snapshot:
--
--   1. Empty sessions_map must NOT archive live done/waiting/running
--      (incomplete mux walk ≠ "everything gone").
--   2. A truly unreachable done is forgotten per-entry; a sibling
--      running on the same tmux session must survive (no session-wide
--      collateral from the snapshot path).
--
-- Regression lock for 2026-10-09: live-panes showed sessions:{} + only
-- pane 0, then forget_by_tmux_session wiped running within ~1s.

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
  if ok then
    pass_count = pass_count + 1
    io.write('  ✓ ' .. n .. '\n')
  else
    fail_count = fail_count + 1
    io.write('  ✗ ' .. n .. '\n    ' .. tostring(err) .. '\n')
  end
end
local function assert_eq(a, b, m)
  if a ~= b then
    error((m or '') .. ' expected=' .. tostring(b) .. ' actual=' .. tostring(a), 2)
  end
end
local function assert_truthy(v, m) if not v then error(m or 'expected truthy', 2) end end
local function assert_falsy(v, m) if v then error((m or 'expected falsy') .. ': ' .. tostring(v), 2) end end

local function reset()
  _G.__WEZTERM_PANE_TMUX_SESSION = {}
  _G.__WEZTERM_TAB_OVERFLOW = {}
  mock.reset_mux()
end

local function forget_targets(recorded)
  local out = {}
  for _, args in ipairs(recorded) do
    for i, a in ipairs(args) do
      if a == '--forget' and args[i + 1] then
        out[args[i + 1]] = true
      end
    end
  end
  return out
end

-- Stand up state + recording forget_spawner, run one snapshot, return
-- recorded --forget targets and in-memory cache sids still present.
local function run_snapshot(entries_json, mux_spec, pane_sessions)
  local tmp = os.tmpname() .. '.d'
  os.execute('mkdir -p ' .. tmp)
  local state_file = tmp .. '/state.json'
  local fd = io.open(state_file, 'w')
  fd:write(entries_json)
  fd:close()

  local recorded = {}
  attention.register {
    state_file = state_file,
    forget_spawner = function(args)
      table.insert(recorded, args)
      return { 'true' }
    end,
  }
  attention.reload_state()

  for pane_id, session in pairs(pane_sessions or {}) do
    tab_visibility.set_pane_session(pane_id, session)
  end
  mock.set_mux(mux_spec)

  local out = tmp .. '/live-panes.json'
  attention.write_live_snapshot(out, 'reachability-test')

  local cache = attention.reload_state()
  local surviving = {}
  for sid, _ in pairs(cache.entries or {}) do
    surviving[sid] = true
  end

  os.execute('rm -rf ' .. tmp)
  return forget_targets(recorded), surviving
end

describe('reachability sweep: empty sessions_map', function()
  it('keeps done/waiting/running when snapshot has no host reverse map', function()
    reset()
    local now = os.time() * 1000
    local sess = 'wezterm_work_ai-video-collection_aaaaaaaaaa'
    local entries = '{"version":1,"entries":{'
      .. '"done1":{"session_id":"done1","wezterm_pane_id":"5",'
        .. '"tmux_session":"' .. sess .. '",'
        .. '"tmux_socket":"/tmp/sock","tmux_window":"@13","tmux_pane":"%21",'
        .. '"status":"done","ts":' .. tostring(now) .. ',"reason":"task done"},'
      .. '"run1":{"session_id":"run1","wezterm_pane_id":"5",'
        .. '"tmux_session":"' .. sess .. '",'
        .. '"tmux_socket":"/tmp/sock","tmux_window":"@15","tmux_pane":"%26",'
        .. '"status":"running","ts":' .. tostring(now) .. ',"reason":""}'
      .. '}}'

    -- Mux only sees an unrelated default pane — no pane→session edge,
    -- so sessions_map stays empty (the 2026-10-09 production shape).
    local forgotten, surviving = run_snapshot(entries, {
      windows = {
        { workspace = 'default', tabs = {
          { id = 1, title = 'wsl.exe', active_pane = { id = 0 } },
        }},
      },
    }, {})

    assert_eq(next(forgotten), nil, 'empty sessions_map must not forget')
    assert_truthy(surviving.done1, 'done1 should survive incomplete snapshot')
    assert_truthy(surviving.run1, 'run1 should survive incomplete snapshot')
  end)
end)

describe('live-panes clobber guard', function()
  it('refuses to overwrite a fresh non-empty sessions map with sessions:{}', function()
    reset()
    local tmp = os.tmpname() .. '.d'
    os.execute('mkdir -p ' .. tmp)
    local state_file = tmp .. '/state.json'
    local live = tmp .. '/live-panes.json'
    local fd = io.open(state_file, 'w')
    fd:write('{"version":1,"entries":{},"recent":[]}')
    fd:close()

    -- Seed a rich snapshot as if the primary mux just wrote it.
    local now = os.time() * 1000
    local rich = io.open(live, 'w')
    rich:write('{"ts":' .. tostring(now)
      .. ',"panes":{"5":{"workspace":"work","tab_index":1,"tab_title":"ai"}},'
      .. '"sessions":{"wezterm_work_ai-video-collection_aaaaaaaaaa":"5"},'
      .. '"picker_rows":[],"picker_counts":{}}')
    rich:close()

    attention.register {
      state_file = state_file,
      forget_spawner = function() return { 'true' } end,
    }
    attention.reload_state()

    -- Sparse mux: only default pane 0, no session edges.
    mock.set_mux({
      windows = {
        { workspace = 'default', tabs = {
          { id = 1, title = 'wsl.exe', active_pane = { id = 0 } },
        }},
      },
    })

    local ok = attention.write_live_snapshot(live, 'clobber-test')
    assert_falsy(ok, 'sparse writer must return false when refusing clobber')

    local body = io.open(live, 'r'):read('*a')
    assert_truthy(body:find('wezterm_work_ai-video-collection_aaaaaaaaaa', 1, true),
      'rich sessions map must survive; body=' .. body)

    os.execute('rm -rf ' .. tmp)
  end)
end)

describe('reachability sweep: per-entry forget', function()
  it('archives unreachable done but keeps running on the same dead session', function()
    reset()
    local now = os.time() * 1000
    -- Reachability is session-level: both entries share a tmux session
    -- that has no wezterm host. sessions_map is non-empty only because
    -- an unrelated alive session is hosted — otherwise the empty-map
    -- guard would skip the sweep entirely.
    local dead = 'wezterm_work_ai-video-collection_aaaaaaaaaa'
    local alive = 'wezterm_work_coco-platform_bbbbbbbbbb'
    local entries = '{"version":1,"entries":{'
      .. '"done1":{"session_id":"done1","wezterm_pane_id":"99",'
        .. '"tmux_session":"' .. dead .. '",'
        .. '"tmux_socket":"/tmp/sock","tmux_window":"@13","tmux_pane":"%21",'
        .. '"status":"done","ts":' .. tostring(now) .. ',"reason":"task done"},'
      .. '"run1":{"session_id":"run1","wezterm_pane_id":"98",'
        .. '"tmux_session":"' .. dead .. '",'
        .. '"tmux_socket":"/tmp/sock","tmux_window":"@15","tmux_pane":"%26",'
        .. '"status":"running","ts":' .. tostring(now) .. ',"reason":""}'
      .. '}}'

    local forgotten, surviving = run_snapshot(entries, {
      windows = {
        { workspace = 'work', tabs = {
          { id = 100, title = 'coco-platform', active_pane = { id = 5 } },
        }},
      },
    }, {
      [5] = alive,
    })

    assert_truthy(forgotten.done1, 'unreachable done must be forgotten')
    assert_falsy(forgotten.run1, 'running exemption: must not be session-wide collateral')
    assert_falsy(surviving.done1, 'done1 should be optimistically hidden')
    assert_truthy(surviving.run1, 'run1 must remain in cache')
  end)

  it('archives unreachable waiting the same way', function()
    reset()
    local now = os.time() * 1000
    local alive = 'wezterm_work_alive_bbbbbbbbbb'
    local dead = 'wezterm_work_dead_cccccccccc'
    local entries = '{"version":1,"entries":{'
      .. '"wait1":{"session_id":"wait1","wezterm_pane_id":"99",'
        .. '"tmux_session":"' .. dead .. '",'
        .. '"tmux_socket":"/tmp/sock","tmux_window":"@9","tmux_pane":"%9",'
        .. '"status":"waiting","ts":' .. tostring(now) .. ',"reason":"approve"}'
      .. '}}'

    local forgotten, surviving = run_snapshot(entries, {
      windows = {
        { workspace = 'work', tabs = {
          { id = 100, title = 'alive', active_pane = { id = 5 } },
        }},
      },
    }, {
      [5] = alive,
    })

    assert_truthy(forgotten.wait1, 'unreachable waiting must be forgotten')
    assert_falsy(surviving.wait1, 'wait1 should be optimistically hidden')
  end)
end)

io.write(string.format('\n%d passed, %d failed\n', pass_count, fail_count))
if fail_count > 0 then os.exit(1) end
