-- Minimal JSON decoder for the unit tests. Supports the subset
-- attention.json uses: objects, arrays, strings, numbers, true/false/null.
-- Not a full RFC 8259 implementation; not for production use.

local M = {}

local function skip_ws(s, i)
  while i <= #s do
    local c = s:sub(i, i)
    if c ~= ' ' and c ~= '\t' and c ~= '\n' and c ~= '\r' then return i end
    i = i + 1
  end
  return i
end

local parse_value

local function parse_string(s, i)
  assert(s:sub(i, i) == '"', 'string must start with "')
  i = i + 1
  local buf = {}
  while i <= #s do
    local c = s:sub(i, i)
    if c == '"' then return table.concat(buf), i + 1 end
    if c == '\\' then
      local n = s:sub(i + 1, i + 1)
      if n == '"' then buf[#buf+1] = '"'; i = i + 2
      elseif n == '\\' then buf[#buf+1] = '\\'; i = i + 2
      elseif n == '/' then buf[#buf+1] = '/'; i = i + 2
      elseif n == 'n' then buf[#buf+1] = '\n'; i = i + 2
      elseif n == 't' then buf[#buf+1] = '\t'; i = i + 2
      elseif n == 'r' then buf[#buf+1] = '\r'; i = i + 2
      elseif n == 'u' then
        local hex = s:sub(i + 2, i + 5)
        buf[#buf+1] = string.char(tonumber(hex, 16) % 256)
        i = i + 6
      else error('bad escape \\' .. n) end
    else
      buf[#buf+1] = c
      i = i + 1
    end
  end
  error('unterminated string')
end

local function parse_number(s, i)
  local j = i
  while j <= #s do
    local c = s:sub(j, j)
    if not c:match('[%-0-9%.eE+]') then break end
    j = j + 1
  end
  return tonumber(s:sub(i, j - 1)), j
end

local function parse_array(s, i)
  i = i + 1
  i = skip_ws(s, i)
  local out = {}
  if s:sub(i, i) == ']' then return out, i + 1 end
  while i <= #s do
    local v, j = parse_value(s, i)
    out[#out + 1] = v
    j = skip_ws(s, j)
    local c = s:sub(j, j)
    if c == ',' then i = skip_ws(s, j + 1)
    elseif c == ']' then return out, j + 1
    else error('expected , or ] at ' .. j) end
  end
  error('unterminated array')
end

local function parse_object(s, i)
  i = i + 1
  i = skip_ws(s, i)
  local out = {}
  if s:sub(i, i) == '}' then return out, i + 1 end
  while i <= #s do
    i = skip_ws(s, i)
    local key, j = parse_string(s, i)
    j = skip_ws(s, j)
    assert(s:sub(j, j) == ':', 'expected :')
    j = skip_ws(s, j + 1)
    local v, k = parse_value(s, j)
    out[key] = v
    k = skip_ws(s, k)
    local c = s:sub(k, k)
    if c == ',' then i = skip_ws(s, k + 1)
    elseif c == '}' then return out, k + 1
    else error('expected , or }') end
  end
  error('unterminated object')
end

parse_value = function(s, i)
  i = skip_ws(s, i)
  local c = s:sub(i, i)
  if c == '"' then return parse_string(s, i)
  elseif c == '{' then return parse_object(s, i)
  elseif c == '[' then return parse_array(s, i)
  elseif c == 't' and s:sub(i, i + 3) == 'true' then return true, i + 4
  elseif c == 'f' and s:sub(i, i + 4) == 'false' then return false, i + 5
  elseif c == 'n' and s:sub(i, i + 3) == 'null' then return nil, i + 4
  elseif c:match('[%-0-9]') then return parse_number(s, i)
  else error('unexpected char ' .. c .. ' at ' .. i) end
end

function M.decode(s)
  if type(s) ~= 'string' or s == '' then return nil end
  local v = parse_value(s, 1)
  return v
end

return M
