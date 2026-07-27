-- Guest memory-pressure segment.
--
-- Reads the JSON published by scripts/runtime/wsl-oom-guard.sh into the
-- Windows-accessible runtime state dir (same FS as attention.json /
-- disk-guard), so WezTerm Lua never crosses \\wsl$ on the 250 ms tick.
--
-- Why this exists at all, given the OOM guard already logs everything: on
-- 2026-07-26 the distro sat above the 85% high-water mark for four hours and
-- then livelocked — memory and swap both exhausted, every core spinning in
-- direct reclaim, and *no OOM kill at all* (the failing allocations were
-- order-4 GFP_NOFS, which the kernel declines to OOM-kill for). The guard
-- recorded it faithfully into /var/log/wezterm-oom-guard.log, which nobody
-- reads. The number was known the whole time; the bar just never showed it.
-- See docs/diagnostics.md "Guest OOM hardening".
--
-- **The badge renders nothing while healthy.** It appears only when there is
-- something to act on, so its mere presence in the bar is the signal — no
-- always-on number to learn to ignore, and no width spent on the common case.
--
--   (absent)   memory and swap both below the warn thresholds
--   M·88%      memory used, at or above warn (amber)
--   S·95%      swap used, when swap is the worse of the two axes
--   M·94%      at or above crit (red — earlyoom is about to pick a victim)
--   M·?        the recorder was publishing and went stale — the monitor
--              itself needs attention. Never published at all renders
--              nothing, so a machine without the guard sees a clean bar.
--
-- Reporting whichever axis is worse, rather than memory alone, is the whole
-- point: through the 2026-07-26 incident memory read a calm 88% while swap
-- drained to zero, and it was the swap exhaustion that ended the distro.
--
-- Placement: right-status, after the host-disk badge.

local wezterm = require 'wezterm'

local M = {}

local state_path = nil
-- The recorder republishes every 30 s (and immediately on a level change);
-- allow two misses plus slack before calling the reading stale.
local heartbeat_timeout_ms = 90000
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

-- Whichever axis is closer to the wall, as {label, percent}. Ties go to
-- memory: it is the number an operator can act on directly, and a swap
-- reading that merely matches it adds nothing.
local function dominant_axis(state)
  local mem = tonumber(state.mem_used_pct)
  local swap = tonumber(state.swap_used_pct)
  if swap and (not mem or swap > mem) then
    return 'S', swap
  end
  if mem then
    return 'M', mem
  end
  return nil, nil
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
    return ' M·? '
  end

  local level = type(state.level) == 'string' and state.level or 'unknown'
  if level == 'ok' then
    return nil
  end

  local label, pct = dominant_axis(state)
  if not label then
    return ' M·? '
  end
  return ' ' .. label .. '·' .. string.format('%d', math.floor(pct + 0.5)) .. '% '
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
    bg = palette.mem_crit_bg or palette.disk_crit_bg or palette.tab_attention_waiting_bg
    fg = palette.mem_crit_fg or palette.disk_crit_fg or palette.tab_attention_waiting_fg
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
