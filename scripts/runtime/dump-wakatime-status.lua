-- dump-wakatime-status.lua
--
-- Print today's WakaTime summary from the tmux status cache. The cache is
-- written by scripts/runtime/tmux-status-wakatime.sh. This script does not
-- call the WakaTime API and does not read the API key.

local cache = os.getenv('TMUX_STATUS_WAKATIME_CACHE') or '/tmp/.tmux-wakatime-cache'
local file = io.open(cache, 'r')
if not file then
  io.write('{"available":false,"ai":"","code":""}\n')
  os.exit(0)
end

local ai = ''
local code = ''
for line in file:lines() do
  local ai_value = line:match('^AI\t(.*)$')
  local code_value = line:match('^CODE\t(.*)$')
  if ai_value then
    ai = ai_value
  elseif code_value then
    code = code_value
  end
end
file:close()

local function json_escape(value)
  return '"' .. value:gsub('\\', '\\\\'):gsub('"', '\\"') .. '"'
end

io.write('{"available":' .. ((ai ~= '' or code ~= '') and 'true' or 'false'))
io.write(',"ai":' .. json_escape(ai))
io.write(',"code":' .. json_escape(code))
io.write('}\n')
