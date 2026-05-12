return function(runtime)
  -- Cache the most recent good IME read. Same root cause as the CDP
  -- badge flicker: the helper rewrites state.env every ~250 ms via
  -- tmp+rename, and a concurrent io.open here can briefly fail
  -- (ERROR_SHARING_VIOLATION / ERROR_FILE_NOT_FOUND), making the
  -- preflight or the snapshot return empty for one frame. Without the
  -- cache, render_ime_segment falls through to `中?` (italic) for one
  -- tick even though the IME mode didn't actually change. The cache TTL
  -- is the same heartbeat timeout used for liveness; once the helper is
  -- genuinely stale we want the badge to surface that too.
  local cached_state = nil
  local cached_at_ms = 0

  local function helper_heartbeat_timeout_ms()
    local integration = runtime:helper_integration() or {}
    local seconds = integration.helper_heartbeat_timeout_seconds or 5
    return seconds * 1000
  end

  local function fall_back(reason)
    if cached_state and (runtime:current_epoch_ms() - cached_at_ms) <= helper_heartbeat_timeout_ms() then
      return cached_state
    end
    return nil, reason
  end

  return {
    category = 'ime',
    recover_reason_prefix = 'ime',
    query = function(trace_id)
      if not runtime:supports_windows_helper() then
        return nil, 'unsupported_runtime'
      end

      local state_is_fresh, state_reason = runtime:helper_state_preflight()
      if not state_is_fresh then
        return fall_back(state_reason or 'helper_stale')
      end

      local state, snapshot_reason = runtime:helper_state_snapshot()
      if not state then
        return fall_back(snapshot_reason or 'state_unavailable')
      end

      local mode = state.ime_mode
      if not mode or mode == '' then
        return fall_back('state_missing_ime')
      end

      local lang = state.ime_lang
      if lang == '' then lang = nil end
      local reason = state.ime_reason
      if reason == '' then reason = nil end

      local fresh = { mode = mode, lang = lang, reason = reason }
      cached_state = fresh
      cached_at_ms = runtime:current_epoch_ms()
      return fresh
    end,
  }
end
