-- Host-disk status segment.
--
-- Reads the JSON published by scripts/runtime/wsl-disk-guard.sh into the
-- Windows-accessible runtime state dir (same FS as attention.json /
-- chrome-debug), so WezTerm Lua never crosses \\wsl$ on the 250 ms tick.
--
-- One number: headroom, meaning what the distro can still write. Neither
-- side's `df` answers that — the guest sees the vhdx's 1 TB virtual capacity
-- (5.7x overstated on a 256G partition here) and the host sees only what the
-- vhdx has not claimed yet. Headroom is host avail plus the gap inside the
-- vhdx, which the guest reuses in place.
--
-- The gap is deliberately not surfaced. On a dedicated WSL volume it is the
-- distro's own reserve rather than waste, so showing it would light up a
-- permanent hint that never needs acting on.
-- See docs/diagnostics.md "Host disk space".
--
-- **The badge renders nothing while healthy.** It appears only when there is
-- something to act on, so its mere presence in the bar is the signal — no
-- always-on number to learn to ignore, and no width spent on the common case.
--
--   (absent)   headroom at or above the warn threshold
--   D·22G      below warn (amber)
--   D·11G      below crit (red, and the guard pops a reminder on escalation)
--   D·?        sampler was publishing and went stale — the monitor itself
--              needs attention. Never published at all renders nothing, so a
--              machine without the guard installed sees a clean bar.
--
-- Placement: right-status, between the session-bridge and attention counters.

local wezterm = require 'wezterm'

local M = {}

local state_path = nil
-- The sampler runs on a 5 min timer; allow two misses plus slack before
-- calling the reading stale.
local heartbeat_timeout_ms = 780000
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
  if opts and type(opts.state_file) == 'string' and opts.state_file ~= '' then
    state_path = opts.state_file
  end
  if opts and type(opts.heartbeat_timeout_ms) == 'number' and opts.heartbeat_timeout_ms > 0 then
    heartbeat_timeout_ms = opts.heartbeat_timeout_ms
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
  if type(state) ~= 'table' then
    return false
  end
  local hb = tonumber(state.heartbeat_at_ms)
  if not hb then
    return false
  end
  return (current_epoch_ms() - hb) <= heartbeat_timeout_ms
end

-- Whole GiB below 100, one decimal is noise on a status bar. Values at or
-- above 1000G would widen the badge, so they collapse to a T suffix.
local function format_gib(bytes)
  local n = tonumber(bytes)
  if not n or n < 0 then
    return nil
  end
  local g = n / 1073741824
  if g >= 1000 then
    return string.format('%.1fT', g / 1024)
  end
  return string.format('%dG', math.floor(g + 0.5))
end

-- Mount point to a single-character label: /mnt/d -> D. Anything that is not
-- a drive letter keeps a neutral marker rather than leaking a long path into
-- the status bar.
local function mount_label(mount)
  if type(mount) ~= 'string' then
    return 'HOST'
  end
  local letter = mount:match '^/mnt/(%a)$'
  if letter then
    return letter:upper()
  end
  return 'HOST'
end

-- Exposed for the unit suite: the pure text half of the render, with no
-- wezterm.format or palette involved.
-- Returns nil when there is nothing to show. Callers must treat nil as "emit
-- no segment at all" rather than rendering an empty one, or the bar keeps a
-- stray separator where the badge used to be.
function M.format_text(state, fresh)
  if type(state) ~= 'table' then
    -- Nothing was ever published: the guard is not installed on this machine.
    return nil
  end
  if not fresh then
    return ' ' .. mount_label(state.host_mount) .. '·? '
  end

  local level = type(state.level) == 'string' and state.level or 'unknown'
  if level == 'ok' then
    return nil
  end

  local label = mount_label(state.host_mount)
  local headroom = format_gib(state.headroom_bytes)
  if not headroom then
    return ' ' .. label .. '·? '
  end
  return ' ' .. label .. '·' .. headroom .. ' '
end

function M.render_status_segment(palette)
  local state = M.reload_state()
  local fresh = is_fresh(state)
  local text = M.format_text(state, fresh)
  if not text then
    return nil
  end
  local level = (fresh and type(state) == 'table' and type(state.level) == 'string') and state.level or 'unknown'

  local bg, fg, intensity, italic
  if not fresh then
    bg = palette.tab_bar_background
    fg = palette.new_tab_fg
    intensity = 'Normal'
    italic = true
  elseif level == 'crit' then
    bg = palette.disk_crit_bg or palette.tab_attention_waiting_bg
    fg = palette.disk_crit_fg or palette.tab_attention_waiting_fg
    intensity = 'Bold'
    italic = false
  elseif level == 'warn' then
    bg = palette.tab_attention_waiting_bg
    fg = palette.tab_attention_waiting_fg
    intensity = 'Bold'
    italic = false
  else
    bg = palette.tab_inactive_bg
    fg = palette.tab_inactive_fg
    intensity = 'Normal'
    italic = false
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
