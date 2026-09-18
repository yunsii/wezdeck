-- WezDeck PoC: count Rime commit (上屏) characters without logging text.
-- Privacy: writes only {ts, chars, source} JSONL lines — never the commit string.
--
-- Wire via schema custom.yaml:
--   engine/processors/@before 0: lua_processor@*wezdeck_commit_counter
--
-- Log path (first match):
--   1) WEZDECK_RIME_COMMIT_LOG
--   2) %LOCALAPPDATA%\wezterm-runtime\state\rime-commits.jsonl

local M = {}

local function utf8_len(s)
  if utf8 and utf8.len then
    return utf8.len(s) or 0
  end
  local _, n = s:gsub("[^\128-\191]", "")
  return n
end

local function iso_now()
  return os.date("!%Y-%m-%dT%H:%M:%SZ")
end

local function resolve_log_path()
  local env_path = os.getenv("WEZDECK_RIME_COMMIT_LOG")
  if env_path and env_path ~= "" then
    return env_path
  end
  local localapp = os.getenv("LOCALAPPDATA")
  if localapp and localapp ~= "" then
    return localapp .. "\\wezterm-runtime\\state\\rime-commits.jsonl"
  end
  return nil
end

local function append_line(path, chars)
  if not path or chars <= 0 then
    return
  end
  local f = io.open(path, "a")
  if not f then
    return
  end
  -- Hand-built JSON: no user text, no process names here (joined offline).
  f:write(string.format('{"ts":"%s","chars":%d,"source":"rime_commit"}\n', iso_now(), chars))
  f:close()
end

function M.init(env)
  env._wezdeck_commit_log = resolve_log_path()
  local ctx = env.engine.context
  env._wezdeck_commit_conn = ctx.commit_notifier:connect(function(c)
    local text = c:get_commit_text()
    if not text or text == "" then
      return
    end
    append_line(env._wezdeck_commit_log, utf8_len(text))
  end)
end

function M.fini(env)
  if env._wezdeck_commit_conn then
    env._wezdeck_commit_conn:disconnect()
    env._wezdeck_commit_conn = nil
  end
end

function M.func(_key, _env)
  return 2 -- kNoop: never consume keys
end

return M
