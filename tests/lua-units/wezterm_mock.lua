-- Minimal stand-in for the global `wezterm` table that attention.lua /
-- tab_visibility.lua import via `require 'wezterm'`. Tests configure a
-- small fake-mux state through M.set_mux, then call into the modules
-- under test the same way the wezterm runtime would.
--
-- Only the surface that production code actually touches is implemented
-- here. Anything not listed will throw on access — keeps tests honest
-- about what wezterm symbols the modules really depend on.

local M = {}

-- ── Mux ────────────────────────────────────────────────────────────────
-- Fake panes / tabs / windows. Each pane is { id = N, get_title = fn,
-- pane_id = fn, set_user_var = fn (no-op), get_user_var = fn }.
local mux_state = { windows = {} }

local function make_pane(spec)
  local pane = {
    id = spec.id,
    user_vars = spec.user_vars or {},
    title = spec.title or '',
  }
  function pane:pane_id() return self.id end
  function pane:get_title() return self.title end
  function pane:set_user_var(name, value) self.user_vars[name] = value end
  function pane:get_user_var(name) return self.user_vars[name] end
  function pane:activate() end
  return pane
end

local function make_tab(spec)
  local active_pane = make_pane(spec.active_pane or { id = spec.id })
  local tab = {
    id = spec.id,
    title = spec.title or '',
    active_pane_obj = active_pane,
    panes = { active_pane },
  }
  if spec.extra_panes then
    for _, p in ipairs(spec.extra_panes) do
      table.insert(tab.panes, make_pane(p))
    end
  end
  function tab:get_title() return self.title end
  function tab:active_pane() return self.active_pane_obj end
  function tab:panes_with_info()
    local out = {}
    for _, p in ipairs(self.panes) do
      table.insert(out, { pane = p, is_active = p == self.active_pane_obj })
    end
    return out
  end
  function tab:activate() end
  return tab
end

local function make_window(spec)
  local tabs = {}
  for _, t in ipairs(spec.tabs or {}) do
    table.insert(tabs, make_tab(t))
  end
  local win = {
    workspace = spec.workspace or 'default',
    tabs_list = tabs,
  }
  function win:get_workspace() return self.workspace end
  function win:tabs() return self.tabs_list end
  return win
end

function M.set_mux(spec)
  mux_state.windows = {}
  for _, w in ipairs(spec.windows or {}) do
    table.insert(mux_state.windows, make_window(w))
  end
end

function M.reset_mux()
  mux_state.windows = {}
end

M.mux = {
  all_windows = function() return mux_state.windows end,
}

-- ── Time / serde / json — production code uses the pcall-wrapped paths
M.time = {
  now = function()
    return setmetatable({}, {
      __index = function() return function() return tostring(os.time()) end end,
    })
  end,
}

M.serde = {
  json_encode = function(v)
    -- Tiny encoder good enough for the snapshot test (no nested arrays
    -- besides strings/numbers/tables of strings/numbers).
    local function enc(x)
      if type(x) == 'string' then
        return '"' .. x:gsub('\\', '\\\\'):gsub('"', '\\"') .. '"'
      elseif type(x) == 'number' or type(x) == 'boolean' then
        return tostring(x)
      elseif type(x) == 'table' then
        -- Detect array vs object.
        local n = 0
        for k, _ in pairs(x) do
          n = n + 1
          if type(k) ~= 'number' then n = -1; break end
        end
        if n > 0 then
          local parts = {}
          for _, v in ipairs(x) do parts[#parts + 1] = enc(v) end
          return '[' .. table.concat(parts, ',') .. ']'
        else
          local parts = {}
          local keys = {}
          for k, _ in pairs(x) do keys[#keys + 1] = k end
          table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
          for _, k in ipairs(keys) do
            parts[#parts + 1] = '"' .. tostring(k) .. '":' .. enc(x[k])
          end
          return '{' .. table.concat(parts, ',') .. '}'
        end
      else
        return 'null'
      end
    end
    return enc(v)
  end,
  json_decode = function(s)
    return require('json_mini').decode(s)
  end,
}

function M.json_parse(s)
  return require('json_mini').decode(s)
end

M.action = setmetatable({}, {
  __index = function(_, k) return function(arg) return { _action = k, _arg = arg } end end,
})

function M.format(parts) return parts end

function M.background_child_process() end

function M.read_dir(path)
  return {}
end

return M
