local M = {}
local trace_counter = 0
local trace_seeded = false

local level_rank = {
  error = 1,
  warn = 2,
  info = 3,
  debug = 4,
}

local function normalized_level(level)
  if level_rank[level] then
    return level
  end

  return 'info'
end

local function diagnostics_config(constants)
  local diagnostics = constants and constants.diagnostics or {}
  return diagnostics.wezterm or {}
end

local function category_enabled(categories, category)
  if not categories or next(categories) == nil then
    return true
  end

  return categories[category] == true
end

local function stringify(value)
  if value == nil then
    return 'nil'
  end

  if type(value) == 'string' then
    return value
  end

  return tostring(value)
end

local function escaped_value(value)
  local text = stringify(value)
  text = text:gsub('\\', '\\\\')
  text = text:gsub('"', '\\"')
  text = text:gsub('\n', '\\n')
  text = text:gsub('\r', '\\r')
  text = text:gsub('\t', '\\t')
  return '"' .. text .. '"'
end

local function formatted_fields(fields)
  if not fields or next(fields) == nil then
    return nil
  end

  local keys = {}
  for key in pairs(fields) do
    keys[#keys + 1] = key
  end
  table.sort(keys)

  local parts = {}
  for _, key in ipairs(keys) do
    parts[#parts + 1] = string.format('%s=%s', key, escaped_value(fields[key]))
  end

  return table.concat(parts, ' ')
end

local function file_size(path)
  local file = io.open(path, 'r')
  if not file then
    return 0
  end

  local size = file:seek('end') or 0
  file:close()
  return size
end

local function rotate_file(path, max_files)
  if max_files <= 0 then
    return
  end

  os.remove(path .. '.' .. max_files)
  for index = max_files - 1, 1, -1 do
    os.rename(path .. '.' .. index, path .. '.' .. (index + 1))
  end
  os.rename(path, path .. '.1')
end

local function rotate_if_needed(path, max_bytes, max_files)
  if not path or path == '' or not max_bytes or max_bytes <= 0 or not max_files or max_files <= 0 then
    return
  end

  if file_size(path) >= max_bytes then
    rotate_file(path, max_files)
  end
end

local function append_file(path, line, max_bytes, max_files)
  if not path or path == '' then
    return nil
  end

  rotate_if_needed(path, tonumber(max_bytes), tonumber(max_files))

  local file, err = io.open(path, 'a')
  if not file then
    return err
  end

  file:write(line .. '\n')
  file:close()
  return nil
end

local function ensure_trace_seed()
  if trace_seeded then
    return
  end

  math.randomseed(os.time())
  trace_seeded = true
end

local function next_trace_id(prefix)
  ensure_trace_seed()
  trace_counter = trace_counter + 1
  local effective_prefix = prefix or 'wezterm'
  return string.format('%s-%s-%04d-%04d', effective_prefix, os.date('%Y%m%d%H%M%S'), trace_counter, math.random(0, 9999))
end

function M.new(opts)
  local wezterm = opts.wezterm
  local config = diagnostics_config(opts.constants)
  local enabled = config.enabled == true
  local min_level = level_rank[normalized_level(config.level)]
  local categories = config.categories or {}
  local log_file = config.file
  local source_name = config.source or 'wezterm'
  local max_bytes = config.max_bytes or 0
  local max_files = config.max_files or 0

  local function should_capture(level, category)
    if not enabled then
      return false
    end

    if level_rank[level] > min_level then
      return false
    end

    return category_enabled(categories, category)
  end

  local function emit(level, category, message, fields)
    local capture = should_capture(level, category)
    local field_text = formatted_fields(fields)
    local line = string.format(
      'ts=%s level=%s source=%s category=%s message=%s%s',
      escaped_value(os.date('%Y-%m-%d %H:%M:%S')),
      escaped_value(level),
      escaped_value(source_name),
      escaped_value(category),
      escaped_value(message),
      field_text and (' ' .. field_text) or ''
    )

    if level == 'error' then
      wezterm.log_error(line)
    elseif level == 'warn' then
      wezterm.log_info(line)
    elseif capture then
      wezterm.log_info(line)
    end

    if capture then
      local err = append_file(log_file, line, max_bytes, max_files)
      if err then
        wezterm.log_error('Failed to append diagnostics log: ' .. tostring(err))
      end
    end
  end

  return {
    trace_id = function(prefix)
      return next_trace_id(prefix)
    end,
    debug = function(category, message, fields)
      emit('debug', category, message, fields)
    end,
    info = function(category, message, fields)
      emit('info', category, message, fields)
    end,
    warn = function(category, message, fields)
      emit('warn', category, message, fields)
    end,
    error = function(category, message, fields)
      emit('error', category, message, fields)
    end,
  }
end

return M
