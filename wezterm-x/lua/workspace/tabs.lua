local M = {}

-- Title used for the tab-visibility overflow placeholder tab. format-tab-
-- title relies on tab.tab_title to keep this rendered as `…`; prune /
-- match logic also uses this string to identify the overflow tab so it
-- doesn't get killed during reconcile.
M.OVERFLOW_TAB_TITLE = '…'

function M.new(opts)
  local wezterm = opts.wezterm
  local mux = opts.mux
  local helpers = opts.helpers
  local logger = opts.logger
  local with_trace_id = opts.with_trace_id
  local runtime = opts.runtime

  local function tab_title_safe(tab)
    if not tab or type(tab.get_title) ~= 'function' then return nil end
    local ok, t = pcall(function() return tab:get_title() end)
    if ok then return t end
    return nil
  end

  local function is_overflow_tab(tab)
    return tab_title_safe(tab) == M.OVERFLOW_TAB_TITLE
  end

  local function find_overflow_tab(mux_window)
    if not mux_window then return nil end
    for _, info in ipairs(mux_window:tabs_with_info()) do
      if is_overflow_tab(info.tab) then return info.tab end
    end
    return nil
  end

  local function spawn_overflow_tab(mux_window, workspace_slug, trace_id)
    if not mux_window then return nil end
    if find_overflow_tab(mux_window) then return nil end
    workspace_slug = workspace_slug or 'default'
    -- The browse session is the per-workspace placeholder the overflow
    -- pane attaches to in its initial (Browse) state. Holding the
    -- pane on a real tmux client lets us later `tmux switch-client
    -- -c <tty> -t <target>` to project a different session into the
    -- same pane without restarting the wezterm pane process.
    local browse_session = 'wezterm_' .. workspace_slug .. '_overflow'
    -- Create the browse session if missing, then exec tmux attach.
    -- All inline because WEZTERM_RUNTIME_DIR is a Windows path on
    -- hybrid-wsl and the WSL bash can't reach a file there.
    --
    -- Before exec, record this pane's tty into a WSL-local state file.
    -- tab-overflow-attach.sh reads it later to target this client with
    -- `tmux switch-client -c <tty> -t <target_session>`. /tmp is fine —
    -- the tty itself is WSL-local, and on reboot the overflow tab is
    -- gone too so the file's lifetime matches the client's.
    local cwd = os.getenv('HOME') or '~'
    local script = string.format([[
session=%q
slug=%q
state_file="/tmp/wezterm-overflow-${slug}-tty.txt"
mkdir -p /tmp
printf '%%s\n' "$(tty)" > "$state_file"
if ! tmux has-session -t "$session" 2>/dev/null; then
  tmux new-session -d -s "$session" \
    bash -lc 'clear
printf "\n  📦  Overflow tab — browse mode\n\n"
printf "  Sessions outside the top-N visible window project into this pane.\n"
printf "  Press Alt+t to open the picker; pick a session and the view here\n"
printf "  switches to it.\n\n"
exec sleep infinity'
fi
exec tmux attach -t "$session"
]], browse_session, workspace_slug)
    logger.info('workspace', 'spawning overflow placeholder tab', with_trace_id(trace_id, {
      workspace = mux_window:get_workspace(),
      browse_session = browse_session,
    }))
    local tab = mux_window:spawn_tab {
      domain = runtime.domain_name(),
      cwd = cwd,
      args = { 'bash', '-lc', script },
    }
    if tab and type(tab.set_title) == 'function' then
      pcall(function() tab:set_title(M.OVERFLOW_TAB_TITLE) end)
    end
    return tab
  end

  local function workspace_windows(name)
    local windows = {}

    for _, mux_window in ipairs(mux.all_windows()) do
      if mux_window:get_workspace() == name then
        windows[#windows + 1] = mux_window
      end
    end

    table.sort(windows, function(a, b)
      return a:window_id() < b:window_id()
    end)

    return windows
  end

  local function workspace_pane_ids(name)
    local pane_ids = {}
    local seen = {}

    for _, mux_window in ipairs(workspace_windows(name)) do
      for _, tab in ipairs(mux_window:tabs()) do
        for _, pane_info in ipairs(tab:panes_with_info()) do
          local pane = pane_info.pane
          local pane_id = pane and pane:pane_id()
          if pane_id and not seen[pane_id] then
            pane_ids[#pane_ids + 1] = pane_id
            seen[pane_id] = true
          end
        end
      end
    end

    return pane_ids
  end

  local function tab_pane_ids(tab)
    local pane_ids = {}
    local seen = {}

    if not tab then
      return pane_ids
    end

    for _, pane_info in ipairs(tab:panes_with_info()) do
      local pane = pane_info.pane
      local pane_id = pane and pane:pane_id()
      if pane_id and not seen[pane_id] then
        pane_ids[#pane_ids + 1] = pane_id
        seen[pane_id] = true
      end
    end

    return pane_ids
  end

  local function tab_path(tab)
    local pane = tab and tab:active_pane()
    return pane and helpers.cwd_to_path(pane:get_current_working_dir()) or nil
  end

  local function project_tab_title(item)
    return item and item.cwd and helpers.basename(item.cwd) or nil
  end

  local function set_project_tab_title(tab, item)
    local title = project_tab_title(item)
    if tab and title then
      tab:set_title(title)
    end
  end

  local function tab_matches_item(tab, item)
    if not tab or not item then
      return false
    end

    return tab:get_title() == project_tab_title(item) or tab_path(tab) == item.cwd
  end

  local function spawn_workspace_tab(mux_window, item, trace_id)
    logger.info('workspace', 'spawning workspace tab', with_trace_id(trace_id, {
      cwd = item.cwd,
      workspace = mux_window:get_workspace(),
    }))
    local tab = mux_window:spawn_tab {
      cwd = item.cwd,
      domain = runtime.domain_name(),
      args = runtime.project_session_args(mux_window:get_workspace(), item, trace_id),
    }

    set_project_tab_title(tab, item)
    return tab
  end

  local function close_tab(tab)
    for _, pane_id in ipairs(tab_pane_ids(tab)) do
      wezterm.run_child_process {
        'wezterm',
        'cli',
        'kill-pane',
        '--pane-id',
        tostring(pane_id),
      }
    end
  end

  local function prune_workspace_tabs(target_window, desired_items)
    local stale_tabs = {}

    for _, info in ipairs(target_window:tabs_with_info()) do
      -- Never prune the overflow placeholder — it's not in workspaces.lua
      -- but is owned by the tab-visibility layer.
      if is_overflow_tab(info.tab) then
        goto continue
      end

      local matched = false

      for _, item in ipairs(desired_items) do
        if tab_matches_item(info.tab, item) then
          matched = true
          break
        end
      end

      if not matched then
        stale_tabs[#stale_tabs + 1] = info.tab
      end

      ::continue::
    end

    if #stale_tabs == 0 then
      return
    end

    logger.info('workspace', 'pruning stale workspace tabs', {
      stale_count = #stale_tabs,
      workspace = target_window:get_workspace(),
      window_id = target_window:window_id(),
    })

    local desired_tab = nil
    if desired_items[1] then
      for _, info in ipairs(target_window:tabs_with_info()) do
        if tab_matches_item(info.tab, desired_items[1]) then
          desired_tab = info.tab
          break
        end
      end
    end

    if desired_tab then
      desired_tab:activate()
    end

    for _, tab in ipairs(stale_tabs) do
      close_tab(tab)
    end
  end

  local function workspace_is_aligned(target_window, desired_items)
    -- Strip the overflow placeholder before comparing — it's owned by
    -- the tab-visibility layer, not by workspaces.lua, so its presence
    -- is orthogonal to whether the user's configured items are
    -- represented.
    local infos = {}
    for _, info in ipairs(target_window:tabs_with_info()) do
      if not is_overflow_tab(info.tab) then
        infos[#infos + 1] = info
      end
    end
    if #infos ~= #desired_items then
      return false
    end
    for i, info in ipairs(infos) do
      if not tab_matches_item(info.tab, desired_items[i]) then
        return false
      end
    end
    return true
  end

  -- desired_items_override caps the spawn loop (only these get spawned
  -- if missing); prune_keep_items_override caps the prune loop (tabs
  -- matching anything in this list are kept). The two lists differ when
  -- the spawn cap (tab_visibility.spawn_visible_only) is on but the
  -- user has tabs from an earlier session that were spawned before the
  -- cap became active — we don't want to suddenly kill them on Alt+w.
  -- Both default to the full workspaces.lua items when not supplied.
  local function sync_workspace_tabs(name, trace_id, desired_items_override, prune_keep_items_override)
    local target_window = workspace_windows(name)[1]
    if not target_window then
      return
    end

    local desired_items = desired_items_override or runtime.workspace_items(name)
    local prune_keep_items = prune_keep_items_override or desired_items

    -- Alignment check uses the prune-keep set (the user's full kept
    -- list, including items beyond the spawn cap). If the existing
    -- window already covers that, there's nothing to do — fast-switch.
    -- Without this, capped Alt+w would always fail alignment (target
    -- has full N tabs vs desired_items=capped N) and burn N×M
    -- tab_matches_item RPCs in the reconcile loop on every press.
    if workspace_is_aligned(target_window, prune_keep_items) then
      logger.info('workspace', 'workspace already aligned, fast switch', with_trace_id(trace_id, {
        workspace = name,
        window_id = target_window:window_id(),
        item_count = #prune_keep_items,
      }))
      mux.set_active_workspace(name)
      return
    end

    logger.info('workspace', 'syncing existing workspace window', with_trace_id(trace_id, {
      workspace = name,
      window_id = target_window:window_id(),
    }))
    mux.set_active_workspace(name)

    local gui_window = target_window:gui_window()

    for desired_index, item in ipairs(desired_items) do
      local matched

      for _, info in ipairs(target_window:tabs_with_info()) do
        if tab_matches_item(info.tab, item) then
          matched = info
          break
        end
      end

      if not matched then
        spawn_workspace_tab(target_window, item, trace_id)

        for _, info in ipairs(target_window:tabs_with_info()) do
          if tab_matches_item(info.tab, item) then
            matched = info
            break
          end
        end
      end

      if matched then
        set_project_tab_title(matched.tab, item)
      end

      if matched and gui_window and matched.index ~= (desired_index - 1) then
        local move_pane = matched.tab:active_pane()
        matched.tab:activate()
        gui_window:perform_action(wezterm.action.MoveTab(desired_index - 1), move_pane)
      end
    end

    prune_workspace_tabs(target_window, prune_keep_items)
  end

  return {
    workspace_windows = workspace_windows,
    workspace_pane_ids = workspace_pane_ids,
    set_project_tab_title = set_project_tab_title,
    spawn_workspace_tab = spawn_workspace_tab,
    sync_workspace_tabs = sync_workspace_tabs,
    tab_matches_item = tab_matches_item,
    spawn_overflow_tab = spawn_overflow_tab,
    find_overflow_tab = find_overflow_tab,
    is_overflow_tab = is_overflow_tab,
  }
end

return M
