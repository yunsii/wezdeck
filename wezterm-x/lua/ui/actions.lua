local path_sep = package.config:sub(1, 1)

local function join_path(...)
  return table.concat({ ... }, path_sep)
end

local module_dir = join_path(rawget(_G, 'WEZTERM_RUNTIME_DIR') or '.', 'lua', 'ui')
local common = dofile(join_path(module_dir, 'common.lua'))

local M = {}

-- Build argv for spawning `scripts/runtime/attention-jump.sh` with the
-- given trailing arguments. Handles the hybrid-wsl case by wrapping the
-- call in `wsl.exe -d <distro> -- bash <script> ...`. `pane_ref` is only
-- used to resolve a WSL distro hint; when nil the builder falls back to
-- `constants.default_domain`. Returns nil (and logs a warn) when the
-- script path or WSL distro cannot be resolved.
-- Build the wsl.exe / bash argv for
-- scripts/runtime/attention-project-into-overflow.sh, which switches
-- the workspace overflow tab to <session> and emits a
-- tab.activate_overflow event. Used by attention.activate_in_gui as
-- the "no host found" fallback so Alt+/ on a folded session actually
-- jumps the user there instead of doing nothing.
function M.attention_project_into_overflow_args(constants, pane_ref, workspace, session, logger, trace_id)
  local repo_root = constants and constants.repo_root
  if not repo_root or repo_root == '' then
    if logger then
      logger.warn('attention', 'no repo_root to resolve project script', { trace = trace_id })
    end
    return nil
  end
  local script_path = repo_root .. '/scripts/runtime/attention-project-into-overflow.sh'
  local runtime_mode = (constants and constants.runtime_mode) or 'hybrid-wsl'
  if runtime_mode == 'hybrid-wsl' and constants.host_os == 'windows' then
    local distro = common.wsl_distro_from_domain(pane_ref and pane_ref:get_domain_name())
      or common.wsl_distro_from_domain(constants.default_domain)
    if not distro then
      if logger then
        logger.warn('attention', 'unable to resolve WSL distro for overflow project', { trace = trace_id })
      end
      return nil
    end
    return { 'wsl.exe', '-d', distro, '--', 'bash', script_path, workspace, session }
  end
  return { 'bash', script_path, workspace, session }
end

-- Build the wsl.exe / bash argv for scripts/runtime/tab-overflow-attach.sh,
-- which `tmux switch-client -c <tty> -t <target_session>` the workspace
-- overflow pane to a different session. Used by
-- Workspace.maybe_clear_overflow_collision when the brain promotes a
-- session into top-N and the overflow pane is still projecting it; the
-- target there is the per-workspace browse session
-- (`wezterm_<slug>_overflow`) so the overflow tab visibly hands off the
-- session to its newly-spawned visible tab. Symmetric with
-- `attention_project_into_overflow_args` — same WSL-wrap rule, same
-- nil-on-failure contract.
function M.tab_overflow_attach_args(constants, pane_ref, workspace, target_session, logger, trace_id)
  local repo_root = constants and constants.repo_root
  if not repo_root or repo_root == '' then
    if logger then
      logger.warn('tab_visibility', 'no repo_root to resolve overflow-attach script', { trace = trace_id })
    end
    return nil
  end
  local script_path = repo_root .. '/scripts/runtime/tab-overflow-attach.sh'
  local runtime_mode = (constants and constants.runtime_mode) or 'hybrid-wsl'
  if runtime_mode == 'hybrid-wsl' and constants.host_os == 'windows' then
    local distro = common.wsl_distro_from_domain(pane_ref and pane_ref:get_domain_name())
      or common.wsl_distro_from_domain(constants.default_domain)
    if not distro then
      if logger then
        logger.warn('tab_visibility', 'unable to resolve WSL distro for overflow attach', { trace = trace_id })
      end
      return nil
    end
    return { 'wsl.exe', '-d', distro, '--', 'bash', script_path, workspace, target_session }
  end
  return { 'bash', script_path, workspace, target_session }
end

