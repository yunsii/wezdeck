-- Shared helpers for right-status badge plugins (`require 'wezdeck.badge'`).
--
-- plugin_host registers this module as package.loaded['wezdeck.badge']
-- before loading any plugin badge, so built-in and machine plugins share one
-- implementation of the status.json read / parse / clock plumbing that every
-- badge used to copy. Docs: docs/plugin-architecture.md

local wezterm = require 'wezterm'

local M = {}

function M.parse_json(text)
  if type(text) ~= 'string' or text == '' then
    return nil
  end
  if wezterm.json_parse then
    local ok, parsed = pcall(wezterm.json_parse, text)
    if ok then
      return parsed
    end
  end
  if wezterm.serde and wezterm.serde.json_decode then
    local ok, parsed = pcall(wezterm.serde.json_decode, text)
    if ok then
      return parsed
    end
  end
  return nil
end

function M.read_file(path)
  local f = io.open(path, 'r')
  if not f then
    return nil
  end
  local content = f:read('*a')
  f:close()
  return content
end

function M.current_epoch_ms()
  local ok, formatted = pcall(function()
    return wezterm.time.now():format '%s%3f'
  end)
  if ok and type(formatted) == 'string' and formatted:match '^%d+$' then
    return tonumber(formatted)
  end
  return math.floor(os.time() * 1000)
end

return M
