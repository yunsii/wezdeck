-- Tests for the right-status counter glyphs (`▲ 2 waiting` …).
--
-- The set is configurable from wezterm-x/local/constants.lua, so the
-- interesting cases are the degradations: a machine that types a number
-- into the override must not get `nil` painted into the status bar, and
-- a machine that empties a glyph must not get a double space where the
-- glyph used to be.

package.path = './tests/lua-units/?.lua;./wezterm-x/lua/?.lua;./wezterm-x/lua/ui/?.lua;' .. package.path

local mock = require 'wezterm_mock'
package.preload['wezterm'] = function() return mock end
_G.WEZTERM_RUNTIME_DIR = './wezterm-x'

local attention = require 'attention'

local fail_count, pass_count = 0, 0
local function describe(n, fn) io.write('▸ ' .. n .. '\n') fn() end
local function it(n, fn)
  local ok, err = pcall(fn)
  if ok then pass_count = pass_count + 1 io.write('  ✓ ' .. n .. '\n')
  else fail_count = fail_count + 1 io.write('  ✗ ' .. n .. '\n    ' .. tostring(err) .. '\n') end
end
local function assert_eq(a, b, m)
  if a ~= b then error((m or '') .. ' expected=' .. tostring(b) .. ' actual=' .. tostring(a), 2) end
end

local PALETTE = {
  tab_bar_background = '#000000',
  new_tab_fg = '#888888',
  tab_attention_waiting_bg = '#d1a477',
  tab_attention_waiting_fg = '#2c1f12',
  tab_attention_waiting_glyph = '#6f4100',
  tab_attention_done_bg = '#93bb8b',
  tab_attention_done_fg = '#1a2517',
  tab_attention_done_glyph = '#225c13',
  tab_attention_running_bg = '#89b2e0',
  tab_attention_running_fg = '#172330',
  tab_attention_running_glyph = '#094e8c',
}

-- Walks the format-parts list and returns the Foreground in effect for
-- the run that carries `needle`. This is what the split-glyph rendering
-- is for, so the tests assert on it rather than on part indices.
local function color_of(needle, palette)
  local parts = attention.render_status_segment(palette or PALETTE, {})
  local current = nil
  for _, part in ipairs(parts) do
    if part.Foreground then current = part.Foreground.Color end
    if part.Text and part.Text:find(needle, 1, true) then return current end
  end
  return nil
end

-- mock wezterm.format returns the parts table untouched, so the rendered
-- segment is readable as the concatenation of its Text runs.
local function rendered()
  local parts = attention.render_status_segment(PALETTE, {})
  local out = {}
  for _, part in ipairs(parts) do
    if part.Text then table.insert(out, part.Text) end
  end
  return table.concat(out)
end

-- configure_icons only ever overwrites keys it accepts, so every case
-- has to restore the shipped set instead of relying on module load order.
local function reset_icons()
  attention.configure_icons { waiting = '▲', done = '✓', running = '●' }
end

-- ── tests ──────────────────────────────────────────────────────────────

describe('right-status counter glyphs', function()
  it('renders the default set with all three counters at zero', function()
    reset_icons()
    assert_eq(rendered(), ' ▲ 0 waiting   ✓ 0 done   ● 0 running ',
      'default zero-state segment')
  end)

  it('applies a local override for a single status', function()
    reset_icons()
    attention.configure_icons { waiting = '!' }
    assert_eq(rendered(), ' ! 0 waiting   ✓ 0 done   ● 0 running ',
      'waiting glyph override did not land')
  end)

  it('drops the glyph on an empty string without leaving a double space', function()
    reset_icons()
    attention.configure_icons { waiting = '', done = '', running = '' }
    assert_eq(rendered(), ' 0 waiting   0 done   0 running ',
      'empty glyph left stray padding')
  end)

  it('keeps the current glyph when the override is not a string', function()
    reset_icons()
    attention.configure_icons { waiting = 42, done = false, running = nil }
    assert_eq(rendered(), ' ▲ 0 waiting   ✓ 0 done   ● 0 running ',
      'a malformed override reached the status bar')
  end)

  it('ignores a non-table override entirely', function()
    reset_icons()
    attention.configure_icons('nope')
    attention.configure_icons(nil)
    assert_eq(rendered(), ' ▲ 0 waiting   ✓ 0 done   ● 0 running ',
      'non-table override disturbed the set')
  end)

  it('ignores unknown keys so a typo cannot blank a counter', function()
    reset_icons()
    attention.configure_icons { waitng = 'X' }
    assert_eq(rendered(), ' ▲ 0 waiting   ✓ 0 done   ● 0 running ',
      'a typo key changed the rendered set')
  end)
end)

