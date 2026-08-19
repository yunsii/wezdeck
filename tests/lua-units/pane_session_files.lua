-- Helper for suites that exercise the on-disk tier of the unified
-- pane→session map (`<state>/pane-session/<pane_id>.txt`, written by
-- open-project-session.sh).
--
-- tab_visibility resolves that directory from env whenever no stats_dir
-- is configured — and attention.lua reaches tab_visibility through
-- dofile, i.e. a *different* module instance than the test's `require`,
-- so calling configure() on the required one cannot redirect it. The
-- runner (scripts/dev/test-lua-units.sh) therefore points
-- XDG_STATE_HOME at a throwaway dir and clears LOCALAPPDATA. Refuse to
-- run without that sandbox rather than reading — and deleting — files
-- under the user's real wezterm-runtime state.

local M = {}

function M.dir()
  if os.getenv('LOCALAPPDATA') then
    error('LOCALAPPDATA is set; it would redirect pane-session lookups to the '
      .. 'real Windows runtime state. Run via scripts/dev/test-lua-units.sh', 2)
  end
  local xdg = os.getenv('XDG_STATE_HOME')
  if not xdg or xdg == '' then
    error('XDG_STATE_HOME unset; refusing to touch the real state dir. '
      .. 'Run via scripts/dev/test-lua-units.sh', 2)
  end
  return xdg .. '/wezterm-runtime/state/pane-session'
end

local function path_for(pane_id)
  return M.dir() .. '/' .. tostring(pane_id) .. '.txt'
end

-- Plant the leftover a recycled pane id inherits from its previous
-- occupant.
function M.write(pane_id, session_name)
  os.execute('mkdir -p ' .. M.dir())
  local fd = assert(io.open(path_for(pane_id), 'w'))
  fd:write(session_name .. '\n')
  fd:close()
end

function M.exists(pane_id)
  local fd = io.open(path_for(pane_id), 'r')
  if not fd then return false end
  fd:close()
  return true
end

function M.clear()
  os.execute('rm -rf ' .. M.dir())
end

return M
