-- Verifies wezterm-x/lua/plugin_host.lua (plugin badge loading / rendering).
--
-- Properties that are easy to regress:
-- 1. Badges render in registry order; ${runtime_state_dir} / ${plugin_dir}
--    expand and '/' becomes the host path separator.
-- 2. requires_host filters by runtime_mode.
-- 3. Missing registry, a module that fails to load, a render error — each
--    drops only that badge and logs once under category `plugins`.
-- 4. A machine override still using a moved constants key warns once.
-- 5. Parity: the real load-guard plugin rendered through the host equals the
--    module rendered directly (same text, colours, attributes).
--
-- Drive with scripts/dev/test-lua-units.sh.

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

local fake_now_ms = 100000
mock.time = {
  now = function()
    return setmetatable({}, {
      __index = function() return function() return tostring(fake_now_ms) end end,
    })
  end,
}

local host_mod = dofile './wezterm-x/lua/plugin_host.lua'

-- Tests that do not exercise SDK loading run with the SDK already registered.
local SDK_PATH = './wezterm-x/lua/badge_common.lua'
package.loaded['wezdeck.badge'] = dofile(SDK_PATH)

local tmp = os.getenv('TMPDIR') or '/tmp'
local root = tmp .. '/wezdeck-plugin-host-test-' .. tostring(os.time()) .. '-' .. tostring(math.random(1e6))
os.execute('mkdir -p ' .. root .. '/plugins/a/lua ' .. root .. '/plugins/b/lua ' .. root .. '/plugins/broken/lua ' .. root .. '/plugins/boom/lua')

local function write(path, text)
  local f = assert(io.open(path, 'w'))
  f:write(text)
  f:close()
end

-- Badge module that echoes its config so the test can see expansion.
local echo_module = [[
local M = { cfg = {} }
function M.configure(c) M.cfg = c end
function M.render_status_segment(palette) return 'seg:' .. (M.cfg.label or '?') .. ':' .. (M.cfg.path or '') end
return M
]]
write(root .. '/plugins/a/lua/badge.lua', echo_module)
write(root .. '/plugins/b/lua/badge.lua', echo_module)
write(root .. '/plugins/broken/lua/badge.lua', 'this is not lua (')
write(root .. '/plugins/boom/lua/badge.lua', 'return { render_status_segment = function() error("kaboom") end }')
write(root .. '/plugins/registry.generated.lua', [[
return { version = 1, badges = {
  { id = 'b', dir = 'plugins/b', module = 'lua/badge.lua', order = 20, requires_host = {},
    config = { label = 'B', path = '${runtime_state_dir}/state/b.json' } },
  { id = 'a', dir = 'plugins/a', module = 'lua/badge.lua', order = 10, requires_host = { 'hybrid-wsl' },
    config = { label = 'A', path = '${plugin_dir}/x' } },
  { id = 'posixonly', dir = 'plugins/a', module = 'lua/badge.lua', order = 15, requires_host = { 'posix' },
    config = { label = 'P' } },
  { id = 'broken', dir = 'plugins/broken', module = 'lua/badge.lua', order = 30, requires_host = {}, config = {} },
  { id = 'boom', dir = 'plugins/boom', module = 'lua/badge.lua', order = 40, requires_host = {}, config = {} },
} }
]])

local function new_logger()
  local log = { rows = {} }
  log.warn = function(category, message, fields)
    table.insert(log.rows, { category = category, message = message, fields = fields })
  end
  return log
end

io.write('\xE2\x96\xB8 plugin_host\n')

