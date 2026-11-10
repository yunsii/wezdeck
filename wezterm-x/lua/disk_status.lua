-- Host-disk status segment.
--
-- Reads the JSON published by scripts/runtime/wsl-disk-guard.sh into the
-- Windows-accessible runtime state dir (same FS as attention.json /
-- chrome-debug), so WezTerm Lua never crosses \\wsl$ on the 250 ms tick.
--
-- status.json v3 carries the WSL volume at the top level (v2 shape) plus an
-- optional nested `system` object for the Windows system drive. Each volume
-- that is warn/crit (or stale) renders its own letter badge — e.g. `C·8G`
-- next to `D·2G` — so a dry system disk cannot hide behind a healthy WSL
-- volume. See docs/host-disk.md.
--
-- One number per volume from the sampler's `badge_bytes` (falls back to
-- `headroom_bytes` for older status.json). The WSL sampler picks the binding
-- constraint: headroom when the write budget is tight, host avail when the
-- volume itself is about to dry. The system volume is avail-only.
--
-- **Badges render nothing while healthy.** Presence in the bar is the signal
-- — no always-on number to learn to ignore, and no width spent on the common
-- case.
--
--   (absent)   every watched volume healthy
--   D·22G      WSL volume below warn (amber)
--   C·8G       system volume below warn
--   C·2G D·11G both volumes hot (each keeps its own level colour)
--   D·?        sampler was publishing and went stale
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

local function volume_entries(state)
  if type(state) ~= 'table' then
    return {}
  end
  local entries = {}
  -- System drive first (C· before D·) so a dry boot volume is the leftmost
  -- signal when both are hot.
  if type(state.system) == 'table' and state.system.host_mount ~= nil then
    table.insert(entries, {
      host_mount = state.system.host_mount,
      level = state.system.level,
      badge_bytes = state.system.badge_bytes,
      headroom_bytes = state.system.headroom_bytes or state.system.host_avail_bytes,
    })
  end
  -- Top-level fields are the WSL / vhdx volume (v2 + v3).
  if state.host_mount ~= nil or state.level ~= nil or state.headroom_bytes ~= nil
      or state.badge_bytes ~= nil then
    table.insert(entries, {
      host_mount = state.host_mount,
      level = state.level,
      badge_bytes = state.badge_bytes,
      headroom_bytes = state.headroom_bytes,
    })
  end
  return entries
end

local function format_volume_text(vol, fresh)
  if type(vol) ~= 'table' then
    return nil, 'unknown'
  end
  local label = mount_label(vol.host_mount)
  if not fresh then
    return ' ' .. label .. '·? ', 'unknown'
  end
  local level = type(vol.level) == 'string' and vol.level or 'unknown'
  if level == 'ok' then
    return nil, 'ok'
  end
  local shown = format_gib(vol.badge_bytes) or format_gib(vol.headroom_bytes)
  if not shown then
    return ' ' .. label .. '·? ', level
  end
  return ' ' .. label .. '·' .. shown .. ' ', level
end

-- Exposed for the unit suite: the pure text half of the render, with no
-- wezterm.format or palette involved.
-- Returns nil when there is nothing to show. Callers must treat nil as "emit
-- no segment at all" rather than rendering an empty one, or the bar keeps a
-- stray separator where the badge used to be.
--
-- When both volumes are hot the texts concatenate (` C·8G  D·2G `). Pass a
-- single volume-shaped table for the legacy single-volume helper path.
function M.format_text(state, fresh)
  if type(state) ~= 'table' then
    return nil
  end
  -- Legacy / unit-suite: a bare volume table (no nested system, has level).
  if state.system == nil and (state.host_mount ~= nil or state.level ~= nil) then
    local text = format_volume_text(state, fresh)
    return text
  end
  local parts = {}
  for _, vol in ipairs(volume_entries(state)) do
    local text = format_volume_text(vol, fresh)
    if text then
      table.insert(parts, text)
    end
  end
  if #parts == 0 then
    return nil
  end
  return table.concat(parts, '')
end

local function level_style(palette, level, fresh)
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
  return bg, fg, intensity, italic
end

function M.render_status_segment(palette)
  local state = M.reload_state()
  if type(state) ~= 'table' then
    return nil
  end
  local fresh = is_fresh(state)
  local entries = volume_entries(state)
  if #entries == 0 then
    return nil
  end

  local format_list = {}
  local any = false
  for _, vol in ipairs(entries) do
    local text, level = format_volume_text(vol, fresh)
    if text then
      any = true
      local bg, fg, intensity, italic = level_style(palette, level, fresh)
      table.insert(format_list, { Background = { Color = bg } })
      table.insert(format_list, { Foreground = { Color = fg } })
      table.insert(format_list, { Attribute = { Intensity = intensity } })
      table.insert(format_list, { Attribute = { Italic = italic } })
      table.insert(format_list, { Text = text })
    end
  end
  if not any then
    return nil
  end
  return wezterm.format(format_list)
end

return M
