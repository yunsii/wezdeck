-- Unit tests for link.open_target helpers in ui/actions.lua
package.path = 'wezterm-x/lua/?.lua;wezterm-x/lua/?/init.lua;' .. package.path

local pass_count = 0
local fail_count = 0

local function assert_eq(name, got, want)
  if got == want then
    pass_count = pass_count + 1
    io.write('  ok  ' .. name .. '\n')
  else
    fail_count = fail_count + 1
    io.write(string.format('  FAIL %s: got=%s want=%s\n', name, tostring(got), tostring(want)))
  end
end

-- Stub ui/common.lua dependency path used by actions.lua
local runtime_dir = 'wezterm-x'
rawset(_G, 'WEZTERM_RUNTIME_DIR', runtime_dir)

local actions = dofile('wezterm-x/lua/ui/actions.lua')

io.write('\xE2\x96\xB8 link.open_target\n')

assert_eq('default when missing', actions.read_link_open_target({}), 'slot')
assert_eq('default when empty link', actions.read_link_open_target({ link = {} }), 'slot')
assert_eq('explicit slot', actions.read_link_open_target({ link = { open_target = 'slot' } }), 'slot')
assert_eq('legacy debug alias', actions.read_link_open_target({ link = { open_target = 'debug' } }), 'slot')
assert_eq('explicit system', actions.read_link_open_target({ link = { open_target = 'system' } }), 'system')
assert_eq('unknown falls back to slot', actions.read_link_open_target({ link = { open_target = 'browser' } }), 'slot')

-- publish writes a readable config file
local tmp = os.tmpname()
os.remove(tmp)
local config_path = tmp .. '-link-open.json'
local published = actions.publish_link_open_config({
  link = {
    open_target = 'system',
    config_file = config_path,
  },
  chrome_debug_browser = {
    executable = 'chrome.exe',
    remote_debugging_port = 9222,
    user_data_dir = 'C:\\tmp\\chrome-debug',
  },
  browser_agent = {},
}, nil, 'test')
assert_eq('publish returns true', published, true)

local f = io.open(config_path, 'r')
local body = f and f:read('*a') or ''
if f then f:close() end
assert_eq('publish open_target', body:match('"open_target"%s*:%s*"(.-)"'), 'system')
assert_eq('publish chrome_path', body:match('"chrome_path"%s*:%s*"(.-)"'), 'chrome.exe')
assert_eq('publish port', body:match('"remote_debugging_port"%s*:%s*(%d+)'), '9222')
os.remove(config_path)
os.remove(tmp)

io.write(string.format('link_open_target: %d passed, %d failed\n', pass_count, fail_count))
if fail_count > 0 then
  os.exit(1)
end
