local wezterm = require 'wezterm'
local config = wezterm.config_builder()
local path_sep = package.config:sub(1, 1)

local function join_path(...)
  return table.concat({ ... }, path_sep)
end

local runtime_dir = rawget(_G, 'WEZTERM_RUNTIME_DIR')
if not runtime_dir or runtime_dir == '' then
  runtime_dir = join_path(wezterm.config_dir, '.wezterm-x')
end

local function load_module(name)
  return dofile(join_path(runtime_dir, 'lua', name .. '.lua'))
end

local constants = load_module 'constants'
local helpers = load_module 'helpers'
local titles = load_module 'titles'
local ui = load_module 'ui'
local workspace_manager = load_module 'workspace_manager'
local attention = load_module 'attention'
local chrome_debug_status = load_module 'chrome_debug_status'
local session_bridge_status = load_module 'session_bridge_status'
local disk_status = load_module 'disk_status'
local mem_status = load_module 'mem_status'
local logger = load_module('logger').new {
  wezterm = wezterm,
  constants = constants,
}
local host = load_module('host').new {
  wezterm = wezterm,
  constants = constants,
  helpers = helpers,
  logger = logger,
}

config.debug_key_events = constants.diagnostics
  and constants.diagnostics.wezterm
  and constants.diagnostics.wezterm.debug_key_events == true
  or false

local tab_visibility = load_module 'ui/tab_visibility'
tab_visibility.configure {
  wezterm = wezterm,
  logger = logger,
  config = constants.tab_visibility,
}

local workspace = workspace_manager.new {
  wezterm = wezterm,
  config = config,
  constants = constants,
  tab_visibility = tab_visibility,
}

local vscode_integration = (constants.integrations and constants.integrations.vscode) or {}
chrome_debug_status.configure {
  state_file = constants.chrome_debug_browser and constants.chrome_debug_browser.state_file,
  fallback_port = constants.chrome_debug_browser and constants.chrome_debug_browser.remote_debugging_port,
  helper_state_file = vscode_integration.helper_state_path,
  helper_heartbeat_timeout_ms = (vscode_integration.helper_heartbeat_timeout_seconds or 5) * 1000,
}

local sb_watch = constants.session_bridge_watch or {}
session_bridge_status.configure {
  state_file = sb_watch.status_file,
  heartbeat_timeout_ms = sb_watch.heartbeat_timeout_ms,
  icon = sb_watch.icon,
}

local disk_guard = constants.disk_guard or {}
disk_status.configure {
  state_file = disk_guard.status_file,
  heartbeat_timeout_ms = disk_guard.heartbeat_timeout_ms,
}

local mem_guard = constants.mem_guard or {}
mem_status.configure {
  state_file = mem_guard.status_file,
  heartbeat_timeout_ms = mem_guard.heartbeat_timeout_ms,
}

titles.register {
  wezterm = wezterm,
  palette = constants.palette,
  attention = attention,
  chrome_debug_status = chrome_debug_status,
  session_bridge_status = session_bridge_status,
  disk_status = disk_status,
  mem_status = mem_status,
  host = host,
  logger = logger,
  constants = constants,
  tab_visibility = tab_visibility,
  workspace = workspace,
}

local layout_heal = load_module 'layout_heal'
layout_heal.register {
  wezterm = wezterm,
  constants = constants,
  logger = logger,
}
-- Expose for action_registry font-size handlers (same process, shared debounce).
_G.__WEZTERM_LAYOUT_HEAL = layout_heal

-- Canary probe: when bootstrap lives under …/wezterm-runtime/canary/,
-- write healthy.stamp as soon as the GUI process starts so
-- scripts/dev/wezterm-canary.sh --auto can promote without a human click.
-- If canary/auto-quit.flag exists (--auto creates it; --launch does not),
-- quit this isolated process shortly after the stamp so the probe window
-- does not linger.
do
  local config_dir = wezterm.config_dir or ''
  local is_canary = config_dir:match('[/\\]canary[/\\]?$') ~= nil
    or config_dir:match('[/\\]canary$') ~= nil
  if is_canary then
    wezterm.on('gui-startup', function()
      local stamp = join_path(config_dir, 'healthy.stamp')
      local fd = io.open(stamp, 'wb')
      if not fd then
        if logger and logger.warn then
          logger.warn('canary', 'failed to write healthy.stamp', { path = stamp })
        end
        return
      end
      local ts = tostring(os.time())
      fd:write('ok=1\n')
      fd:write('ts=' .. ts .. '\n')
      fd:write('config_dir=' .. config_dir .. '\n')
      fd:close()
      if logger and logger.info then
        logger.info('canary', 'wrote healthy.stamp', { path = stamp })
      end

      local quit_flag = join_path(config_dir, 'auto-quit.flag')
      local qfd = io.open(quit_flag, 'rb')
      if not qfd then
        return
      end
      qfd:close()
      -- Brief delay so the waiter can observe the stamp before this
      -- --always-new-process instance exits.
      if wezterm.time and wezterm.time.call_after then
        wezterm.time.call_after(0.6, function()
          local ok_gui, windows = pcall(function()
            return wezterm.gui.gui_windows()
          end)
          if not ok_gui or type(windows) ~= 'table' then
            return
          end
          for _, gui_win in ipairs(windows) do
            pcall(function()
              local pane = gui_win:active_pane()
              gui_win:perform_action(wezterm.action.QuitApplication, pane)
            end)
          end
        end)
      end
    end)
  end
end

ui.apply {
  wezterm = wezterm,
  config = config,
  constants = constants,
  workspace = workspace,
  attention = attention,
  logger = logger,
  host = host,
}

return config
