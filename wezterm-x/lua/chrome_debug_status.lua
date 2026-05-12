-- Chrome debug browser status segment.
--
-- Reads the JSON state file written by the Windows host helper after each
-- successful Alt+b / Alt+Shift+b request, and after Chrome exits
-- (ChromeRequestHandler.WriteState / WriteStateNone, plus the
-- ChromeLivenessWatcher in native/host-helper/windows/src/HelperManager).
-- Renders a compact right-status segment that stays at a fixed visual width
-- so the bar does not jitter between states:
--
--   CDP·H·9222   helper alive, Chrome alive in headless mode
--   CDP·V·9222   helper alive, Chrome alive in visible  mode
--   CDP·-·9222   helper alive, Chrome not running (mode=none / alive=false)
--   CDP·?·9222   helper itself looks dead (helper state.env heartbeat stale)
--
-- The helper writes:
--   * state.env (heartbeat every helper_heartbeat_interval_ms, default 250 ms)
--   * chrome-debug/state.json (after every Alt+b request and on Chrome exit)
--
-- This module never spawns subprocesses; both files are local and small, and
-- both reads live inside the 250 ms update-status tick. helper-liveness is
-- decided here by reading the helper state.env heartbeat (the same signal
-- used by helper_state_preflight in host/runtime_helper.lua) -- chrome.json
-- never carries a heartbeat field; helper.env owns that signal.

local wezterm = require 'wezterm'

local M = {}

local state_path = nil
local helper_state_path = nil
local helper_heartbeat_timeout_ms = 5000
local fallback_port = nil

-- Last successfully parsed `heartbeat_at_ms` from state.env. The helper
-- rewrites that file every helper_heartbeat_interval_ms (250 ms) via
-- tmp+rename, and we read it on every update-status tick. On NTFS the
-- replace-existing move is atomic at the kernel level but `io.open` can
-- still race with it (ERROR_SHARING_VIOLATION / ERROR_FILE_NOT_FOUND);
-- without the cache a single missed read would flip the badge to `?`
-- for one frame even though the helper is healthy. Falling back to the
-- cached value lets the 5 s timeout do its real job.
local last_known_heartbeat_at_ms = nil

local function parse_json(text)
  if type(text) ~= 'string' or text == '' then
    return nil
  end
  if wezterm.json_parse then
    local ok, parsed = pcall(wezterm.json_parse, text)
    if ok then
      return parsed
    end
  end
  if wezterm.serde and wezterm.serde.json_decode then
    local ok, parsed = pcall(wezterm.serde.json_decode, text)
    if ok then
      return parsed
    end
  end
  return nil
end

local function read_file(path)
  local f = io.open(path, 'r')
  if not f then
    return nil
  end
  local content = f:read('*a')
  f:close()
  return content
end

function M.configure(opts)
  if opts and type(opts.state_file) == 'string' and opts.state_file ~= '' then
    state_path = opts.state_file
  end
  if opts and type(opts.fallback_port) == 'number' then
    fallback_port = opts.fallback_port
  end
  if opts and type(opts.helper_state_file) == 'string' and opts.helper_state_file ~= '' then
    helper_state_path = opts.helper_state_file
  end
  if opts and type(opts.helper_heartbeat_timeout_ms) == 'number' and opts.helper_heartbeat_timeout_ms > 0 then
    helper_heartbeat_timeout_ms = opts.helper_heartbeat_timeout_ms
  end
end

function M.reload_state()
  if not state_path then
    return nil
  end
  local content = read_file(state_path)
  if not content or content == '' then
    return nil
  end
  local parsed = parse_json(content)
  if type(parsed) == 'table' and type(parsed.mode) == 'string' and type(parsed.port) == 'number' then
    return parsed
  end
  return nil
end

-- Returns true if the helper looks alive (heartbeat fresh enough to trust).
-- We deliberately fail-open: when the helper state file isn't configured we
-- assume "alive" so single-host setups without a Windows helper do not see a
-- spurious "?" in the right status. The signal only fires when configure()
-- has been told a real helper_state_file path.
local function current_epoch_ms()
  local ok, formatted = pcall(function()
    return wezterm.time.now():format '%s%3f'
  end)
  if ok and type(formatted) == 'string' and formatted:match '^%d+$' then
    return tonumber(formatted)
  end
  return math.floor(os.time() * 1000)
end

local function helper_is_alive()
  if not helper_state_path or helper_state_path == '' then
    return true
  end
  local content = read_file(helper_state_path)
  local heartbeat_at_ms = nil
  if content and content ~= '' then
    for line in content:gmatch '[^\r\n]+' do
      local key, value = line:match '^([A-Za-z_][A-Za-z0-9_]*)%s*=%s*(.-)%s*$'
      if key == 'heartbeat_at_ms' then
        heartbeat_at_ms = tonumber(value)
        break
      end
    end
  end
  if heartbeat_at_ms then
    last_known_heartbeat_at_ms = heartbeat_at_ms
  else
    heartbeat_at_ms = last_known_heartbeat_at_ms
  end
  if not heartbeat_at_ms then
    return false
  end
  return (current_epoch_ms() - heartbeat_at_ms) <= helper_heartbeat_timeout_ms
end

function M.render_status_segment(palette)
  local state = M.reload_state()
  local alive_helper = helper_is_alive()

  local mode_letter, port, bg, fg, intensity, italic
  if not alive_helper then
    -- helper state.env heartbeat is stale -- the chrome state file may be
    -- arbitrarily out of date, so do not pretend to know Chrome's mode.
    mode_letter = '?'
    port = (state and state.port) or fallback_port or 0
    bg = palette.tab_bar_background
    fg = (palette.ansi and palette.ansi[2]) or palette.new_tab_fg
    intensity = 'Normal'
    italic = true
  elseif state and (state.alive == false or state.mode == 'none') then
    mode_letter = '-'
    port = state.port or fallback_port or 0
    bg = palette.tab_bar_background
    fg = palette.new_tab_fg
    intensity = 'Normal'
    italic = true
  elseif state and state.mode == 'headless' then
    mode_letter = 'H'
    port = state.port
    bg = palette.tab_inactive_bg
    fg = palette.tab_inactive_fg
    intensity = 'Normal'
    italic = false
  elseif state and state.mode == 'visible' then
    mode_letter = 'V'
    port = state.port
    bg = palette.tab_attention_running_bg
    fg = palette.tab_attention_running_fg
    intensity = 'Bold'
    italic = false
  else
    mode_letter = '-'
    port = fallback_port or 0
    bg = palette.tab_bar_background
    fg = palette.new_tab_fg
    intensity = 'Normal'
    italic = true
  end

  local text = string.format(' CDP·%s·%d ', mode_letter, math.floor(port))
  local parts = {
    { Background = { Color = bg } },
    { Foreground = { Color = fg } },
    { Attribute = { Intensity = intensity } },
    { Attribute = { Italic = italic } },
    { Text = text },
  }
  return wezterm.format(parts)
end

return M
