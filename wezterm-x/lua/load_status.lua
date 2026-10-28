-- Guest CPU-load segment (typing-stickiness early warning).
--
-- Reads the same oom-guard status.json as mem_status.lua — that file already
-- carries loadavg_1/5/15 on every heartbeat (~30 s). The M· badge only
-- classifies memory/swap, so a pure CPU storm (esbuild / agent scan burning
-- the guest while mem stays `ok`) left the bar quiet while status ticks
-- crossed 40 ms and typing felt sticky. Reference: 2026-10-28, loadavg_1
-- ~15–23 with ~1350 slow status ticks; 58% of those rows had loadavg_1>=8.
-- See docs/diagnostics.md "Key / status latency" and docs/guest-oom.md.
--
-- **The badge renders nothing while healthy.** Presence is the signal —
-- same contract as D· / M·. Stale-recorder signalling stays on M· (same
-- producer); this segment stays silent when the heartbeat is stale so the
-- bar does not grow a duplicate `?`.
--
--   (absent)   loadavg_1 below warn, or never published, or stale
--   L·12       loadavg_1 at/above warn (amber)
--   L·23       loadavg_1 at/above crit (red)
--
-- Placement: right-status, after the guest-memory badge.

local wezterm = require 'wezterm'

local M = {}

local state_path = nil
local heartbeat_timeout_ms = 90000
-- Absolute loadavg_1 gates. Calibrated on a ~20-logical-CPU WSL guest;
-- override via configure() / constants.load_guard.
local warn_loadavg_1 = 8
local crit_loadavg_1 = 16
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
  if opts and type(opts.warn_loadavg_1) == 'number' and opts.warn_loadavg_1 > 0 then
    warn_loadavg_1 = opts.warn_loadavg_1
  end
  if opts and type(opts.crit_loadavg_1) == 'number' and opts.crit_loadavg_1 > 0 then
    crit_loadavg_1 = opts.crit_loadavg_1
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

-- Pure classifier for tests / render. Returns "ok" | "warn" | "crit".
function M.classify_load(loadavg_1)
  local load = tonumber(loadavg_1)
  if not load then
    return 'ok'
  end
  if load >= crit_loadavg_1 then
    return 'crit'
  end
  if load >= warn_loadavg_1 then
    return 'warn'
  end
  return 'ok'
end

-- Exposed for the unit suite: the pure text half of the render.
-- Returns nil when there is nothing to show.
function M.format_text(state, fresh)
  if type(state) ~= 'table' then
    return nil
  end
  -- Stale monitor is M·'s job (same producer). Stay quiet here.
  if not fresh then
    return nil
  end

  local load = tonumber(state.loadavg_1)
  if not load then
    return nil
  end

  local level = M.classify_load(load)
  if level == 'ok' then
    return nil
  end

  return ' L·' .. string.format('%d', math.floor(load + 0.5)) .. ' '
end

function M.render_status_segment(palette)
  local state = M.reload_state()
  local fresh = is_fresh(state)
  local text = M.format_text(state, fresh)
  if not text then
    return nil
  end

  local load = type(state) == 'table' and tonumber(state.loadavg_1) or nil
  local level = M.classify_load(load)

  local bg, fg, intensity, italic
  if level == 'crit' then
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
    -- Should not reach here (format_text already filtered ok), but keep a
    -- quiet fallback rather than inventing a colour.
    return nil
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
