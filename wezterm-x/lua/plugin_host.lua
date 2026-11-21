-- Plugin host: loads the right-status badges contributed by enabled plugins.
--
-- Reads <runtime_dir>/plugins/registry.generated.lua, produced at sync time by
-- scripts/runtime/render-plugins.sh (never scans directories or parses
-- plugin.json on the 250 ms status tick). For each badge it dofile()s the
-- plugin's Lua module, calls configure(config) with `${runtime_state_dir}` /
-- `${plugin_dir}` expanded, and renders them in `order`.
--
-- Failure isolation: a missing registry, a module that fails to load, or a
-- render error drops that badge (logged once under category `plugins`); the
-- rest of the bar keeps rendering. Docs: docs/plugin-architecture.md

local M = {}

-- constants keys that moved into a plugin's badge.config. A machine-local
-- override still setting one is ignored (the plugin config is the source of
-- truth) and gets a one-time migration warning pointing at local/plugins.json.
local LEGACY_CONSTANT_KEYS = {
  oppo_remote = 'oppo-remote',
  session_bridge_watch = 'session-bridge',
  disk_guard = 'disk-guard',
  mem_guard = 'mem-guard',
  load_guard = 'load-guard',
}

local function expand(value, vars, path_sep)
  if type(value) ~= 'string' or not value:find('${', 1, true) then
    return value
  end
  local out = value:gsub('%${([%w_]+)}', function(name)
    return vars[name]
  end)
  if path_sep ~= '/' then
    out = out:gsub('/', path_sep)
  end
  return out
end

local function contains(list, item)
  if type(list) ~= 'table' or #list == 0 then
    return true
  end
  for _, v in ipairs(list) do
    if v == item then
      return true
    end
  end
  return false
end

-- Exposed for the unit suite.
M.expand = expand

function M.new(opts)
  local self = {
    badges = {},
    warned = {},
    logger = opts.logger,
  }
  local path_sep = opts.path_sep or package.config:sub(1, 1)
  local function join(...)
    return table.concat({ ... }, path_sep)
  end
  local function warn(key, message, fields)
    if self.warned[key] then
      return
    end
    self.warned[key] = true
    if self.logger and self.logger.warn then
      self.logger.warn('plugins', message, fields or {})
    end
  end

  local constants = opts.constants or {}
  for key, plugin_id in pairs(LEGACY_CONSTANT_KEYS) do
    if constants[key] ~= nil then
      warn('legacy:' .. key, 'constants key moved into a plugin; set it in wezterm-x/local/plugins.json instead', {
        legacy_key = key,
        plugin = plugin_id,
        replacement = 'wezterm-x/local/plugins.json → {"config": {"' .. plugin_id .. '": {...}}}',
      })
    end
  end

  -- Badge SDK for plugin modules (`require 'wezdeck.badge'`).
  if not package.loaded['wezdeck.badge'] then
    local sdk_path = opts.sdk_path or join(opts.runtime_dir, 'lua', 'badge_common.lua')
    local sdk_ok, sdk = pcall(dofile, sdk_path)
    if sdk_ok and type(sdk) == 'table' then
      package.loaded['wezdeck.badge'] = sdk
    else
      warn('sdk', 'badge SDK failed to load; plugin badges that need it will be dropped', {
        path = sdk_path,
        error = tostring(sdk),
      })
    end
  end

  local registry_path = opts.registry_path or join(opts.runtime_dir, 'plugins', 'registry.generated.lua')
  local ok, registry = pcall(dofile, registry_path)
  if not ok or type(registry) ~= 'table' then
    warn('registry', 'plugin registry missing or invalid; plugin badges disabled until the next sync', {
      path = registry_path,
      error = tostring(registry),
    })
    registry = { badges = {} }
  end

  for _, spec in ipairs(registry.badges or {}) do
    if contains(spec.requires_host, opts.runtime_mode) then
      local plugin_dir = join(opts.runtime_dir, (tostring(spec.dir):gsub('/', path_sep)))
      local vars = { runtime_state_dir = opts.runtime_state_dir, plugin_dir = plugin_dir }
      local config = {}
      for k, v in pairs(spec.config or {}) do
        config[k] = expand(v, vars, path_sep)
      end
      local module_path = join(plugin_dir, (tostring(spec.module):gsub('/', path_sep)))
      local loaded, mod = pcall(dofile, module_path)
      if loaded and type(mod) == 'table' and type(mod.render_status_segment) == 'function' then
        if type(mod.configure) == 'function' then
          local configured, err = pcall(mod.configure, config)
          if not configured then
            warn('configure:' .. spec.id, 'plugin badge configure failed', { plugin = spec.id, error = tostring(err) })
          end
        end
        table.insert(self.badges, { id = spec.id, order = spec.order, module = mod })
      else
        warn('load:' .. spec.id, 'plugin badge module failed to load', {
          plugin = spec.id,
          path = module_path,
          error = tostring(mod),
        })
      end
    end
  end
  table.sort(self.badges, function(a, b) return (a.order or 0) < (b.order or 0) end)

  -- Rendered segments (strings) in order; failures are skipped.
  function self.render_segments(palette)
    local out = {}
    for _, badge in ipairs(self.badges) do
      local rendered, segment = pcall(badge.module.render_status_segment, palette)
      if not rendered then
        warn('render:' .. badge.id, 'plugin badge render failed', { plugin = badge.id, error = tostring(segment) })
      elseif segment then
        table.insert(out, segment)
      end
    end
    return out
  end

  function self.ids()
    local ids = {}
    for _, badge in ipairs(self.badges) do
      table.insert(ids, badge.id)
    end
    return ids
  end

  return self
end

return M
