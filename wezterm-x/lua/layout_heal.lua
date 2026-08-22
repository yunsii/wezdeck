-- Auto layout heal after font zoom / window resize (RDP, DPI, Ctrl+/-).
-- Spawns scripts/runtime/tmux-fix-layout.sh with debounce so a burst of
-- resize events (holding Ctrl+-) collapses to one heal after the grid
-- settles. Manual Ctrl+k r still works for on-demand fixes.

local M = {}

local state = {
  wezterm = nil,
  constants = nil,
  logger = nil,
  generation = 0,
  debounce_s = 0.2,
  min_interval_ms = 500,
  last_spawn_ms = 0,
}

local function now_ms()
  local wezterm = state.wezterm
  if not wezterm or not wezterm.time or not wezterm.time.now then
    return 0
  end
  local ok, formatted = pcall(function()
    return wezterm.time.now():format '%s%3f'
  end)
  if not ok or type(formatted) ~= 'string' then return 0 end
  return tonumber(formatted) or 0
end

local function resolve_script()
  local constants = state.constants
  if not constants then return nil end
  local root = constants.repo_root
  if type(root) ~= 'string' or root == '' then return nil end
  return root .. '/scripts/runtime/tmux-fix-layout.sh'
end

local function resolve_distro(pane)
  local constants = state.constants
  local domain = ''
  if pane and pane.get_domain_name then
    local ok, name = pcall(function() return pane:get_domain_name() end)
    if ok and type(name) == 'string' then domain = name end
  end
  if domain == '' and constants and type(constants.default_domain) == 'string' then
    domain = constants.default_domain
  end
  return domain:match('^WSL:(.+)$')
end

local function spawn_fix(pane)
  local wezterm = state.wezterm
  local logger = state.logger
  if not wezterm then return end

  local t = now_ms()
  if state.min_interval_ms > 0 and state.last_spawn_ms > 0
      and (t - state.last_spawn_ms) < state.min_interval_ms then
    return
  end

  local script = resolve_script()
  if not script then return end

  local args
  local runtime_mode = (state.constants and state.constants.runtime_mode) or 'hybrid-wsl'
  -- --quiet: auto path must not toast "fix failed" on WezTerm cold
  -- start when window-resized fires before any tmux client exists.
  if runtime_mode == 'hybrid-wsl' and state.constants and state.constants.host_os == 'windows' then
    local distro = resolve_distro(pane)
    if not distro then return end
    args = { 'wsl.exe', '-d', distro, '--', 'bash', script, '--quiet' }
  else
    args = { 'bash', script, '--quiet' }
  end

  state.last_spawn_ms = t
  local ok, err = pcall(wezterm.background_child_process, args)
  if not ok and logger and logger.warn then
    logger.warn('layout', 'auto fix-layout spawn failed', { err = tostring(err) })
  elseif logger and logger.info then
    logger.info('layout', 'auto fix-layout scheduled', {})
  end
end

-- Debounce: every trigger bumps generation; only the latest fires.
function M.schedule(pane)
  local wezterm = state.wezterm
  if not wezterm or not wezterm.time or not wezterm.time.call_after then
    spawn_fix(pane)
    return
  end
  state.generation = state.generation + 1
  local gen = state.generation
  local pane_ref = pane
  wezterm.time.call_after(state.debounce_s, function()
    if gen ~= state.generation then return end
    spawn_fix(pane_ref)
  end)
end

function M.register(opts)
  opts = opts or {}
  state.wezterm = opts.wezterm
  state.constants = opts.constants
  state.logger = opts.logger
  if type(opts.debounce_s) == 'number' and opts.debounce_s > 0 then
    state.debounce_s = opts.debounce_s
  end
  if type(opts.min_interval_ms) == 'number' and opts.min_interval_ms >= 0 then
    state.min_interval_ms = opts.min_interval_ms
  end

  local wezterm = state.wezterm
  if not wezterm then return end

  wezterm.on('window-resized', function(window, pane)
    M.schedule(pane)
  end)
end

-- Font-size key handler: apply the built-in assignment, then schedule heal.
-- Covers cases where font zoom changes cell grid without a window-resized.
function M.font_size_handler(kind)
  local wezterm = state.wezterm
  return function()
    return wezterm.action_callback(function(window, pane)
      local action
      if kind == 'increase' then
        action = wezterm.action.IncreaseFontSize
      elseif kind == 'decrease' then
        action = wezterm.action.DecreaseFontSize
      else
        action = wezterm.action.ResetFontSize
      end
      window:perform_action(action, pane)
      M.schedule(pane)
    end)
  end
end

return M
