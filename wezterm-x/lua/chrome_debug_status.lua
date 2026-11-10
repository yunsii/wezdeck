-- Unified browser-slot status segment (right-status).
--
-- When browser-agent status says backend=ego, renders (ASCII marks so the
-- tab-bar font width matches CDP·H and does not leave a blank hole):
--   Ego·A   ego process recently seen alive
--   Ego·-   ego not running
--   Ego·?   ego heartbeat stale / unknown
--
-- Otherwise (backend=cdp or status missing) keeps the CDP badge:
--   CDP·H·9222 / CDP·V·9222 / CDP·-·9222 / CDP·?·9222
--
-- CDP state: chrome-debug/state.json + helper state.env (unchanged).
-- Ego / backend: state/browser-agent/status.json (apply-browser-backend,
-- ego-browser wrapper, Alt+b ego path).

local wezterm = require 'wezterm'

local M = {}

local state_path = nil
local helper_state_path = nil
local helper_heartbeat_timeout_ms = 5000
local fallback_port = nil
local browser_agent_status_path = nil
local ego_heartbeat_timeout_ms = 120000

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
  if opts and type(opts.browser_agent_status_file) == 'string' and opts.browser_agent_status_file ~= '' then
    browser_agent_status_path = opts.browser_agent_status_file
  end
  if opts and type(opts.ego_heartbeat_timeout_ms) == 'number' and opts.ego_heartbeat_timeout_ms > 0 then
    ego_heartbeat_timeout_ms = opts.ego_heartbeat_timeout_ms
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

function M.reload_browser_agent_status()
  if not browser_agent_status_path then
    return nil
  end
  local content = read_file(browser_agent_status_path)
  if not content or content == '' then
    return nil
  end
  local parsed = parse_json(content)
  if type(parsed) == 'table' and type(parsed.backend) == 'string' then
    return parsed
  end
  return nil
end

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

local function render_parts(text, bg, fg, intensity, italic)
  return wezterm.format {
    { Background = { Color = bg } },
    { Foreground = { Color = fg } },
    { Attribute = { Intensity = intensity } },
    { Attribute = { Italic = italic } },
    { Text = text },
  }
end

local function render_ego_segment(palette, agent)
  local ego = type(agent.ego) == 'table' and agent.ego or {}
  local updated = tonumber(ego.updated_at_ms) or tonumber(agent.updated_at_ms) or 0
  local age = current_epoch_ms() - updated
  local mark, bg, fg, intensity, italic

  if updated <= 0 or age > ego_heartbeat_timeout_ms then
    mark = '?'
    bg = palette.tab_bar_background
    fg = (palette.ansi and palette.ansi[2]) or palette.new_tab_fg
    intensity = 'Normal'
    italic = true
  elseif ego.alive == true then
    mark = 'A'
    bg = palette.tab_attention_running_bg
    fg = palette.tab_attention_running_fg
    intensity = 'Bold'
    italic = false
  else
    mark = '-'
    bg = palette.tab_bar_background
    fg = palette.new_tab_fg
    intensity = 'Normal'
    italic = true
  end

  -- Same left/right padding as CDP·H·port; single ASCII mark avoids
  -- double-width ✓/– leaving a blank hole in the right-status cluster.
  local text = string.format(' Ego·%s ', mark)
  return render_parts(text, bg, fg, intensity, italic)
end

local function render_cdp_segment(palette)
  local state = M.reload_state()
  local alive_helper = helper_is_alive()

  local mode_letter, port, bg, fg, intensity, italic
  if not alive_helper then
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
  return render_parts(text, bg, fg, intensity, italic)
end

function M.render_status_segment(palette)
  local agent = M.reload_browser_agent_status()
  if agent and agent.backend == 'ego' then
    return render_ego_segment(palette, agent)
  end
  return render_cdp_segment(palette)
end

return M
