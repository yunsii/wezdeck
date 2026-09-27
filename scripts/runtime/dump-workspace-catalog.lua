-- dump-workspace-catalog.lua
--
-- Print the merged workspace catalog as one JSON object. Loads the same
-- wezterm-x/workspaces.lua merge WezTerm uses (public baseline, then a
-- whole-table local override per name). Invoked by the Windows Runtime
-- through WSL lua5.4 with the unit-test wezterm mock. Does not embed Lua
-- in the .NET process and does not call wezterm.exe.
--
-- stdout: {"available":true,"workspaces":[{"name":"...","items":[...]}]}
-- A defined workspace with no cwd items is included with "items":[].

local function die(msg)
  io.stderr:write('dump-workspace-catalog.lua: ' .. msg .. '\n')
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

local config_dir = os.getenv('WORKSPACE_CATALOG_CONFIG_DIR')
if not config_dir or config_dir == '' then
  die('WORKSPACE_CATALOG_CONFIG_DIR is required (parent of the runtime dir)')
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
if type(mock.log_warn) ~= 'function' then
  function mock.log_warn() end
end
-- constants.lua builds fonts while resolving main_repo_root. The catalog
-- only needs the workspace table, so these stubs keep that load off the
-- real wezterm font API.
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
if type(workspaces) ~= 'table' then
  die('workspaces.lua did not return a table')
end

local function json_escape(value)
  return '"' .. value:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\n', '\\n'):gsub('\r', '\\r') .. '"'
end

local function leaf_name(cwd)
  local trimmed = cwd:gsub('/+$', '')
  return trimmed:match('([^/]+)$') or trimmed
end

local function shell_quote(value)
  return "'" .. value:gsub("'", "'\\''") .. "'"
end

local function run(command)
  local handle = io.popen(command)
  if not handle then
    return ''
  end
  local output = handle:read('*a') or ''
  handle:close()
  return output
end

