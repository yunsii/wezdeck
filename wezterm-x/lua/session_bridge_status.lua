-- Session-bridge watch-loop status segment (Ctrl+K w poller).
--
-- Reads a small JSON heartbeat written by openclaw session-bridge watch-loop
-- into the Windows-accessible runtime state dir (same FS as attention.json /
-- chrome-debug), so WezTerm Lua never crosses \\wsl$ on the 250 ms tick.
--
-- **The badge renders nothing while idle.** Same contract as D· / M· / L·:
-- presence is the signal. A stopped or never-started poller leaves the bar
-- clean (no more always-on `SB·-`). When the poller is fresh and running:
--
--   ◆ SB·0…9  job count
--   ◆ SB·9+   10+ jobs
--
-- The `◆` is the same glyph the Alt+/ picker stamps on session-bridge
-- watch rows (`native/picker/cmd_attention.go::coloredBadge`, status
-- `sb`) and the same one its `[◆ SB watch]` filter chip carries — the
-- badge and the rows it summarises should be recognisable as one thing.
-- The `SB` letters stay: unlike the attention counters, this segment has
-- no word label next to it, so the glyph alone would not say what it is.
--
-- Placement: right-status, between CDP and the disk/mem/load badges.

local wezterm = require 'wezterm'

local M = {}

local state_path = nil
-- Overridden from constants.session_bridge_watch.icon (runtime-entry.lua).
-- `''` is a valid value and drops the glyph, leaving a bare `SB·N`.
local icon = '◆'
-- Stale after ~3 default 10s ticks + slack.
local heartbeat_timeout_ms = 35000
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
  -- Only a string is honoured, so a malformed local override degrades to
  -- the default glyph instead of rendering `nil` into the status bar.
  if opts and type(opts.icon) == 'string' then
    icon = opts.icon
  end
end

-- ' ◆ SB·1 ' — or ' SB·1 ' when the glyph is configured away.
local function badge_text(body)
  if icon == '' then
    return ' ' .. body .. ' '
  end
  return ' ' .. icon .. ' ' .. body .. ' '
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
  if state.poller_running ~= true then
    return false
  end
  local hb = tonumber(state.heartbeat_at_ms)
  if not hb then
    return false
  end
  return (current_epoch_ms() - hb) <= heartbeat_timeout_ms
end

local function job_count(state)
  if type(state) ~= 'table' then
    return 0
  end
  local jobs = 0
  if type(state.job_count) == 'number' then
    jobs = math.floor(state.job_count)
  elseif type(state.job_count) == 'string' then
    jobs = tonumber(state.job_count) or 0
  end
  if jobs < 0 then
    jobs = 0
  end
  return jobs
end

-- Pure text half for unit tests. Returns nil when there is nothing to show
-- (idle / never published / stale). Callers must treat nil as "emit no
-- segment" rather than an empty one.
function M.format_text(state, fresh)
  if type(state) ~= 'table' then
    return nil
  end
  if not fresh then
    return nil
  end
  local jobs = job_count(state)
  if jobs >= 10 then
    return badge_text('SB·9+')
  end
  return badge_text(string.format('SB·%d', jobs))
end

function M.render_status_segment(palette)
  local state = M.reload_state()
  local fresh = is_fresh(state)
  local text = M.format_text(state, fresh)
  if not text then
    return nil
  end

  local bg, fg, intensity
  -- Highlight when at least one job is waiting for human.
  local waiting = tonumber(state and state.waiting_count) or 0
  if waiting > 0 then
    bg = palette.tab_attention_waiting_bg or palette.tab_attention_running_bg
    fg = palette.tab_attention_waiting_fg or palette.tab_attention_running_fg
    intensity = 'Bold'
  else
    bg = palette.tab_inactive_bg
    fg = palette.tab_inactive_fg
    intensity = 'Normal'
  end

  return wezterm.format {
    { Background = { Color = bg } },
    { Foreground = { Color = fg } },
    { Attribute = { Intensity = intensity } },
    { Attribute = { Italic = false } },
    { Text = text },
  }
end

return M
