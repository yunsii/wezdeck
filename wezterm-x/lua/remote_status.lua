-- OPPO 互联 remote-control link badge (Pad· on the right status).
--
-- Producer: `scripts/dev/oppo-remote-quality.sh daemon` (systemd user unit
-- wezterm-oppo-remote.service) tails the vendor's desktop_agent log and
-- republishes status.json every ~2 s while a remote session is active, every
-- 30 s while idle. See docs/oppo-remote-host-input.md#pad-badge.
--
-- Unlike WslDisk· / Memory·, this badge is visible for the whole remote
-- session: knowing the PC is being driven from the Pad is itself the signal.
--
--   (absent)   no active remote session, or never published
--   Pad·ok     connected, < warn_pct of the last 5 min stalled (muted)
--   Pad·23%    not stalled right now, but ≥ warn_pct of last 5 min was (amber)
--   Pad·4.4s   stalled now; picture ~4.4 s behind (red)
--   Pad·76%    stalled now without a queue-delay reading (encoder dropping) (red)
--   Pad·?      session was active and the producer went stale
--
-- Placement: right-status, after the session-bridge badge.

local wezterm = require 'wezterm'

local M = {}

local state_path = nil
local heartbeat_timeout_ms = 20000
local warn_pct = 10
local last_known = nil

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

local function current_epoch_ms()
  local ok, formatted = pcall(function()
    return wezterm.time.now():format '%s%3f'
  end)
  if ok and type(formatted) == 'string' and formatted:match '^%d+$' then
    return tonumber(formatted)
  end
  return math.floor(os.time() * 1000)
end

function M.configure(opts)
  if type(opts) ~= 'table' then
    return
  end
  if type(opts.state_file) == 'string' and opts.state_file ~= '' then
    state_path = opts.state_file
  end
  if type(opts.heartbeat_timeout_ms) == 'number' and opts.heartbeat_timeout_ms > 0 then
    heartbeat_timeout_ms = opts.heartbeat_timeout_ms
  end
  if type(opts.warn_pct) == 'number' and opts.warn_pct > 0 then
    warn_pct = opts.warn_pct
  end
end

function M.reload_state()
  if not state_path then
    return nil
  end
  local content = read_file(state_path)
  if not content or content == '' then
    return last_known
  end
  local parsed = parse_json(content)
  if type(parsed) == 'table' then
    last_known = parsed
    return parsed
  end
  return last_known
end

local function is_fresh(state)
  local hb = type(state) == 'table' and tonumber(state.heartbeat_at_ms) or nil
  if not hb then
    return false
  end
  return (current_epoch_ms() - hb) <= heartbeat_timeout_ms
end

local function label(state)
  local device = type(state.device) == 'string' and state.device or ''
  if device == '' or device:find('Pad', 1, true) then
    return 'Pad'
  end
  return 'Remote'
end

-- Pure text + level for the unit suite. Returns nil when nothing to show;
-- level is 'ok' | 'warn' | 'crit' | 'unknown'.
function M.format_text(state, fresh)
  if type(state) ~= 'table' or state.active ~= true then
    return nil
  end
  local name = label(state)
  if not fresh then
    return ' ' .. name .. '·? ', 'unknown'
  end
  local pct = tonumber(state.stall_pct_5m) or 0
  if state.state == 'stall' then
    local lag = tonumber(state.lag_ms) or 0
    if lag >= 1000 then
      return string.format(' %s·%.1fs ', name, lag / 1000), 'crit'
    end
    return string.format(' %s·%d%% ', name, pct), 'crit'
  end
  if pct >= warn_pct then
    return string.format(' %s·%d%% ', name, pct), 'warn'
  end
  return ' ' .. name .. '·ok ', 'ok'
end

function M.render_status_segment(palette)
  local state = M.reload_state()
  local text, level = M.format_text(state, is_fresh(state))
  if not text then
    return nil
  end
  local bg, fg, intensity, italic = palette.tab_inactive_bg, palette.tab_inactive_fg, 'Normal', false
  if level == 'crit' then
    bg = palette.disk_crit_bg or palette.tab_attention_waiting_bg
    fg = palette.disk_crit_fg or palette.tab_attention_waiting_fg
    intensity = 'Bold'
  elseif level == 'warn' then
    bg = palette.tab_attention_waiting_bg
    fg = palette.tab_attention_waiting_fg
    intensity = 'Bold'
  elseif level == 'unknown' then
    bg = palette.tab_bar_background
    fg = palette.new_tab_fg
    italic = true
  end
  return wezterm.format {
    { Background = { Color = bg } },
    { Foreground = { Color = fg } },
    { Attribute = { Intensity = intensity } },
    { Attribute = { Italic = italic } },
    { Text = text },
  }
end

return M
