-- dump-workspace-agent-map.lua
--
-- Emit a TSV of cwd → managed agent base profile by loading the same
-- wezterm-x/workspaces.lua merge (public baseline ∪ local override) that
-- WezTerm uses at runtime. Invoked by render-workspace-agent-map.sh under
-- lua5.4 with a minimal wezterm mock; does not need wezterm.exe.
--
-- Output columns (stdout):
--   cwd<TAB>base_profile
-- where base_profile has any trailing `_resume` / `-resume` stripped so
-- shell-side resume-command.sh can re-derive the resume variant.
--
-- Rows are skipped when the item has a raw `command` (bypasses managed
-- launcher) or when no launcher resolves after defaults merge.

local function die(msg)
  io.stderr:write('dump-workspace-agent-map.lua: ' .. msg .. '\n')
  os.exit(1)
end

local repo_root = os.getenv('WEZTERM_CONFIG_REPO') or os.getenv('WEZDECK_REPO')
if not repo_root or repo_root == '' then
  die('WEZTERM_CONFIG_REPO is required')
end

local runtime_dir = os.getenv('WEZTERM_RUNTIME_DIR')
if not runtime_dir or runtime_dir == '' then
  die('WEZTERM_RUNTIME_DIR is required')
end

local config_dir = os.getenv('WORKSPACE_AGENT_MAP_CONFIG_DIR')
if not config_dir or config_dir == '' then
  die('WORKSPACE_AGENT_MAP_CONFIG_DIR is required (parent of .wezterm-x symlink)')
end

local mock_path = os.getenv('WEZTERM_MOCK_PATH')
if not mock_path or mock_path == '' then
  mock_path = repo_root .. '/tests/lua-units/?.lua'
end

package.path = mock_path .. ';' .. package.path

local ok_mock, mock = pcall(require, 'wezterm_mock')
if not ok_mock then
  die('failed to load wezterm_mock: ' .. tostring(mock))
end

mock.config_dir = config_dir
mock.target_triple = mock.target_triple or 'x86_64-unknown-linux-gnu'
if type(mock.font_with_fallback) ~= 'function' then
  function mock.font_with_fallback(fonts)
    return fonts
  end
end
if type(mock.font) ~= 'function' then
  function mock.font(spec)
    return spec
  end
end

package.preload['wezterm'] = function()
  return mock
end

_G.WEZTERM_RUNTIME_DIR = runtime_dir

local workspaces_path = runtime_dir .. '/workspaces.lua'
local ok_ws, workspaces = pcall(dofile, workspaces_path)
if not ok_ws then
  die('failed to load ' .. workspaces_path .. ': ' .. tostring(workspaces))
end

local function strip_resume_suffix(name)
  if not name or name == '' then
    return nil
  end
  local base = name:gsub('_resume$', ''):gsub('%-resume$', '')
  if base == '' then
    return nil
  end
  return base
end

-- Stable output: sort by cwd so sync diffs stay small.
local rows = {}

for _, def in pairs(workspaces) do
  if type(def) == 'table' then
    local defaults = def.defaults or {}
    local items = def.items or def
    if type(items) == 'table' then
      for _, item in ipairs(items) do
        if type(item) == 'table' and type(item.cwd) == 'string' and item.cwd ~= '' then
          -- Raw command overrides bypass the managed launcher entirely
          -- (same rule as wezterm-x/lua/workspace/runtime.lua).
          if item.command == nil then
            local launcher = item.launcher or defaults.launcher
            local base = strip_resume_suffix(launcher)
            if base then
              rows[#rows + 1] = { cwd = item.cwd, profile = base }
            end
          end
        end
      end
    end
  end
end

table.sort(rows, function(a, b)
  if a.cwd == b.cwd then
    return a.profile < b.profile
  end
  return a.cwd < b.cwd
end)

-- Deduplicate exact cwd keys; last writer in sorted order wins only on
-- profile tie-break above. Prefer the first occurrence after sort so a
-- stable cwd always maps to one profile.
local seen = {}
for _, row in ipairs(rows) do
  if not seen[row.cwd] then
    seen[row.cwd] = true
    io.write(row.cwd .. '\t' .. row.profile .. '\n')
  end
end
