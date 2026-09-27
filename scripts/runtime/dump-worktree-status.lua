-- dump-worktree-status.lua
--
-- Print one worktree's local status as JSON. Reads the same signals the
-- tmux status line shows for a pane: git status --porcelain=v2 --branch and
-- the cached Node version. Does not call WakaTime; that summary is global
-- and lives in dump-wakatime-status.lua.

local function die(msg)
  io.stderr:write('dump-worktree-status.lua: ' .. msg .. '\n')
  os.exit(1)
end

local path = arg[1]
if not path or path == '' then
  die('worktree path is required')
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

local function json_escape(value)
  return '"' .. value:gsub('\\', '\\\\'):gsub('"', '\\"') .. '"'
end

local output = run('git -C ' .. shell_quote(path) .. ' status --porcelain=v2 --branch 2>/dev/null')
local branch = ''
local staged, unstaged, untracked, ahead, behind = 0, 0, 0, 0, 0
local upstream = false
for line in output:gmatch('[^\n]+') do
  local head = line:match('^# branch%.head (.+)$')
  local ahead_count = line:match('^# branch%.ab %+(%d+)')
  local behind_count = line:match('^# branch%.ab %+%d+%s+%-(%d+)')
  if head then
    branch = head
  elseif line:match('^# branch%.upstream ') then
    upstream = true
  elseif ahead_count then
    ahead = tonumber(ahead_count) or 0
    behind = tonumber(behind_count) or 0
  elseif line:sub(1, 1) == '1' or line:sub(1, 1) == '2' then
    local xy = line:sub(3, 4)
    if xy:sub(1, 1) ~= '.' and xy:sub(1, 1) ~= ' ' then
      staged = staged + 1
    end
    if xy:sub(2, 2) ~= '.' and xy:sub(2, 2) ~= ' ' then
      unstaged = unstaged + 1
    end
  elseif line:sub(1, 2) == '? ' then
    untracked = untracked + 1
  end
end

local node_version = ''
local cache = os.getenv('TMUX_STATUS_NODE_CACHE') or '/tmp/.tmux-status-node-cache'
local cache_file = io.open(cache, 'r')
if cache_file then
  cache_file:read('*l')
  cache_file:read('*l')
  node_version = cache_file:read('*l') or ''
  cache_file:close()
end
if node_version == '' or node_version == '__missing__' then
  node_version = (run('node -v 2>/dev/null'):gsub('%s+$', ''))
end

local changes = string.format('(+%d,~%d,?%d', staged, unstaged, untracked)
if upstream then
  if ahead ~= 0 then
    changes = changes .. ',^' .. ahead
  end
  if behind ~= 0 then
    changes = changes .. ',v' .. behind
  end
  if ahead == 0 and behind == 0 then
    changes = changes .. ',=0'
  end
else
  changes = changes .. ',*0'
end
changes = changes .. ')'

io.write('{"available":true')
io.write(',"branch":' .. json_escape(branch))
io.write(',"git_changes":' .. json_escape(changes))
io.write(',"node_version":' .. json_escape(node_version))
io.write('}\n')