-- Wall-clock epoch ms for jump-lag accounting. Compared later in WSL
-- against runtime_log_now_ms(); sub-second Win↔WSL skew is noise, the
-- signal we care about is multi-second wsl.exe spawn backlog.
local function attention_jump_dispatch_ms()
  local ok, formatted = pcall(function()
    local wezterm = require 'wezterm'
    return wezterm.time.now():format '%s%3f'
  end)
  if ok and type(formatted) == 'string' then
    local ms = tonumber((formatted:gsub('%.', '')):match('^(%d+)'))
    if ms then
      return ms
    end
  end
  return (os.time() or 0) * 1000
end

function M.attention_jump_args(constants, pane_ref, trailing_args, logger, trace_id)
  local repo_root = constants and constants.repo_root
  if not repo_root or repo_root == '' then
    if logger then
      logger.warn('attention', 'no repo_root to resolve jump script', { trace = trace_id })
    end
    return nil
  end
  local script_path = repo_root .. '/scripts/runtime/attention-jump.sh'
  local runtime_mode = (constants and constants.runtime_mode) or 'hybrid-wsl'
  local dispatch_ms = tostring(attention_jump_dispatch_ms())
  local trace_env = 'WEZTERM_RUNTIME_TRACE_ID=' .. (trace_id or '')
  local dispatch_env = 'WEZTERM_ATTENTION_JUMP_DISPATCH_MS=' .. dispatch_ms
  if runtime_mode == 'hybrid-wsl' and constants.host_os == 'windows' then
    local distro = common.wsl_distro_from_domain(pane_ref and pane_ref:get_domain_name())
      or common.wsl_distro_from_domain(constants.default_domain)
    if not distro then
      if logger then
        logger.warn('attention', 'unable to resolve WSL distro for attention jump', { trace = trace_id })
      end
      return nil
    end
    local args = {
      'wsl.exe', '-d', distro, '--', 'env',
      trace_env,
      dispatch_env,
      'bash', script_path,
    }
    for _, a in ipairs(trailing_args) do
      table.insert(args, a)
    end
    return args
  end
  local args = { 'env', trace_env, dispatch_env, 'bash', script_path }
  for _, a in ipairs(trailing_args) do
    table.insert(args, a)
  end
  return args
end

function M.workspace_keybinding(wezterm, workspace, key, name)
  return {
    key = key,
    mods = 'ALT',
    action = wezterm.action_callback(function(window, pane)
      workspace.open(window, pane, name)
    end),
  }
end

function M.is_tmux_backed_pane(constants, window, pane)
  local workspace_name = common.active_workspace_name(window)
  if workspace_name ~= nil and workspace_name ~= 'default' then
    return true, 'managed_workspace'
  end

  if constants.runtime_mode == 'hybrid-wsl' and constants.host_os == 'windows' then
    local domain_name = pane and pane:get_domain_name() or nil
    if common.wsl_distro_from_domain(domain_name) then
      return true, 'hybrid_wsl_domain'
    end
  end

  local foreground_process = common.foreground_process_basename(pane)
  if foreground_process == 'tmux' then
    return true, 'foreground_tmux'
  end

  return false, 'not_tmux_backed'
end

function M.forward_shortcut_to_pane(wezterm, window, pane, shortcut, sequence, logger, category, workspace_name, trace_id)
  logger.info(category, 'forwarding shortcut to pane', common.merge_fields(trace_id, {
    shortcut = shortcut,
    sequence = sequence,
    workspace = workspace_name,
    domain = pane:get_domain_name(),
  }))
  window:perform_action(wezterm.action.SendString(sequence), pane)
end

-- Resolve link.open_target to 'slot' | 'system'. Legacy 'debug' ≡ 'slot'.
-- Unknown values fall back to 'slot' (browser-slot default for link opens).
function M.read_link_open_target(constants)
  local link = constants and constants.link or {}
  local target = link.open_target
  if target == 'system' then
    return 'system'
  end
  -- 'slot' and legacy 'debug' (and anything else) → slot
  return 'slot'
end