local function git_worktrees(cwd)
  local output = run('git -C ' .. shell_quote(cwd) .. ' worktree list --porcelain 2>/dev/null')
  local trees = {}
  local current = nil
  local main_root = nil
  local function finish()
    if not current or not current.path or current.path == '' then
      current = nil
      return
    end
    if not main_root then
      main_root = current.path
    end
    current.kind = current.path == main_root and 'primary' or 'linked'
    current.name = current.kind == 'primary' and 'primary' or leaf_name(current.path)
    trees[#trees + 1] = current
    current = nil
  end
  for line in (output .. '\n'):gmatch('(.-)\n') do
    if line:sub(1, 9) == 'worktree ' then
      finish()
      current = { path = line:sub(10), branch = '', head = '' }
    elseif current and line:sub(1, 6) == 'branch' then
      current.branch = line:match('refs/heads/(.+)$') or line:gsub('^branch ', '')
    elseif current and line:sub(1, 5) == 'HEAD ' then
      current.head = line:sub(6)
    elseif line == '' then
      finish()
    end
  end
  finish()
  if #trees == 0 then
    trees[1] = {
      path = cwd,
      branch = '',
      head = '',
      kind = 'primary',
      name = leaf_name(cwd),
    }
  end
  return trees
end

local function json_unescape(value)
  return value:gsub('\\/', '/'):gsub('\\"', '"'):gsub('\\\\', '\\')
end

-- access-ledger.json is one object with sessions{} and worktrees{}. No Lua
-- JSON module is installed, and the schema only needs these two maps.
local function load_ledger()
  local ledger = { sessions = {}, worktrees = {} }
  local home = os.getenv('HOME') or ''
  if home == '' then
    return ledger
  end
  local path = home .. '/.local/state/wezterm-runtime/state/access-ledger.json'
  local file = io.open(path, 'r')
  if not file then
    return ledger
  end
  local body = file:read('*a')
  file:close()

  local function take_object(section_name, assign)
    local marker = '"' .. section_name .. '"'
    local at = body:find(marker, 1, true)
    if not at then
      return
    end
    local start = body:find('{', at, true)
    if not start then
      return
    end
    local depth = 0
    local index = start
    while index <= #body do
      local char = body:sub(index, index)
      if char == '{' then
        depth = depth + 1
      elseif char == '}' then
        depth = depth - 1
        if depth == 0 then
          break
        end
      elseif char == '"' and depth == 1 then
        local key = body:match('^"([^"]+)"%s*:%s*{', index)
        if key then
          local object_at = body:find('{', index, true)
          local object_end = object_at and body:find('}', object_at, true)
          if object_at and object_end then
            assign(json_unescape(key), body:sub(object_at, object_end))
            index = object_end
          end
        end
      end
      index = index + 1
    end
  end

  take_object('sessions', function(key, object)
    ledger.sessions[key] = {
      last_path = json_unescape(object:match('"last_path"%s*:%s*"([^"]*)"') or ''),
      last_access_ms = tonumber(object:match('"last_access_ms"%s*:%s*(%d+)')) or 0,
    }
  end)
  take_object('worktrees', function(key, object)
    ledger.worktrees[key] = tonumber(object:match('"last_access_ms"%s*:%s*(%d+)')) or 0
  end)
  return ledger
end

local ledger = load_ledger()

local function worktree_ms(path)
  local entry = ledger.worktrees[path]
  if type(entry) == 'table' then
    return tonumber(entry.last_access_ms) or 0
  end
  return tonumber(entry) or 0
end

local function session_for_repo(repo_name)
  local best_ms = -1
  local best = nil
  for _, session in pairs(ledger.sessions) do
    if type(session) == 'table' and type(session.last_path) == 'string' then
      if leaf_name(session.last_path) == repo_name or session.last_path:find('/' .. repo_name .. '/', 1, true) or session.last_path:find('/' .. repo_name .. '$') then
        local ms = tonumber(session.last_access_ms) or 0
        if ms > best_ms then
          best_ms = ms
          best = session
        end
      end
    end
  end
  return best
end

local names = {}
for name, def in pairs(workspaces) do
  if type(name) == 'string' and type(def) == 'table' then
    names[#names + 1] = name
  end
end
table.sort(names)

local selection_ms = -1
local selection = { workspace = '', repo = '', worktree = '' }

local function consider(workspace_name, repo_name, path, ms)
  if ms > selection_ms then
    selection_ms = ms
    selection.workspace = workspace_name
    selection.repo = repo_name
    selection.worktree = path
  end
end

local chunks = { '{"available":true,"workspaces":[' }
for index, name in ipairs(names) do
  if index > 1 then
    chunks[#chunks + 1] = ','
  end
  chunks[#chunks + 1] = '{"name":' .. json_escape(name) .. ',"items":['
  local def = workspaces[name]
  local items = def.items or {}
  local emitted = 0
  if type(items) == 'table' then
    for _, item in ipairs(items) do
      if type(item) == 'table' and type(item.cwd) == 'string' and item.cwd ~= '' then
        if emitted > 0 then
          chunks[#chunks + 1] = ','
        end
        emitted = emitted + 1
        local item_name = type(item.name) == 'string' and item.name ~= '' and item.name or leaf_name(item.cwd)
        local remembered = session_for_repo(item_name)
        local remembered_path = remembered and remembered.last_path or ''
        local trees = git_worktrees(item.cwd)
        local seen = false
        chunks[#chunks + 1] = '{"cwd":' .. json_escape(item.cwd)
          .. ',"name":' .. json_escape(item_name)
          .. ',"worktrees":['
        for tree_index, tree in ipairs(trees) do
          if tree_index > 1 then
            chunks[#chunks + 1] = ','
          end
          if tree.path == remembered_path then
            seen = true
          end
          consider(name, item_name, tree.path, worktree_ms(tree.path))
          chunks[#chunks + 1] = '{"path":' .. json_escape(tree.path)
            .. ',"name":' .. json_escape(tree.name)
            .. ',"branch":' .. json_escape(tree.branch)
            .. ',"kind":' .. json_escape(tree.kind)
            .. '}'
        end
        if remembered_path ~= '' and not seen then
          consider(name, item_name, remembered_path, tonumber(remembered.last_access_ms) or 0)
        end
        chunks[#chunks + 1] = ']}'
      end
    end
  end
  chunks[#chunks + 1] = ']}'
end
chunks[#chunks + 1] = '],"selection":{"workspace":' .. json_escape(selection.workspace)
  .. ',"repo":' .. json_escape(selection.repo)
  .. ',"worktree":' .. json_escape(selection.worktree)
  .. '}}'
io.write(table.concat(chunks))
io.write('\n')
