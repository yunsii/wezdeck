-- OPPO 互联 remote-control link badge (OppoRemote· on the right status).
--
-- Named after the remote link, not the client device: what it measures is the
-- O+ Connect stream (Pad or phone), and the word must read on its own in a
-- crowded bar next to SystemDisk· / Memory·.
--
-- Producer: `bin/oppo-remote-quality.sh daemon` (systemd user unit
-- wezterm-oppo-remote.service) tails the vendor's desktop_agent log and
-- republishes status.json every ~2 s while a remote session is active, every
-- 10 s while idle. See docs/oppo.md#opporemote-badge.
--
-- Unlike WslDisk· / Memory·, this badge is visible for the whole remote
-- session: knowing the PC is being driven from the Pad is itself the signal.
--
--   (absent)   no active remote session, or never published
--   OppoRemote·OK     connected, < warn_pct of the last 5 min stalled (muted)
--   OppoRemote·23%    not stalled right now, but ≥ warn_pct of last 5 min was (amber)
--   OppoRemote·4.4s   stalled now; picture ~4.4 s behind (red)
--   OppoRemote·76%    stalled now without a queue-delay reading (encoder dropping) (red)
--   OppoRemote·?      session was active and the producer went stale
--
-- Placement: right-status, after the session-bridge badge.

local wezterm = require 'wezterm'
local badge = require 'wezdeck.badge'
local parse_json, read_file, current_epoch_ms = badge.parse_json, badge.read_file, badge.current_epoch_ms

local M = {}

local state_path = nil
local heartbeat_timeout_ms = 20000
local warn_pct = 10
local last_known = nil

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

-- Pure text + level for the unit suite. Returns nil when nothing to show;
-- level is 'ok' | 'warn' | 'crit' | 'unknown'.
function M.format_text(state, fresh)
  if type(state) ~= 'table' or state.active ~= true then
    return nil
  end
  local name = 'OppoRemote'
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
  return ' ' .. name .. '·OK ', 'ok'
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
