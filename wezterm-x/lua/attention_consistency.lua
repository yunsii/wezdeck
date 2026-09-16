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

return M