-- Publish open_target + launch hints for bash (links-dispatch / link-open.sh).
-- Best-effort: missing config_file or write failure must not break startup.
function M.publish_link_open_config(constants, logger, reason)
  local link = constants and constants.link or {}
  local path = link.config_file
  if type(path) ~= 'string' or path == '' then
    return false
  end

  local chrome = constants.chrome_debug_browser or {}
  local agent = constants.browser_agent or {}
  local target = M.read_link_open_target(constants)
  local backend = M.read_browser_backend(constants)
  local now_ms = tostring(os.time() * 1000)
  -- Minimal JSON (no nested encoder dependency). Paths are escaped for
  -- Windows backslashes and quotes so bash jq/python can read them.
  local function jesc(s)
    if type(s) ~= 'string' then
      return ''
    end
    return (s:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\r', ''):gsub('\n', ' '))
  end

  local ego_exe = ''
  do
    local status_path = agent.status_file
    if type(status_path) == 'string' and status_path ~= '' then
      local f = io.open(status_path, 'r')
      if f then
        local content = f:read('*a') or ''
        f:close()
        ego_exe = content:match('"exe"%s*:%s*"([^"]+)"') or ''
      end
    end
  end
  if ego_exe == '' then
    ego_exe = 'C:\\Program Files\\Citro Labs\\ego lite\\Application\\ego.exe'
  end

  local body = table.concat({
    '{',
    '"open_target":"', target, '",',
    '"backend":"', backend, '",',
    '"updated_at_ms":', now_ms, ',',
    '"chrome_path":"', jesc(chrome.executable or 'chrome.exe'), '",',
    '"remote_debugging_port":', tostring(chrome.remote_debugging_port or 9222), ',',
    '"user_data_dir":"', jesc(chrome.user_data_dir or ''), '",',
    '"ego_exe":"', jesc(ego_exe), '"',
    '}',
  })

  local dir = path:match('^(.*)[/\\][^/\\]+$')
  if dir and dir ~= '' then
    -- Best-effort mkdir via PowerShell is elsewhere; io.open fails if missing.
    -- The sync/runtime tree already creates state/; create leaf on write fail.
    pcall(function()
      local ps = os.getenv('SystemRoot')
      if ps and ps ~= '' then
        -- no-op; directory creation attempted by open below after mkdir via
        -- wezterm is unavailable here. Caller may pre-create.
      end
    end)
  end

  local tmp = path .. '.tmp'
  local f, err = io.open(tmp, 'wb')
  if not f then
    -- Try creating the parent directory once (Windows + posix).
    if dir and dir ~= '' then
      if package.config:sub(1, 1) == '\\' then
        os.execute('mkdir "' .. dir:gsub('/', '\\') .. '" 2>nul')
      else
        os.execute('mkdir -p "' .. dir .. '" 2>/dev/null')
      end
      f, err = io.open(tmp, 'wb')
    end
  end
  if not f then
    if logger then
      logger.warn('link', 'failed to publish link-open config', {
        path = path,
        error = err,
        reason = reason,
      })
    end
    return false
  end
  f:write(body)
  f:close()
  local ok_rename = os.rename(tmp, path)
  if not ok_rename then
    -- Windows rename over existing may fail; remove then rename.
    os.remove(path)
    ok_rename = os.rename(tmp, path)
  end
  if logger then
    logger.info('link', 'published link-open config', {
      path = path,
      open_target = target,
      backend = backend,
      reason = reason,
      ok = ok_rename and true or false,
    })
  end
  return ok_rename and true or false
end

local function powershell_single_quote(s)
  return "'" .. tostring(s):gsub("'", "''") .. "'"
end

-- After debug Chrome is visible, open `url` in that profile via a second
-- chrome.exe launch (singleton hands the URL to the running instance).
function M.navigate_debug_chrome_url(wezterm, constants, logger, trace_id, url)
  local chrome = constants.chrome_debug_browser or {}
  local chrome_path = chrome.executable or 'chrome.exe'
  local port = tostring(chrome.remote_debugging_port or 9222)
  local user_data_dir = chrome.user_data_dir or ''
  if user_data_dir == '' then
    if logger then
      logger.warn('link', 'navigate skipped: missing user_data_dir', common.merge_fields(trace_id, {
        url = url,
      }))
    end
    return false
  end

  local ps = os.getenv('SystemRoot')
  if not ps or ps == '' then
    ps = 'C:\\Windows'
  end
  local powershell = ps .. '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  -- ArgumentList must be discrete argv entries; a single quoted string
  -- would land as one chrome arg and fail to open the URL.
  local cmd = table.concat({
    'Start-Process -FilePath ', powershell_single_quote(chrome_path),
    ' -ArgumentList @(',
    powershell_single_quote('--remote-debugging-port=' .. port), ',',
    powershell_single_quote('--user-data-dir=' .. user_data_dir), ',',
    powershell_single_quote('--remote-allow-origins=*'), ',',
    powershell_single_quote(url),
    ')',
  })
  local args = {
    powershell,
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', cmd,
  }
  local ok, err = pcall(wezterm.background_child_process, args)
  if logger then
    if ok then
      logger.info('link', 'navigating debug chrome', common.merge_fields(trace_id, {
        url = url,
        port = port,
      }))
    else
      logger.error('link', 'debug chrome navigate spawn failed', common.merge_fields(trace_id, {
        url = url,
        error = err,
      }))
    end
  end
  return ok and true or false
end

function M.navigate_ego_url(wezterm, constants, logger, trace_id, url)
  local agent = constants.browser_agent or {}
  local ego_exe = 'C:\\Program Files\\Citro Labs\\ego lite\\Application\\ego.exe'
  do
    local status_path = agent.status_file
    if type(status_path) == 'string' and status_path ~= '' then
      local f = io.open(status_path, 'r')
      if f then
        local content = f:read('*a') or ''
        f:close()
        local from_status = content:match('"exe"%s*:%s*"([^"]+)"')
        if from_status and from_status ~= '' then
          ego_exe = from_status
        end
      end
    end
  end

  local ps = os.getenv('SystemRoot')
  if not ps or ps == '' then
    ps = 'C:\\Windows'
  end
  local powershell = ps .. '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  local cmd = 'Start-Process -FilePath '
    .. powershell_single_quote(ego_exe)
    .. ' -ArgumentList '
    .. powershell_single_quote(url)
  local args = {
    powershell,
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', cmd,
  }
  local ok, err = pcall(wezterm.background_child_process, args)
  if logger then
    if ok then
      logger.info('link', 'navigating ego', common.merge_fields(trace_id, { url = url }))
    else
      logger.error('link', 'ego navigate spawn failed', common.merge_fields(trace_id, {
        url = url,
        error = err,
      }))
    end
  end
  return ok and true or false
end

-- Open an http(s) URL according to link.open_target.
-- opts: window (optional toast), source (quick_select|open_uri|…)
function M.open_url(wezterm, window, constants, logger, host, url, opts)
  opts = opts or {}
  if type(url) ~= 'string' or url == '' then
    return false
  end
  -- Trim trailing punctuation that QuickSelect sometimes keeps.
  url = url:match('^(https?://%S+)') or url
  url = url:gsub('[\\.,;:%)%]]+$', '')

  local trace_id = logger and logger.trace_id and logger.trace_id('link') or nil
  local target = M.read_link_open_target(constants)
  if logger then
    logger.info('link', 'opening url', common.merge_fields(trace_id, {
      url = url,
      open_target = target,
      source = opts.source,
    }))
  end

  if target == 'system' then
    wezterm.open_with(url)
    return true
  end

  if not constants or (constants.runtime_mode or 'hybrid-wsl') ~= 'hybrid-wsl'
    or constants.host_os ~= 'windows' then
    if logger then
      logger.warn('link', 'slot open unavailable; falling back to system handler', common.merge_fields(trace_id, {
        runtime_mode = constants and constants.runtime_mode,
        host_os = constants and constants.host_os,
      }))
    end
    wezterm.open_with(url)
    return true
  end

  local backend = M.read_browser_backend(constants)
  if backend == 'ego' then
    M.ensure_ego(wezterm, constants, logger, trace_id, {
      focus = true,
      quiet = true,
      window = window,
      reason = opts.source or 'open_url',
    })
    return M.navigate_ego_url(wezterm, constants, logger, trace_id, url)
  end

  if not host then
    if logger then
      logger.warn('link', 'slot open missing host; falling back to system', common.merge_fields(trace_id, {
        url = url,
      }))
    end
    wezterm.open_with(url)
    return true
  end

  -- Visible debug Chrome, then hand the URL to that profile.
  if not M.open_debug_chrome(wezterm, window, constants, logger, trace_id, host, false) then
    return false
  end
  return M.navigate_debug_chrome_url(wezterm, constants, logger, trace_id, url)
end

-- QuickSelect that labels every http(s) URL in the focused pane / scrollback
-- and opens the chosen one via link.open_target. Shared by the (optional)
-- WezTerm-layer hotkey and the command-palette → event-bus path
-- (`link.quick_select`).
function M.link_quick_select_action(wezterm, logger, constants, host)
  return wezterm.action.QuickSelectArgs {
    label = 'open url',
    patterns = { 'https?://\\S+' },
    action = wezterm.action_callback(function(window, pane)
      local url = window:get_selection_text_for_pane(pane)
      if not url or url == '' then return end
      M.open_url(wezterm, window, constants, logger, host, url, { source = 'quick_select' })
    end),
  }
end

function M.tmux_only_shortcut(window, logger, shortcut, trace_id)
  logger.warn('workspace', 'shortcut requires a tmux-backed pane', common.merge_fields(trace_id, {
    shortcut = shortcut,
    workspace = common.active_workspace_name(window),
  }))
  window:toast_notification('WezTerm', shortcut .. ' is only available when the current pane is running tmux', nil, 3000)
end

function M.paste_clipboard_or_image_path(wezterm, window, pane, constants, logger, trace_id, host)
  local runtime_mode = constants.runtime_mode or 'hybrid-wsl'
  if runtime_mode ~= 'hybrid-wsl' or constants.host_os ~= 'windows' then
    window:perform_action(wezterm.action.PasteFrom 'Clipboard', pane)
    return
  end

  local domain_name = pane:get_domain_name()
  local distro = common.wsl_distro_from_domain(domain_name) or common.wsl_distro_from_domain(constants.default_domain)
  if not distro then
    logger.info('clipboard', 'falling back to plain clipboard paste outside WSL', common.merge_fields(trace_id, {
      domain = domain_name,
      runtime_mode = runtime_mode,
    }))
    window:perform_action(wezterm.action.PasteFrom 'Clipboard', pane)
    return
  end

  local clipboard_feature = host:feature 'clipboard_image'
  if not clipboard_feature or not clipboard_feature.resolve_for_paste then
    window:perform_action(wezterm.action.PasteFrom 'Clipboard', pane)
    return
  end

  local resolved_state, resolve_reason = clipboard_feature.resolve_for_paste(trace_id)
  if not resolved_state then
    logger.warn('clipboard', 'failed to resolve clipboard state via windows helper', common.merge_fields(trace_id, {
      domain = domain_name,
      distro = distro,
      reason = resolve_reason,
    }))
    window:perform_action(wezterm.action.PasteFrom 'Clipboard', pane)
    return
  end

  if resolved_state.result_type ~= 'clipboard_image' then
    window:perform_action(wezterm.action.PasteFrom 'Clipboard', pane)
    return
  end

  local result = resolved_state.result or {}
  local image_path = result.wsl_path
  if (not image_path or image_path == '') and result.windows_path and result.windows_path ~= '' then
    image_path = clipboard_feature.windows_path_to_wsl_path(result.windows_path)
  end

  if not image_path or image_path == '' then
    logger.warn('clipboard', 'resolved clipboard image is missing a WSL path', common.merge_fields(trace_id, {
      domain = domain_name,
      distro = distro,
      windows_path = result.windows_path,
    }))
    window:perform_action(wezterm.action.PasteFrom 'Clipboard', pane)
    return
  end

  if result.windows_path and result.windows_path ~= '' and not host:file_exists(result.windows_path) then
    logger.warn('clipboard', 'resolved clipboard image file is missing on disk', common.merge_fields(trace_id, {
      domain = domain_name,
      distro = distro,
      image_path = image_path,
      windows_path = result.windows_path,
    }))
    window:perform_action(wezterm.action.PasteFrom 'Clipboard', pane)
    return
  end

  pane:send_paste(image_path)
  logger.info('clipboard', 'pasted resolved clipboard image path', common.merge_fields(trace_id, {
    distro = distro,
    domain = domain_name,
    image_path = image_path,
    sequence = resolved_state.sequence,
  }))
end

function M.open_current_dir_in_vscode(wezterm, window, pane, constants, logger, trace_id, host)
  local raw_cwd = pane:get_current_working_dir()
  local cwd = common.file_path_from_cwd(raw_cwd)
  local domain_name = pane:get_domain_name()
  local workspace_name = common.active_workspace_name(window)
  local runtime_mode = constants.runtime_mode or 'hybrid-wsl'
  local integration = constants.integrations and constants.integrations.vscode or {}
  local command

  if not cwd or cwd == '/' then
    logger.warn('vscode', 'current pane working directory is unavailable', common.merge_fields(trace_id, {
      domain = domain_name,
      raw_cwd = tostring(raw_cwd),
      workspace = workspace_name,
    }))
    window:toast_notification('WezTerm', 'Alt+v failed: current pane working directory is unavailable', nil, 3000)
    return
  end

  if runtime_mode == 'hybrid-wsl' then
    local distro = common.wsl_distro_from_domain(domain_name) or common.wsl_distro_from_domain(constants.default_domain)
    if not distro then
      logger.warn('vscode', 'current pane is not backed by a WSL domain', common.merge_fields(trace_id, {
        cwd = cwd,
        domain = domain_name,
      }))
      window:toast_notification('WezTerm', 'Alt+v failed: current pane is not backed by a WSL domain', nil, 3000)
      return
    end

    local hybrid_command = common.copy_args(integration.hybrid_wsl_command)
    if not hybrid_command or #hybrid_command == 0 then
      hybrid_command = { 'code' }
    end

    local helper_sent, helper_reason = host:request('vscode', trace_id, {
      cwd = cwd,
      distro = distro,
      code_command = hybrid_command,
      max_windows = integration.max_windows,
    })
    if helper_sent then
      return
    end

    logger.error('vscode', 'windows helper Alt+v request failed', common.merge_fields(trace_id, {
      reason = helper_reason,
      cwd = cwd,
      distro = distro,
    }))
    window:toast_notification('WezTerm', 'Alt+v failed. Check WezTerm logs.', nil, 3000)
    return
  else
    local posix_command = common.copy_args(integration.posix_command)
    if not posix_command or #posix_command == 0 then
      posix_command = { 'code' }
    end

    command = {
      'env',
      'WEZTERM_RUNTIME_TRACE_ID=' .. (trace_id or ''),
      integration.posix_shell or '/bin/bash',
      integration.posix_script or (wezterm.config_dir .. '/scripts/runtime/open-current-dir-in-vscode.sh'),
      '--code-command',
    }

    for _, part in ipairs(posix_command) do
      command[#command + 1] = part
    end

    command[#command + 1] = '--'
    command[#command + 1] = cwd
  end

  logger.info('vscode', 'opening current dir via WezTerm', common.merge_fields(trace_id, {
    command = table.concat(command, ' '),
    cwd = cwd,
    domain = domain_name,
    runtime_mode = runtime_mode,
  }))
  local ok, err = pcall(wezterm.background_child_process, command)
  if not ok then
    window:toast_notification('WezTerm', 'Alt+v failed. Check WezTerm logs.', nil, 3000)
    logger.error('vscode', 'background_child_process failed', common.merge_fields(trace_id, {
      error = err,
    }))
  end
end

function M.read_browser_backend(constants)
  local agent = constants.browser_agent or {}
  local path = agent.status_file
  if type(path) ~= 'string' or path == '' then
    return 'cdp'
  end
  local f = io.open(path, 'r')
  if not f then
    return 'cdp'
  end
  local content = f:read('*a')
  f:close()
  if type(content) ~= 'string' or content == '' then
    return 'cdp'
  end
  local backend = content:match('"backend"%s*:%s*"(ego)"') or content:match('"backend"%s*:%s*"(cdp)"')
  if backend == 'ego' then
    return 'ego'
  end
  return 'cdp'
end

-- Ensure / focus ego (lite). opts: focus=bool, quiet=bool (no toast; for gui-startup).
function M.ensure_ego(wezterm, constants, logger, trace_id, opts)
  opts = opts or {}
  local focus = opts.focus and true or false
  local quiet = opts.quiet and true or false
  local window = opts.window
  local agent = constants.browser_agent or {}
  local script = agent.ego_window_script
  local status_file = agent.status_file or ''

  if type(script) ~= 'string' or script == '' then
    if logger then
      logger.warn('browser_agent', 'missing ego_window_script', common.merge_fields(trace_id, {
        focus = focus,
        quiet = quiet,
      }))
    end
    if window and not quiet then
      window:toast_notification('WezTerm', 'Ego ensure failed: ego_window_script not configured', nil, 4000)
    end
    return false
  end

  local ps = os.getenv('SystemRoot')
  if not ps or ps == '' then
    ps = 'C:\\Windows'
  end
  ps = ps .. '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

  local args = {
    ps,
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
  }
  if focus then
    args[#args + 1] = '-Focus'
  else
    args[#args + 1] = '-Ensure'
  end
  if status_file ~= '' then
    args[#args + 1] = '-StatusFile'
    args[#args + 1] = status_file
  end

  if logger then
    logger.info('browser_agent', 'ego window request', common.merge_fields(trace_id, {
      focus = focus,
      quiet = quiet,
      script = script,
      reason = opts.reason or 'manual',
    }))
  end

  local ok, err = pcall(wezterm.background_child_process, args)
  if not ok then
    if logger then
      logger.error('browser_agent', 'ego window spawn failed', common.merge_fields(trace_id, {
        error = err,
        focus = focus,
        quiet = quiet,
      }))
    end
    if window and not quiet then
      window:toast_notification('WezTerm', 'Ego ensure failed. Check WezTerm logs.', nil, 3000)
    end
    return false
  end

  -- Success toast only for Alt+b (no focus steal): same quiet-on-success
  -- rule as the CDP path for Alt+Shift+b, where the focused window is the signal.
  if window and not quiet and not focus then
    window:toast_notification('WezTerm', 'Ego is running', nil, 2000)
  end
  return true
end

function M.open_debug_chrome(wezterm, window, constants, logger, trace_id, host, override_headless)
  local chrome_source = constants.chrome_debug_browser or {}
  local runtime_mode = constants.runtime_mode or 'hybrid-wsl'

  local chrome = {}
  for k, v in pairs(chrome_source) do
    chrome[k] = v
  end
  if override_headless ~= nil then
    chrome.headless = override_headless
  end
  local shortcut_label = chrome.headless and 'Alt+b' or 'Alt+Shift+b'
  local focus = not chrome.headless

  if M.read_browser_backend(constants) == 'ego' then
    return M.ensure_ego(wezterm, constants, logger, trace_id, {
      focus = focus,
      window = window,
      reason = 'hotkey',
    }) and true or false
  end

  if not chrome.user_data_dir or chrome.user_data_dir == '' then
    logger.warn('chrome', 'missing chrome debug browser user_data_dir', common.merge_fields(trace_id, {
      runtime_mode = runtime_mode,
      headless = chrome.headless,
    }))
    if window then
      window:toast_notification('WezTerm', shortcut_label .. ' failed: configure chrome_debug_browser.user_data_dir in wezterm-x/local/constants.lua', nil, 4000)
    end
    return false
  end

  if runtime_mode == 'hybrid-wsl' then
    local helper_sent, helper_reason = host:request('chrome_debug', trace_id, chrome)
    if helper_sent then
      return true
    end

    logger.error('chrome', 'windows helper chrome request failed', common.merge_fields(trace_id, {
      reason = helper_reason,
      runtime_mode = runtime_mode,
      port = chrome.remote_debugging_port,
      user_data_dir = chrome.user_data_dir,
      headless = chrome.headless,
    }))
    if window then
      window:toast_notification('WezTerm', shortcut_label .. ' failed. Check WezTerm logs.', nil, 3000)
    end
    return false
  end

  logger.warn('chrome', 'chrome debug shortcut is unavailable without a native WezDeck Runtime', common.merge_fields(trace_id, {
    runtime_mode = runtime_mode,
    executable = chrome.executable,
    port = chrome.remote_debugging_port,
    headless = chrome.headless,
  }))
  if window then
    window:toast_notification('WezTerm', shortcut_label .. ' is only available when a native WezDeck Runtime is configured.', nil, 4000)
  end
  return false
end

return M
