-- Key / status-tick latency observability.
--
-- Default posture: quiet. Emit an info row under category `latency` only
-- when a measured duration crosses the configured threshold. Full
-- sampling under `latency.perf` is opt-in via
-- `diagnostics.wezterm.latency.emit_all = true` (or an explicit
-- categories allowlist that includes `latency.perf`).
--
-- Ordinary character typing never enters Lua; status-tick duration is
-- the proxy for "UI thread blocked → keys feel sticky". WezTerm-layer
-- hotkeys are timed at the keymaps.lua wrap around perform_action.
-- See docs/diagnostics.md "Key / status latency".

local M = {}

local DEFAULT_HOTKEY_SLOW_MS = 50
local DEFAULT_STATUS_SLOW_MS = 40

local function positive_int(value, fallback)
  local n = tonumber(value)
  if n and n > 0 then
    return math.floor(n)
  end
  return fallback
end

function M.config(constants)
  local diagnostics = constants and constants.diagnostics or {}
  local wezterm_diag = diagnostics.wezterm or {}
  local latency = wezterm_diag.latency or {}
  local categories = wezterm_diag.categories or {}
  local emit_all = latency.emit_all == true
  -- Empty categories means "all base categories" in logger.lua, but we
  -- deliberately do NOT treat that as permission to flood latency.perf
  -- at 4 Hz. Full sampling requires an explicit emit_all flag, or a
  -- non-empty allowlist that names latency.perf.
  if not emit_all and type(categories) == 'table' and next(categories) ~= nil then
    emit_all = categories['latency.perf'] == true
  end
  return {
    hotkey_slow_ms = positive_int(latency.hotkey_slow_ms, DEFAULT_HOTKEY_SLOW_MS),
    status_slow_ms = positive_int(latency.status_slow_ms, DEFAULT_STATUS_SLOW_MS),
    emit_all = emit_all,
  }
end

function M.now_ms(wezterm)
  if not wezterm or not wezterm.time or not wezterm.time.now then
    return nil
  end
  local ok, now_str = pcall(function()
    return wezterm.time.now():format '%s%3f'
  end)
  if ok and type(now_str) == 'string' and now_str:match '^%d+$' then
    return tonumber(now_str)
  end
  return nil
end

local function merge_fields(base, extra)
  local out = {}
  if type(base) == 'table' then
    for k, v in pairs(base) do
      out[k] = v
    end
  end
  if type(extra) == 'table' then
    for k, v in pairs(extra) do
      out[k] = v
    end
  end
  return out
end

-- Collect cheap pane/window context. All accessors are pcall-guarded so
-- a missing method never fails the key path.
function M.context_fields(window, pane)
  local fields = {}
  if window then
    local ok_ws, ws = pcall(function() return window:active_workspace() end)
    if ok_ws and type(ws) == 'string' and ws ~= '' then
      fields.workspace = ws
    end
  end
  if pane then
    local ok_id, pane_id = pcall(function() return pane:pane_id() end)
    if ok_id and pane_id ~= nil then
      fields.pane_id = tostring(pane_id)
    end
    local ok_fg, fg = pcall(function() return pane:get_foreground_process_name() end)
    if ok_fg and type(fg) == 'string' and fg ~= '' then
      fields.foreground = fg
    end
    local ok_dom, dom = pcall(function() return pane:get_domain_name() end)
    if ok_dom and type(dom) == 'string' and dom ~= '' then
      fields.domain = dom
    end
  end
  return fields
end

-- opts:
--   kind          "hotkey" | "status"
--   duration_ms   number
--   fields        optional extra fields (hotkey_id, …)
--   window/pane   optional, for context_fields
--
-- Returns true when a slow-event (base category) line was emitted.
function M.observe(logger, cfg, opts)
  if not logger or not logger.info then
    return false
  end
  opts = opts or {}
  cfg = cfg or {}
  local duration_ms = tonumber(opts.duration_ms)
  if not duration_ms then
    return false
  end
  duration_ms = math.floor(duration_ms)

  local kind = opts.kind or 'hotkey'
  local threshold = (kind == 'status')
    and (cfg.status_slow_ms or DEFAULT_STATUS_SLOW_MS)
    or (cfg.hotkey_slow_ms or DEFAULT_HOTKEY_SLOW_MS)

  local fields = merge_fields(M.context_fields(opts.window, opts.pane), opts.fields)
  fields.duration_ms = duration_ms
  fields.threshold_ms = threshold
  fields.kind = kind

  if cfg.emit_all then
    local perf_message = (kind == 'status') and 'status tick timing' or 'key handler timing'
    logger.info('latency.perf', perf_message, fields)
  end

  if duration_ms < threshold then
    return false
  end

  local slow_message = (kind == 'status') and 'slow status tick' or 'slow key handler'
  logger.info('latency', slow_message, fields)
  return true
end

-- Test / call-site helper: threshold gate only (no logger side effects).
function M.should_log_slow(duration_ms, threshold_ms)
  local d = tonumber(duration_ms)
  local t = tonumber(threshold_ms)
  if not d or not t then
    return false
  end
  return d >= t
end

M.DEFAULT_HOTKEY_SLOW_MS = DEFAULT_HOTKEY_SLOW_MS
M.DEFAULT_STATUS_SLOW_MS = DEFAULT_STATUS_SLOW_MS

return M
