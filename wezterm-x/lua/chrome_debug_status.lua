-- Chrome debug browser status segment.
--
-- Reads the JSON state file written by the Windows host helper after each
-- successful Alt+b / Alt+Shift+b request (ChromeRequestHandler.WriteState in
-- native/host-helper/windows/src/HelperManager). Renders a compact
-- right-status segment that stays at a fixed visual width so the bar does
-- not jitter between states:
--
--   CDP·H·9222   headless mode (helper's last success was headless)
--   CDP·V·9222   visible  mode (helper's last success was headful)
--   CDP·-·9222   no state file yet / unreadable (fallback port from config)
--
-- There is no liveness probe: if Chrome is killed externally, the segment
-- keeps showing the last known mode until the user presses Alt+b or
-- Alt+Shift+b again. This trade-off keeps update-status (250 ms cadence)
-- free of synchronous subprocesses.

local wezterm = require 'wezterm'

local M = {}

local state_path = nil
local fallback_port = nil

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

function M.render_status_segment(palette)
  local state = M.reload_state()

  local mode_letter, port, bg, fg, intensity, italic
  if state and state.mode == 'headless' then
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