describe('glyph tint on an active counter', function()
  -- One live entry per status so all three blocks render in their active
  -- colors. `waiting` and `done` are only visible while their tmux
  -- session is still attached to a pane, so the fixture registers the
  -- session in the same global tab_visibility publishes to — without it
  -- those two buckets come back empty and the counters render dim.
  local SESSION = 'wezterm_config_wezterm-config_aaaaaaaaaa'

  local function with_live_entries(fn)
    reset_icons()
    _G.__WEZTERM_PANE_TMUX_SESSION = { [7] = SESSION }
    local now = os.time() * 1000
    local tmp = os.tmpname() .. '.d'
    os.execute('mkdir -p ' .. tmp)
    local state_file = tmp .. '/state.json'
    local fd = io.open(state_file, 'w')
    fd:write(([[{"version":1,"entries":{
      "w":{"session_id":"w","status":"waiting","ts":%d,"tmux_session":"%s"},
      "d":{"session_id":"d","status":"done","ts":%d,"tmux_session":"%s"},
      "r":{"session_id":"r","status":"running","ts":%d,"tmux_session":"%s"}
    }}]]):format(now, SESSION, now, SESSION, now, SESSION))
    fd:close()
    attention.configure { state_file = state_file }
    attention.reload_state()
    local ok, err = pcall(fn)
    os.execute('rm -rf ' .. tmp)
    _G.__WEZTERM_PANE_TMUX_SESSION = {}
    if not ok then error(err, 0) end
  end

  it('paints the glyph with _glyph and the label with _fg', function()
    with_live_entries(function()
      assert_eq(color_of('▲', PALETTE), '#6f4100', 'waiting glyph tint')
      assert_eq(color_of('1 waiting', PALETTE), '#2c1f12', 'waiting label color')
      assert_eq(color_of('✓', PALETTE), '#225c13', 'done glyph tint')
      assert_eq(color_of('1 done', PALETTE), '#1a2517', 'done label color')
      assert_eq(color_of('●', PALETTE), '#094e8c', 'running glyph tint')
      assert_eq(color_of('1 running', PALETTE), '#172330', 'running label color')
    end)
  end)

  it('falls back to _fg when a palette omits the _glyph key', function()
    with_live_entries(function()
      local legacy = {}
      for k, v in pairs(PALETTE) do
        if not k:find('_glyph', 1, true) then legacy[k] = v end
      end
      assert_eq(color_of('▲', legacy), '#2c1f12', 'waiting glyph did not fall back')
      assert_eq(color_of('✓', legacy), '#1a2517', 'done glyph did not fall back')
      assert_eq(color_of('●', legacy), '#172330', 'running glyph did not fall back')
    end)
  end)
end)

describe('a counter at zero stays fully dim', function()
  it('drops the glyph tint too, so `0` never wears a status color', function()
    reset_icons()
    assert_eq(color_of('▲'), PALETTE.new_tab_fg, 'zero-state glyph kept its tint')
    assert_eq(color_of('0 waiting'), PALETTE.new_tab_fg, 'zero-state label color')
  end)
end)

reset_icons()
io.write(('attention-status-icons: %d passed, %d failed\n'):format(pass_count, fail_count))
os.exit(fail_count == 0 and 0 or 1)