it('renders in order, expands vars, filters by host, isolates failures', function()
  local log = new_logger()
  local h = host_mod.new {
    runtime_dir = root, runtime_state_dir = 'C:\\state', runtime_mode = 'hybrid-wsl',
    logger = log, path_sep = '\\', registry_path = root .. '/plugins/registry.generated.lua',
  }
  -- `path_sep='\\'` only affects joins; dofile still needs real paths, so
  -- rebuild with '/' for loading and check expansion via a second host.
  local h2 = host_mod.new {
    runtime_dir = root, runtime_state_dir = '/state', runtime_mode = 'hybrid-wsl', logger = log, path_sep = '/',
  }
  local segs = h2.render_segments({})
  assert_eq(#segs, 2, 'a + b render; broken + boom dropped; posix-only filtered')
  assert_eq(segs[1], 'seg:A:' .. root .. '/plugins/a/x')
  assert_eq(segs[2], 'seg:B:/state/state/b.json')
  assert_eq(table.concat(h2.ids(), ','), 'a,b,boom', 'boom loads but fails at render')
  local cats = {}
  for _, r in ipairs(log.rows) do cats[r.message] = (cats[r.message] or 0) + 1 end
  assert(cats['plugin badge module failed to load'], 'broken module logged')
  assert(cats['plugin badge render failed'], 'render error logged')
  h2.render_segments({})
  local renders = 0
  for _, r in ipairs(log.rows) do if r.message == 'plugin badge render failed' then renders = renders + 1 end end
  assert_eq(renders, 1, 'render failure logged once, not every tick')
  assert(h, 'backslash host constructed')
end)

it('backslash path_sep rewrites template separators', function()
  local e = host_mod.expand
  assert_eq(e('${runtime_state_dir}/state/a.json', { runtime_state_dir = 'C:\\s' }, '\\'), 'C:\\s\\state\\a.json')
  assert_eq(e('plain/value', { runtime_state_dir = 'C:\\s' }, '\\'), 'plain/value', 'non-template strings untouched')
  assert_eq(e(20000, {}, '\\'), 20000, 'non-strings untouched')
  assert_eq(e('${plugin_dir}/x', { plugin_dir = '/p' }, '/'), '/p/x')
end)

it('missing registry yields no badges and one warning', function()
  local log = new_logger()
  local h = host_mod.new { runtime_dir = root .. '/nope', runtime_state_dir = '/s', runtime_mode = 'hybrid-wsl',
    logger = log, path_sep = '/' }
  assert_eq(#h.render_segments({}), 0)
  assert_eq(#log.rows, 1)
  assert_eq(log.rows[1].category, 'plugins')
end)

it('registers the badge SDK from sdk_path when not yet loaded', function()
  local saved = package.loaded['wezdeck.badge']
  package.loaded['wezdeck.badge'] = nil
  local log = new_logger()
  host_mod.new { runtime_dir = root, runtime_state_dir = '/s', runtime_mode = 'hybrid-wsl', logger = log,
    path_sep = '/', sdk_path = SDK_PATH }
  assert(type(package.loaded['wezdeck.badge']) == 'table', 'SDK registered')
  assert(type(package.loaded['wezdeck.badge'].read_file) == 'function')
  package.loaded['wezdeck.badge'] = nil
  local log2 = new_logger()
  host_mod.new { runtime_dir = root, runtime_state_dir = '/s', runtime_mode = 'hybrid-wsl', logger = log2,
    path_sep = '/', sdk_path = root .. '/missing.lua' }
  local sdk_warn = 0
  for _, r in ipairs(log2.rows) do if r.message:find('badge SDK failed', 1, true) then sdk_warn = sdk_warn + 1 end end
  assert_eq(sdk_warn, 1, 'missing SDK warns')
  package.loaded['wezdeck.badge'] = saved
end)

it('moved constants key in a machine override warns once', function()
  local log = new_logger()
  host_mod.new { runtime_dir = root, runtime_state_dir = '/s', runtime_mode = 'hybrid-wsl', logger = log,
    path_sep = '/', constants = { oppo_remote = { warn_pct = 5 } } }
  local found = 0
  for _, r in ipairs(log.rows) do if r.fields and r.fields.legacy_key == 'oppo_remote' then found = found + 1 end end
  assert_eq(found, 1)
end)

it('parity: real load-guard plugin via host == module rendered directly', function()
  local state_dir = root .. '/state'
  os.execute('mkdir -p ' .. state_dir .. '/state/oom-guard')
  local status_path = state_dir .. '/state/oom-guard/status.json'
  local palette = {
    tab_inactive_bg = '#111', tab_inactive_fg = '#eee', tab_bar_background = '#000', new_tab_fg = '#999',
    tab_attention_waiting_bg = '#a80', tab_attention_waiting_fg = '#fff', disk_crit_bg = '#b45', disk_crit_fg = '#fef',
    mem_crit_bg = '#c00', mem_crit_fg = '#fff',
  }
  -- Registry pointing at the repo's real built-in plugin, with its real config.
  local repo = io.popen('pwd'):read('*l')
  local reg = root .. '/plugins/reg-real.lua'
  write(reg, [[return { badges = { { id = 'load-guard', dir = 'wezterm-x/plugins/load-guard',
    module = 'lua/badge.lua', order = 50, requires_host = { 'hybrid-wsl' },
    config = { state_file = '${runtime_state_dir}/state/oom-guard/status.json',
               heartbeat_timeout_ms = 90000, warn_loadavg_1 = 8, crit_loadavg_1 = 16 } } } }]])
  local h = host_mod.new { runtime_dir = repo, runtime_state_dir = state_dir, runtime_mode = 'hybrid-wsl',
    path_sep = '/', registry_path = reg, logger = new_logger() }
  assert_eq(table.concat(h.ids(), ','), 'load-guard')
  local direct = dofile './wezterm-x/plugins/load-guard/lua/badge.lua'
  direct.configure { state_file = status_path, heartbeat_timeout_ms = 90000, warn_loadavg_1 = 8, crit_loadavg_1 = 16 }
  local function same(a, b)
    if type(a) ~= type(b) then return false end
    if type(a) ~= 'table' then return a == b end
    for k, v in pairs(a) do if not same(v, b[k]) then return false end end
    for k in pairs(b) do if a[k] == nil then return false end end
    return true
  end
  local fixtures = {
    string.format('{"loadavg_1":0.9,"heartbeat_at_ms":%d}', fake_now_ms),
    string.format('{"loadavg_1":9.4,"heartbeat_at_ms":%d}', fake_now_ms),
    string.format('{"loadavg_1":23.6,"heartbeat_at_ms":%d}', fake_now_ms),
    string.format('{"level":"crit","heartbeat_at_ms":%d}', fake_now_ms),
    string.format('{"loadavg_1":23.6,"heartbeat_at_ms":%d}', fake_now_ms - 600000),
  }
  local rendered = 0
  for i, body in ipairs(fixtures) do
    write(status_path, body)
    local via_host = h.render_segments(palette)[1]
    local via_module = direct.render_status_segment(palette)
    assert(same(via_host, via_module), 'fixture ' .. i .. ' differs')
    if via_host then rendered = rendered + 1 end
  end
  assert_eq(rendered, 2, 'warn + crit render; healthy / no reading / stale stay absent')
end)

os.execute('rm -rf ' .. root)
io.write(string.format('plugin_host: %d passed, %d failed\n', pass_count, fail_count))
if fail_count > 0 then os.exit(1) end
