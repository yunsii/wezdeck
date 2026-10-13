-- Sticky title ↔ overflow consistency alerts for attention jumps.
-- Kept out of attention.lua to stay under the hygiene hard line budget.

local wezterm = require 'wezterm'

local M = {}

local OVERFLOW_GLYPH = '…'
local last_title_session_mismatch = {}

local function parse_session_repo(s)
  if type(s) ~= 'string' or s == '' then return nil end
  return s:match('^wezterm_[^_]+_(.+)_[0-9a-f]+$')
end

function M.note_overflow_project(workspace_name, session_name, overflow_pane_id, now_ms)
  _G.__WEZTERM_LAST_OVERFLOW_PROJECT = {
    workspace = workspace_name,
    session = session_name,
    overflow_pane_id = overflow_pane_id,
    ms = now_ms,
  }
end

-- Walk mux for a non-overflow tab whose sticky title equals the session
-- repo label. Returns pane_id, title, hosted_session.
function M.find_sticky_titled_pane(workspace_name, session_name, pane_hosted_session)
  local label = parse_session_repo(session_name)
  if not label or not workspace_name or workspace_name == '' then
    return nil, nil, nil
  end
  if type(pane_hosted_session) ~= 'function' then
    return nil, nil, nil
  end
  local ok_all, all_windows = pcall(wezterm.mux.all_windows)
  if not ok_all or type(all_windows) ~= 'table' then
    return nil, nil, nil
  end
  for _, mux_win in ipairs(all_windows) do
    local ok_ws, ws = pcall(function() return mux_win:get_workspace() end)
    if ok_ws and ws == workspace_name then
      local ok_tabs, tabs_list = pcall(function() return mux_win:tabs() end)
      if ok_tabs and type(tabs_list) == 'table' then
        for _, mux_tab in ipairs(tabs_list) do
          local ok_title, title = pcall(function() return mux_tab:get_title() end)
          if ok_title and title == label then
            local ok_pane, active_pane = pcall(function() return mux_tab:active_pane() end)
            local pane_id
            if ok_pane and active_pane then
              pcall(function() pane_id = active_pane:pane_id() end)
            end
            local hosted = pane_id and pane_hosted_session(pane_id) or nil
            return pane_id, title, hosted
          end
        end
      end
    end
  end
  return nil, nil, nil
end

function M.log_overflow_project(logger, load_tab_visibility, pane_hosted_session,
                                session_workspace, tmux_session_hint, overflow_pane_id,
                                pane_id_value)
  if type(logger) ~= 'table' then return end
  local sticky_visible = false
  local tv = type(load_tab_visibility) == 'function' and load_tab_visibility() or nil
  if tv and type(tv.is_in_visible) == 'function' then
    sticky_visible = tv.is_in_visible(session_workspace, tmux_session_hint) == true
  end
  local titled_pane_id, titled_title, titled_host =
    M.find_sticky_titled_pane(session_workspace, tmux_session_hint, pane_hosted_session)
  local title_host_mismatch = titled_pane_id ~= nil
    and titled_host ~= nil
    and titled_host ~= ''
    and titled_host ~= tmux_session_hint

  local fields = {
    session = tmux_session_hint,
    workspace = session_workspace,
    overflow_pane_id = overflow_pane_id,
    sticky_visible = sticky_visible and '1' or '0',
    stored_wezterm_pane = tostring(pane_id_value or ''),
    session_label = parse_session_repo(tmux_session_hint) or '',
    titled_pane_id = titled_pane_id and tostring(titled_pane_id) or '',
    titled_tab_title = titled_title or '',
    titled_host_session = titled_host or '',
  }
  if sticky_visible or title_host_mismatch then
    logger.warn('attention',
      'inconsistent: jump projected to overflow despite sticky-visible tab',
      fields)
  else
    logger.info('attention', 'projected entry into overflow', fields)
  end
end

