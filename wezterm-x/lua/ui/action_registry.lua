-- Handler registry for WezTerm-layer bindings. Every id in
-- commands/manifest.json with `binding.handler` resolves to exactly one
-- factory below; the factory receives optional `binding_args` (static,
-- declared in manifest) and `hotkey_args` (per-hotkey, e.g. Alt+N gets
-- args = N) and returns a wezterm action / action_callback.
--
-- This is the single source of truth for "what does this shortcut do?".
-- The manifest owns (id, key, args); Lua owns (handler, behavior); the
-- user's local/keybindings.lua only rewires (id -> key).

local path_sep = package.config:sub(1, 1)

local function join_path(...)
  return table.concat({ ... }, path_sep)
end

local module_dir = join_path(rawget(_G, 'WEZTERM_RUNTIME_DIR') or '.', 'lua', 'ui')
local common = dofile(join_path(module_dir, 'common.lua'))
local actions = dofile(join_path(module_dir, 'actions.lua'))

local M = {}

function M.new(ctx)
  local wezterm = ctx.wezterm
  local constants = ctx.constants
  local logger = ctx.logger
  local host = ctx.host
  local attention = ctx.attention
  local workspace = ctx.workspace

  local function attention_jump_args(trailing_args, pane_ref, trace_id)
    return actions.attention_jump_args(constants, pane_ref, trailing_args, logger, trace_id)
  end

  local function attention_direct_args(entry, pane_ref, trace_id)
    local socket = entry.tmux_socket
    local window = entry.tmux_window
    if type(socket) == 'string' and socket ~= ''
      and type(window) == 'string' and window ~= '' then
      local trailing = {
        '--direct',
        '--tmux-socket', socket,
        '--tmux-window', window,
      }
      if type(entry.tmux_pane) == 'string' and entry.tmux_pane ~= '' then
        table.insert(trailing, '--tmux-pane')
        table.insert(trailing, entry.tmux_pane)
      end
      return attention_jump_args(trailing, pane_ref, trace_id)
    end
    return attention_jump_args({ '--session', entry.session_id }, pane_ref, trace_id)
  end

  local function attention_forget_args(entry, pane_ref, trace_id)
    if not entry or type(entry.session_id) ~= 'string' or entry.session_id == '' then
      return nil
    end
    local trailing = { '--forget', entry.session_id }
    if entry.ts ~= nil and tostring(entry.ts) ~= '' then
      table.insert(trailing, '--only-if-ts')
      table.insert(trailing, tostring(entry.ts))
    end
    return attention_jump_args(trailing, pane_ref, trace_id)
  end

  local handlers = {}

  -- ── Tabs ──────────────────────────────────────────────

  handlers['tabs.activate_relative'] = function(binding_args)
    local delta = (binding_args and binding_args.delta) or 1
    return wezterm.action.ActivateTabRelative(delta)
  end

  handlers['tabs.activate_by_index'] = function(_, hotkey_args)
    local index = tonumber(hotkey_args) or 1
    return wezterm.action.ActivateTab(index - 1)
  end

  -- ── Panes ─────────────────────────────────────────────

  handlers['pane.rotate_next'] = function()
    return wezterm.action_callback(function(window, pane)
      local trace_id = logger.trace_id('command_panel')
      local workspace_name = common.active_workspace_name(window)
      local tmux_backed, decision_path = actions.is_tmux_backed_pane(constants, window, pane)
      if tmux_backed then
        logger.info('command_panel', 'forwarding Alt+o to tmux-backed pane', common.merge_fields(trace_id, {
          decision_path = decision_path,
          domain = pane:get_domain_name(),
          workspace = workspace_name,
        }))
        actions.forward_shortcut_to_pane(wezterm, window, pane, 'Alt+o', '\x1bo', logger, 'command_panel', workspace_name, trace_id)
        return
      end
      actions.tmux_only_shortcut(window, logger, 'Alt+o', trace_id)
    end)
  end

  -- ── Command palette ───────────────────────────────────

  handlers['command_palette.open'] = function()
    return wezterm.action_callback(function(window, pane)
      local workspace_name = common.active_workspace_name(window)
      local trace_id = logger.trace_id('command_panel')
      local tmux_backed, decision_path = actions.is_tmux_backed_pane(constants, window, pane)
      local foreground_process = common.foreground_process_basename(pane)

      if tmux_backed then
        logger.info('command_panel', 'forwarding Ctrl+Shift+P to tmux command palette via tmux user-key transport', common.merge_fields(trace_id, {
          decision_path = decision_path,
          transport = 'User0',
          foreground_process = foreground_process,
          workspace = workspace_name,
          domain = pane:get_domain_name(),
        }))
        actions.forward_shortcut_to_pane(wezterm, window, pane, 'Ctrl+Shift+P', '\x1b[20099~', logger, 'command_panel', workspace_name, trace_id)
        return
      end

      logger.info('command_panel', 'falling back to wezterm native command palette', common.merge_fields(trace_id, {
        decision_path = 'wezterm_native_palette',
        foreground_process = foreground_process,
        workspace = workspace_name,
        domain = pane:get_domain_name(),
      }))
      window:perform_action(wezterm.action.ActivateCommandPalette, pane)
    end)
  end

  handlers['command_palette.chord_prefix'] = function()
    return wezterm.action_callback(function(window, pane)
      local workspace_name = common.active_workspace_name(window)
      local trace_id = logger.trace_id('command_panel')
      local tmux_backed, decision_path = actions.is_tmux_backed_pane(constants, window, pane)
      local foreground_process = common.foreground_process_basename(pane)

      if tmux_backed then
        logger.info('command_panel', 'forwarding Ctrl+k to tmux chord handler', common.merge_fields(trace_id, {
          decision_path = decision_path,
          foreground_process = foreground_process,
          workspace = workspace_name,
          domain = pane:get_domain_name(),
        }))
        actions.forward_shortcut_to_pane(wezterm, window, pane, 'Ctrl+k', '\x0b', logger, 'command_panel', workspace_name, trace_id)
        return
      end

      logger.warn('command_panel', 'shortcut requires tmux in current pane', common.merge_fields(trace_id, {
        foreground_process = foreground_process,
        workspace = workspace_name,
      }))
      window:toast_notification('WezTerm', 'Ctrl+k chords are only available when the current pane is running tmux', nil, 3000)
    end)
  end

  handlers['command_palette.open_native'] = function()
    return wezterm.action.ActivateCommandPalette
  end

  -- ── VS Code ───────────────────────────────────────────

  handlers['vscode.open_current_dir'] = function()
    return wezterm.action_callback(function(window, pane)
      local trace_id = logger.trace_id('vscode')
      local cwd = common.file_path_from_cwd(pane:get_current_working_dir())
      local workspace_name = common.active_workspace_name(window)
      local foreground_process = common.foreground_process_basename(pane)
      local runtime_mode = constants.runtime_mode or 'hybrid-wsl'
      local distro = common.wsl_distro_from_domain(pane:get_domain_name()) or common.wsl_distro_from_domain(constants.default_domain)
      local tmux_backed, decision_path = actions.is_tmux_backed_pane(constants, window, pane)

      if tmux_backed then
        logger.info('vscode', 'forwarding Alt+v to tmux-backed pane', common.merge_fields(trace_id, {
          cwd = cwd,
          decision_path = decision_path,
          domain = pane:get_domain_name(),
          foreground_process = foreground_process,
          workspace = workspace_name,
        }))
        actions.forward_shortcut_to_pane(wezterm, window, pane, 'Alt+v', '\x1bv', logger, 'vscode', workspace_name, trace_id)
        return
      end

      if foreground_process == 'tmux' and (not cwd or cwd == '/') then
        logger.info('vscode', 'forwarding Alt+v to pane fallback', common.merge_fields(trace_id, {
          cwd = cwd,
          domain = pane:get_domain_name(),
          foreground_process = foreground_process,
        }))
        window:perform_action(wezterm.action.SendString '\x1bv', pane)
        return
      end

      if runtime_mode == 'hybrid-wsl' and distro and common.is_windows_host_path(cwd) then
        logger.info('vscode', 'forwarding Alt+v to pane fallback', common.merge_fields(trace_id, {
          cwd = cwd,
          domain = pane:get_domain_name(),
          foreground_process = foreground_process,
        }))
        window:perform_action(wezterm.action.SendString '\x1bv', pane)
        return
      end

      actions.open_current_dir_in_vscode(wezterm, window, pane, constants, logger, trace_id, host)
    end)
  end

  -- ── Worktree ──────────────────────────────────────────

  handlers['worktree.picker'] = function()
    return wezterm.action_callback(function(window, pane)
      local trace_id = logger.trace_id('workspace')
      local workspace_name = common.active_workspace_name(window)
      local tmux_backed, decision_path = actions.is_tmux_backed_pane(constants, window, pane)
      if tmux_backed then
        logger.info('workspace', 'forwarding Alt+g to tmux-backed pane', common.merge_fields(trace_id, {
          decision_path = decision_path,
          domain = pane:get_domain_name(),
          workspace = workspace_name,
        }))
        actions.forward_shortcut_to_pane(wezterm, window, pane, 'Alt+g', '\x1bg', logger, 'workspace', workspace_name, trace_id)
        return
      end
      actions.tmux_only_shortcut(window, logger, 'Alt+g', trace_id)
    end)
  end

  handlers['worktree.cycle_next'] = function()
    return wezterm.action_callback(function(window, pane)
      local trace_id = logger.trace_id('workspace')
      local workspace_name = common.active_workspace_name(window)
      local tmux_backed, decision_path = actions.is_tmux_backed_pane(constants, window, pane)
      if tmux_backed then
        logger.info('workspace', 'forwarding Alt+Shift+g to tmux-backed pane', common.merge_fields(trace_id, {
          decision_path = decision_path,
          domain = pane:get_domain_name(),
          workspace = workspace_name,
        }))
        actions.forward_shortcut_to_pane(wezterm, window, pane, 'Alt+Shift+g', '\x1bG', logger, 'workspace', workspace_name, trace_id)
        return
      end
      actions.tmux_only_shortcut(window, logger, 'Alt+Shift+g', trace_id)
    end)
  end

  -- ── Chrome debug ──────────────────────────────────────

  handlers['chrome.open_debug_profile'] = function(binding_args)
    local headless = true
    if binding_args and binding_args.headless ~= nil then
      headless = binding_args.headless and true or false
    end
    return wezterm.action_callback(function(window)
      local trace_id = logger.trace_id('chrome')
      actions.open_debug_chrome(wezterm, window, constants, logger, trace_id, host, headless)
    end)
  end

  -- ── Attention ─────────────────────────────────────────

  handlers['attention.jump_waiting'] = function()
    return wezterm.action_callback(function(window, pane)
      local trace_id = logger.trace_id('attention')
      if not attention then return end
      attention.reload_state()
      local current_pane_id = pane and pane:pane_id() or nil
      local entry = attention.pick_next(attention.STATUS_WAITING, current_pane_id)
      if not entry then return end
      logger.info('attention', 'alt-comma jump', {
        trace = trace_id,
        session_id = entry.session_id,
        wezterm_pane_id = entry.wezterm_pane_id,
      })
      attention.activate_in_gui(entry.wezterm_pane_id, window, pane)
      local args = attention_direct_args(entry, pane, trace_id)
      if args then wezterm.background_child_process(args) end
    end)
  end

  handlers['attention.jump_done'] = function()
    return wezterm.action_callback(function(window, pane)
      local trace_id = logger.trace_id('attention')
      if not attention then return end
      attention.reload_state()
      local current_pane_id = pane and pane:pane_id() or nil
      local entry = attention.pick_next(attention.STATUS_DONE, current_pane_id)
      if not entry then return end
      logger.info('attention', 'alt-dot jump', {
        trace = trace_id,
        session_id = entry.session_id,
        wezterm_pane_id = entry.wezterm_pane_id,
      })
      local activated = attention.activate_in_gui(entry.wezterm_pane_id, window, pane)
      local args = attention_direct_args(entry, pane, trace_id)
      if args then wezterm.background_child_process(args) end
      if activated then
        local forget_args = attention_forget_args(entry, pane, trace_id)
        if forget_args then wezterm.background_child_process(forget_args) end
      end
    end)
  end

  handlers['attention.overlay'] = function()
    return wezterm.action_callback(function(window, pane)
      local trace_id = logger.trace_id('attention')
      if not attention then return end
      attention.reload_state()
      local entries = attention.list()
      if #entries == 0 then
        window:toast_notification('WezTerm', 'No pending agent attention', nil, 2000)
        return
      end

      local function format_age(ms)
        local s = math.floor((tonumber(ms) or 0) / 1000)
        if s < 60 then return s .. 's' end
        local m = math.floor(s / 60)
        if m < 60 then return m .. 'm' end
        local h = math.floor(m / 60)
        return h .. 'h'
      end

      local function nonempty(value)
        if value == nil then return false end
        if type(value) ~= 'string' then return true end
        return value ~= ''
      end

      local choices = {}
      for _, entry in ipairs(entries) do
        local marker
        if entry.status == attention.STATUS_WAITING then
          marker = '⚠'
        elseif entry.status == attention.STATUS_RUNNING then
          marker = '⟳'
        else
          marker = '✓'
        end
        local reason = nonempty(entry.reason) and entry.reason or entry.status

        local live = entry.live or {}
        local workspace_seg = nonempty(live.workspace) and live.workspace or '?'
        local tab_seg = '?'
        if live.tab_index then
          tab_seg = tostring(live.tab_index)
          if nonempty(live.tab_title) then
            tab_seg = tab_seg .. '_' .. live.tab_title
          end
        end
        local function strip_tmux_prefix(value)
          if type(value) ~= 'string' then return value end
          return (value:gsub('^[@%%]', ''))
        end
        local tmux_seg = '?'
        if nonempty(entry.tmux_window) then
          tmux_seg = strip_tmux_prefix(entry.tmux_window)
          if nonempty(entry.tmux_pane) then
            tmux_seg = tmux_seg .. '_' .. strip_tmux_prefix(entry.tmux_pane)
          end
        end
        local branch_seg = nonempty(entry.git_branch) and entry.git_branch or '?'

        local prefix = nil
        if workspace_seg ~= '?' or tab_seg ~= '?' or tmux_seg ~= '?' or branch_seg ~= '?' then
          prefix = workspace_seg .. '/' .. tab_seg .. '/' .. tmux_seg .. '/' .. branch_seg
        end

        local label
        if prefix then
          label = prefix .. '  ' .. marker .. ' ' .. reason
        else
          label = marker .. ' ' .. reason
        end
        local age_text = format_age(entry.age_ms)
        if not nonempty(entry.wezterm_pane_id) then
          age_text = age_text .. ', no pane'
        end
        label = label .. '  (' .. age_text .. ')'
        table.insert(choices, { label = label, id = entry.session_id })
      end

      local clear_all_sentinel = '__clear_all__'
      table.insert(choices, {
        label = '——  clear all · ' .. #entries .. ' entries  ——',
        id = clear_all_sentinel,
      })

      local function inject_tick(inner_pane)
        local tick
        local ok_b64, encoded = pcall(wezterm.encode_base64, tostring(os.time()))
        if ok_b64 and type(encoded) == 'string' then
          tick = encoded
        else
          tick = ''
        end
        local osc = '\027]1337;SetUserVar=attention_tick=' .. tick .. '\007'
        pcall(function() inner_pane:inject_output(osc) end)
      end

      window:perform_action(
        wezterm.action.InputSelector {
          title = 'Agent attention',
          choices = choices,
          fuzzy = true,
          action = wezterm.action_callback(function(inner_window, inner_pane, chosen_id, _chosen_label)
            if not chosen_id or chosen_id == '' then return end

            if chosen_id == clear_all_sentinel then
              local args = attention_jump_args({ '--clear-all' }, inner_pane, trace_id)
              if not args then return end
              logger.info('attention', 'alt-slash clear-all', { trace = trace_id })
              wezterm.run_child_process(args)
              if attention.reload_state then attention.reload_state() end
              inject_tick(inner_pane)
              return
            end

            local chosen_entry
            for _, candidate in ipairs(entries) do
              if candidate.session_id == chosen_id then
                chosen_entry = candidate
                break
              end
            end
            local activated = false
            if chosen_entry then
              activated = attention.activate_in_gui(chosen_entry.wezterm_pane_id, inner_window, inner_pane)
            end

            local args
            if chosen_entry then
              args = attention_direct_args(chosen_entry, inner_pane, trace_id)
            else
              args = attention_jump_args({ '--session', chosen_id }, inner_pane, trace_id)
            end
            if not args then return end
            logger.info('attention', 'alt-slash jump', {
              trace = trace_id,
              session_id = chosen_id,
            })
            wezterm.background_child_process(args)
            if activated and chosen_entry and chosen_entry.status == attention.STATUS_DONE then
              local forget_args = attention_forget_args(chosen_entry, inner_pane, trace_id)
              if forget_args then wezterm.background_child_process(forget_args) end
            end
          end),
        },
        pane
      )
    end)
  end

  -- ── Link ──────────────────────────────────────────────

  handlers['link.open_in_viewport'] = function()
    return wezterm.action.QuickSelectArgs {
      label = 'open url',
      patterns = { 'https?://\\S+' },
      action = wezterm.action_callback(function(window, pane)
        local url = window:get_selection_text_for_pane(pane)
        if not url or url == '' then return end
        local trace_id = logger.trace_id('link')
        logger.info('link', 'opening url via QuickSelect', common.merge_fields(trace_id, { url = url }))
        wezterm.open_with(url)
      end),
    }
  end

  -- ── Workspace ─────────────────────────────────────────

  handlers['workspace.switch'] = function(binding_args)
    local name = (binding_args and binding_args.name) or 'default'
    if name == 'default' then
      return wezterm.action.SwitchToWorkspace { name = 'default' }
    end
    return wezterm.action_callback(function(window, pane)
      workspace.open(window, pane, name)
    end)
  end

  handlers['workspace.cycle_next'] = function()
    return wezterm.action.SwitchWorkspaceRelative(1)
  end

  handlers['workspace.close_current'] = function()
    return wezterm.action.Confirmation {
      message = '🛑 Close the current workspace?',
      action = wezterm.action_callback(function(window, pane)
        workspace.close(window, pane)
      end),
    }
  end

  -- ── Application ───────────────────────────────────────

  handlers['app.quit'] = function()
    return wezterm.action.QuitApplication
  end

  -- ── Clipboard ─────────────────────────────────────────

  handlers['clipboard.copy_or_sigint'] = function()
    return wezterm.action_callback(function(window, pane)
      local has_selection = window:get_selection_text_for_pane(pane) ~= ''
      if has_selection then
        window:perform_action(wezterm.action.CopyTo 'Clipboard', pane)
        window:perform_action(wezterm.action.ClearSelection, pane)
      else
        window:perform_action(wezterm.action.SendString '\003', pane)
      end
    end)
  end

  handlers['clipboard.copy_selection_strict'] = function()
    return wezterm.action_callback(function(window, pane)
      local has_selection = window:get_selection_text_for_pane(pane) ~= ''
      if has_selection then
        window:perform_action(wezterm.action.CopyTo 'Clipboard', pane)
        window:perform_action(wezterm.action.ClearSelection, pane)
      else
        window:perform_action(wezterm.action.SendKey { key = 'c', mods = 'CTRL|SHIFT' }, pane)
      end
    end)
  end

  handlers['clipboard.paste_smart'] = function()
    return wezterm.action_callback(function(window, pane)
      local trace_id = logger.trace_id('clipboard')
      actions.paste_clipboard_or_image_path(wezterm, window, pane, constants, logger, trace_id, host)
    end)
  end

  handlers['clipboard.paste_plain'] = function()
    return wezterm.action.PasteFrom 'Clipboard'
  end

  return {
    get = function(name, binding_args, hotkey_args)
      local factory = handlers[name]
      if not factory then return nil end
      return factory(binding_args, hotkey_args)
    end,
    has = function(name)
      return handlers[name] ~= nil
    end,
  }
end

return M
