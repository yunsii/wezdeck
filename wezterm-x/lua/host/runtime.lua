local M = {}
M.__index = M

local function merge_fields(trace_id, fields)
  local merged = {}

  for key, value in pairs(fields or {}) do
    merged[key] = value
  end
  if trace_id and trace_id ~= '' then
    merged.trace_id = trace_id
  end

  return merged
end

local function json_escape(value)
  local text = tostring(value or '')
  text = text:gsub('\\', '\\\\')
  text = text:gsub('"', '\\"')
  text = text:gsub('\n', '\\n')
  text = text:gsub('\r', '\\r')
  text = text:gsub('\t', '\\t')
  return '"' .. text .. '"'
end

local function base64_encode(data)
  local alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  local result = {}
  local bytes = { data:byte(1, #data) }
  local padding = (3 - (#bytes % 3)) % 3

  for _ = 1, padding do
    bytes[#bytes + 1] = 0
  end

  for index = 1, #bytes, 3 do
    local chunk = bytes[index] * 65536 + bytes[index + 1] * 256 + bytes[index + 2]
    local a = math.floor(chunk / 262144) % 64 + 1
    local b = math.floor(chunk / 4096) % 64 + 1
    local c = math.floor(chunk / 64) % 64 + 1
    local d = chunk % 64 + 1
    result[#result + 1] = alphabet:sub(a, a)
    result[#result + 1] = alphabet:sub(b, b)
    result[#result + 1] = alphabet:sub(c, c)
    result[#result + 1] = alphabet:sub(d, d)
  end

  for index = 1, padding do
    result[#result - index + 1] = '='
  end

  return table.concat(result)
end

local function current_epoch_ms()
  return os.time() * 1000
end

local function diagnostics_capture_enabled(constants, category)
  local diagnostics = constants and constants.diagnostics or {}
  local wezterm_diagnostics = diagnostics.wezterm or {}
  local categories = wezterm_diagnostics.categories or {}

  if wezterm_diagnostics.enabled ~= true then
    return false
  end

  if next(categories) == nil then
    return true
  end

  return categories[category] == true
end

local function wsl_distro_from_domain(domain_name)
  if not domain_name then
    return nil
  end

  return domain_name:match '^WSL:(.+)$'
end

local function helper_integration(constants)
  return constants.integrations and constants.integrations.vscode or {}
end

function M.new(opts)
  return setmetatable({
    wezterm = opts.wezterm,
    constants = opts.constants,
    helpers = opts.helpers,
    logger = opts.logger,
  }, M)
end

function M:integration(name)
  return self.constants.integrations and self.constants.integrations[name] or {}
end

function M:helper_integration()
  return helper_integration(self.constants)
end

function M:merge_fields(trace_id, fields)
  return merge_fields(trace_id, fields)
end

function M:json_escape(value)
  return json_escape(value)
end

function M:current_epoch_ms()
  return current_epoch_ms()
end

function M:supports_windows_helper()
  local runtime_mode = self.constants.runtime_mode or 'hybrid-wsl'
  return runtime_mode == 'hybrid-wsl' and self.constants.host_os == 'windows'
end

function M:show_windows_notification(category, trace_id, title, message)
  if self.wezterm.gui and self.wezterm.gui.gui_windows then
    local ok, windows = pcall(self.wezterm.gui.gui_windows)
    if ok and windows and windows[1] and windows[1].toast_notification then
      local shown, err = pcall(windows[1].toast_notification, windows[1], title or 'WezTerm', message or '', nil, 4000)
      if shown then
        return
      end

      self.logger.warn(category, 'failed to show wezterm toast notification', merge_fields(trace_id, {
        error = err,
        title = title,
        message = message,
      }))
      return
    end
  end

  self.logger.warn(category, 'wezterm toast notification unavailable', merge_fields(trace_id, {
    title = title,
    message = message,
  }))
end

function M:helper_command()
  if not self:supports_windows_helper() then
    return nil, 'unsupported_runtime'
  end

  local integration = self:helper_integration()
  local runtime_dir = integration.runtime_dir or rawget(_G, 'WEZTERM_RUNTIME_DIR') or (self.wezterm.config_dir .. '\\.wezterm-x')
  local helper_script = integration.helper_script or 'scripts\\ensure-windows-runtime-helper.ps1'
  local diagnostics = self.constants.diagnostics and self.constants.diagnostics.wezterm or {}
  local clipboard = self:integration 'clipboard_image'
  local helper_category_enabled = diagnostics_capture_enabled(self.constants, 'alt_o')
    or diagnostics_capture_enabled(self.constants, 'chrome')
    or diagnostics_capture_enabled(self.constants, 'clipboard')

  return {
    integration.powershell or 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    runtime_dir .. '\\' .. helper_script,
    '-Port',
    tostring(integration.helper_port or 45921),
    '-StatePath',
    integration.helper_state_path or '',
    '-ClipboardStatePath',
    clipboard.state_path or '',
    '-ClipboardLogPath',
    clipboard.log_path or '',
    '-ClipboardOutputDir',
    clipboard.output_dir or '',
    '-ClipboardWslDistro',
    wsl_distro_from_domain(self.constants.default_domain) or '',
    '-ClipboardHeartbeatIntervalSeconds',
    tostring(clipboard.heartbeat_interval_seconds or 1),
    '-ClipboardImageReadRetryCount',
    tostring(clipboard.image_read_retry_count or 12),
    '-ClipboardImageReadRetryDelayMs',
    tostring(clipboard.image_read_retry_delay_ms or 100),
    '-ClipboardCleanupMaxAgeHours',
    tostring(clipboard.cleanup_max_age_hours or 48),
    '-ClipboardCleanupMaxFiles',
    tostring(clipboard.cleanup_max_files or 32),
    '-HeartbeatTimeoutSeconds',
    tostring(integration.helper_heartbeat_timeout_seconds or 5),
    '-HeartbeatIntervalMs',
    tostring(integration.helper_heartbeat_interval_ms or 1000),
    '-PollIntervalMs',
    tostring(integration.helper_poll_interval_ms or 25),
    '-DiagnosticsEnabled',
    diagnostics.enabled == true and '1' or '0',
    '-DiagnosticsCategoryEnabled',
    helper_category_enabled and '1' or '0',
    '-DiagnosticsLevel',
    diagnostics.level or 'info',
    '-DiagnosticsFile',
    diagnostics.file or '',
    '-DiagnosticsMaxBytes',
    tostring(diagnostics.max_bytes or 0),
    '-DiagnosticsMaxFiles',
    tostring(diagnostics.max_files or 0),
  }, nil
end

function M:helper_request_command(payload_json)
  if not self:supports_windows_helper() then
    return nil, 'unsupported_runtime'
  end

  local integration = self:helper_integration()
  local helper_manager_exe = integration.helper_manager_exe
  local helper_ipc_endpoint = integration.helper_ipc_endpoint
  if not helper_manager_exe or helper_manager_exe == '' then
    return nil, 'manager_exe_unconfigured'
  end
  if not helper_ipc_endpoint or helper_ipc_endpoint == '' then
    return nil, 'ipc_endpoint_unconfigured'
  end

  return {
    helper_manager_exe,
    'request',
    '--pipe',
    helper_ipc_endpoint,
    '--payload-base64',
    base64_encode(payload_json),
    '--timeout-ms',
    tostring(integration.helper_request_timeout_ms or 5000),
  }, nil
end

function M:ensure_helper_running(reason)
  local command, command_reason = self:helper_command()
  if not command then
    return false, command_reason
  end

  self.logger.info('alt_o', 'ensuring windows runtime helper is running', {
    reason = reason,
  })

  local ok, err = pcall(self.wezterm.background_child_process, command)
  if not ok then
    self.logger.error('alt_o', 'failed to start windows runtime helper', {
      error = err,
      reason = reason,
    })
    return false, 'spawn_failed'
  end

  return true, nil
end

function M:ensure_helper_running_sync(reason)
  local command, command_reason = self:helper_command()
  if not command then
    return false, command_reason
  end

  self.logger.info('alt_o', 'ensuring windows runtime helper synchronously', {
    reason = reason,
  })

  local ok, success, stdout, stderr = pcall(self.wezterm.run_child_process, command)
  if not ok then
    self.logger.error('alt_o', 'synchronous windows runtime helper launch raised an error', {
      error = success,
      reason = reason,
    })
    return false, 'spawn_error'
  end

  if not success then
    self.logger.warn('alt_o', 'synchronous windows runtime helper launch failed', {
      reason = reason,
      stdout = stdout,
      stderr = stderr,
    })
    return false, 'spawn_failed'
  end

  return true, nil
end

function M:read_helper_state(trace_id)
  local integration = self:helper_integration()
  local state_path = integration.helper_state_path
  if not state_path or state_path == '' then
    return nil, 'state_path_unconfigured'
  end

  local ok, helper_state = pcall(self.helpers.load_optional_env_file, state_path)
  if not ok then
    self.logger.warn('alt_o', 'failed to parse windows runtime helper state', merge_fields(trace_id, {
      error = helper_state,
      state_path = state_path,
    }))
    return nil, 'state_parse_failed'
  end

  if not helper_state or next(helper_state) == nil then
    return nil, 'state_missing'
  end

  helper_state.__state_path = state_path
  return helper_state, nil
end

function M:helper_state_is_fresh(helper_state)
  local integration = self:helper_integration()
  local heartbeat_timeout = tonumber(integration.helper_heartbeat_timeout_seconds or 5) or 5
  local heartbeat_at_ms = tonumber(helper_state.heartbeat_at_ms or '') or 0
  local pid = tonumber(helper_state.pid or '') or 0

  if helper_state.ready ~= '1' then
    return false, 'not_ready'
  end

  if pid <= 0 then
    return false, 'missing_pid'
  end

  if heartbeat_at_ms <= 0 then
    return false, 'missing_heartbeat'
  end

  if current_epoch_ms() - heartbeat_at_ms > heartbeat_timeout * 1000 then
    return false, 'stale_heartbeat'
  end

  return true, nil
end

function M:write_request(trace_id, category, request_kind, payload_body_factory)
  local helper_state, helper_state_reason = self:read_helper_state(trace_id)
  local helper_ready = false
  local helper_ready_reason = helper_state_reason
  local ensure_reason = nil

  if helper_state then
    helper_ready, helper_ready_reason = self:helper_state_is_fresh(helper_state)
  end

  if not helper_ready then
    local ensured, ensured_reason = self:ensure_helper_running_sync('state-' .. (helper_ready_reason or 'missing'))
    if not ensured then
      return false, ensured_reason
    end

    ensure_reason = 'state_' .. (helper_ready_reason or 'missing')
    helper_state, helper_state_reason = self:read_helper_state(trace_id)
    if not helper_state then
      return false, helper_state_reason or 'state_missing_after_ensure'
    end

    helper_ready, helper_ready_reason = self:helper_state_is_fresh(helper_state)
    if not helper_ready then
      return false, helper_ready_reason or 'state_not_fresh_after_ensure'
    end
  end

  local request_trace_id = trace_id or tostring(os.time())
  local payload_body = payload_body_factory(request_trace_id)
  local request_body = table.concat {
    '{',
    '"version":1,',
    '"trace_id":', json_escape(request_trace_id), ',',
    '"kind":', json_escape(request_kind), ',',
    '"payload":', payload_body,
    '}',
  }
  local request_command, request_command_reason = self:helper_request_command(request_body)
  if not request_command then
    return false, request_command_reason
  end

  self.logger.info(category, 'sending request via windows runtime helper ipc', merge_fields(trace_id, {
    ensure_reason = ensure_reason or helper_ready_reason or 'ready',
  }))

  local ok, success, stdout, stderr = pcall(self.wezterm.run_child_process, request_command)
  if not ok or not success then
    self:ensure_helper_running_sync 'request-ipc-retry'
    ok, success, stdout, stderr = pcall(self.wezterm.run_child_process, request_command)
  end

  if not ok then
    self.logger.warn(category, 'windows runtime helper ipc request raised an error', merge_fields(trace_id, {
      error = success,
    }))
    return false, 'request_spawn_error'
  end

  if not success then
    self.logger.warn(category, 'windows runtime helper ipc request failed', merge_fields(trace_id, {
      stdout = stdout,
      stderr = stderr,
    }))
    return false, 'request_failed'
  end

  self.logger.info(category, 'windows runtime helper ipc request completed', merge_fields(trace_id, {}))

  return true, nil
end

return M