function M.maybe_warn_title_session_mismatch(logger, pane_id_str, pane_info, hosted, is_overflow)
  if type(logger) ~= 'table' or type(pane_info) ~= 'table' then return end
  if is_overflow then return end
  local tab_title = pane_info.tab_title or ''
  if tab_title == '' or tab_title == OVERFLOW_GLYPH then return end
  local label = parse_session_repo(hosted)
  if not label then return end
  if label ~= tab_title then
    local sig = tab_title .. '|' .. hosted
    if last_title_session_mismatch[pane_id_str] ~= sig then
      last_title_session_mismatch[pane_id_str] = sig
      logger.warn('attention',
        'inconsistent: sticky title/session mismatch',
        {
          wezterm_pane = pane_id_str,
          workspace = pane_info.workspace or '',
          tab_title = tab_title,
          session = hosted,
          session_label = label,
        })
    end
  else
    last_title_session_mismatch[pane_id_str] = nil
  end
end

-- Heal same-workspace pane-id recycle: memory still names the previous
-- occupant while the sticky title (and usually the file tier written by
-- open-project-session.sh) already name the new one. Cross-workspace
-- staleness is handled elsewhere; this covers title≠session_label under
-- the same `wezterm_<ws>_` prefix (2026-10-13: wp=5 titled cnb-plugins
-- still mapped to ai-video-collection → Alt+l landed on the wrong tab).
--
-- clear_memory() must drop only the in-memory tier so reread() can see
-- the file. Returns: new_hosted, did_heal.
function M.heal_title_session_mismatch(pane_id_str, pane_info, hosted, is_overflow,
                                       clear_memory, reread, logger)
  if is_overflow or type(pane_info) ~= 'table' then
    return hosted, false
  end
  if type(hosted) ~= 'string' or hosted == '' then
    return hosted, false
  end
  local tab_title = pane_info.tab_title or ''
  if tab_title == '' or tab_title == OVERFLOW_GLYPH then
    return hosted, false
  end
  local label = parse_session_repo(hosted)
  if not label or label == tab_title then
    return hosted, false
  end
  if type(clear_memory) == 'function' then
    clear_memory()
  end
  local file_hosted = type(reread) == 'function' and reread() or nil
  local file_label = type(file_hosted) == 'string' and parse_session_repo(file_hosted) or nil
  if file_label == tab_title then
    if type(logger) == 'table' and type(logger.info) == 'function' then
      logger.info('attention', 'healed title/session mismatch from file tier', {
        wezterm_pane = pane_id_str,
        workspace = pane_info.workspace or '',
        tab_title = tab_title,
        was_session = hosted,
        now_session = file_hosted,
      })
    end
    last_title_session_mismatch[pane_id_str] = nil
    return file_hosted, true
  end
  -- File missing, or file still names the same session as memory while
  -- the sticky title disagrees. Common legitimate case: repo display
  -- alias (`wezterm-config` → `wezdeck`). Only warn — restoring the
  -- probed value so we do not wipe a correct host edge. Destructive
  -- clear is reserved for the heal-from-file success path above.
  if type(logger) == 'table' and type(logger.warn) == 'function' then
    local sig = tab_title .. '|' .. hosted
    if last_title_session_mismatch[pane_id_str] ~= sig then
      last_title_session_mismatch[pane_id_str] = sig
      logger.warn('attention',
        'inconsistent: sticky title/session mismatch',
        {
          wezterm_pane = pane_id_str,
          workspace = pane_info.workspace or '',
          tab_title = tab_title,
          session = hosted,
          session_label = label,
          file_session = file_hosted or '',
          healed = 'skipped',
        })
    end
  end
  -- Restore whatever the file (or empty) said after the probe so the
  -- caller re-memoizes a real edge instead of forgetting a healthy one.
  if type(file_hosted) == 'string' and file_hosted ~= '' then
    return file_hosted, true
  end
  return hosted, true
end

return M
