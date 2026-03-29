local M = {}

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
    parts[#parts + 1] = string.format('%s=%q', key, stringify(fields[key]))
  end

  return table.concat(parts, ' ')
end

local function append_file(path, line)
  if not path or path == '' then
    return nil
  end

  local file, err = io.open(path, 'a')
  if not file then
    return err
  end

  file:write(line .. '\n')
  file:close()
  return nil
end

function M.new(opts)
  local wezterm = opts.wezterm
  local config = diagnostics_config(opts.constants)
  local enabled = config.enabled == true
  local min_level = level_rank[normalized_level(config.level)]
  local categories = config.categories or {}

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
      '[%s] [%s] [%s] %s%s',
      os.date('%Y-%m-%d %H:%M:%S'),
      string.upper(level),
      category,
      message,
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
      local err = append_file(config.file, line)
      if err then
        wezterm.log_error('Failed to append diagnostics log: ' .. tostring(err))
      end
    end
  end

  return {
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
