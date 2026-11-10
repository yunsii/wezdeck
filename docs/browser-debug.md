# Browser Debug Workflow

Use this doc when you need anything about the headless Chrome debug instance the Windows WezDeck Runtime runs: the four daily paths (auto-start, agent / MCP attach, `chrome://inspect`, manual `Alt+b` / `Alt+Shift+b`), the launch hardening flags, the right-status `CDP·…` badge, or the status-file contract that drives the badge.

The keyboard summary lives in [`keybindings.md#project-navigation`](./keybindings.md#project-navigation); this doc owns the workflow detail.

## Browser backends (`ego` | `cdp`)

Host agents and OpenClaw share one explicit switch (no `auto`):

| Value | Agent path | OpenClaw after apply |
| --- | --- | --- |
| `ego` | WSL `ego-browser` → Windows ego (lite) Space / Page API | vendor `ego-browser` skill linked; **no** resident `chrome-devtools` MCP |
| `cdp` | `chrome-devtools-mcp` → WezDeck debug Chrome `:9222` | resident `mcp.servers.chrome-devtools` |

```bash
# Switch + write OpenClaw MCP/skill links (single write entry)
apply-browser-backend --set ego
apply-browser-backend --set cdp

# Session override (still run apply so OpenClaw matches)
export WEZDECK_BROWSER_BACKEND=ego
```

Config file: `~/.config/shell-env.d/wezdeck-browser-agent.env` (template
`wezterm-x/local.example/shell-env.d/wezdeck-browser-agent.env`). Routing skill:
[`skills/browser-agent/SKILL.md`](../skills/browser-agent/SKILL.md). WSL bridge:
`scripts/runtime/cli/ego-browser`. Apply script:
`scripts/runtime/apply-browser-backend.sh`.

Ego is a visible Chromium with Spaces (human can take over). CDP remains the
headless, no-focus-steal path for UI verify / Network / Console. Do not point
`--browserUrl` at Ego — it does not expose a public CDP port. Full migration to
Ego-only (disable CDP auto-start) is a later operator decision after trial.

### Unified hotkeys, badge, and WezTerm startup

`Alt+b` / `Alt+Shift+b` and the right-status browser slot follow `backend`:

| | `backend=ego` | `backend=cdp` |
| --- | --- | --- |
| **WezTerm `gui-startup`** | Quiet ensure ego (lite) running; no focus steal | Helper auto-starts headless debug Chrome (existing) |
| `Alt+b` | Ensure ego running; **do not** activate window | Headless debug Chrome (existing) |
| `Alt+Shift+b` | Ensure + **focus** ego window | Visible debug Chrome (existing) |
| Badge | `Ego·A` / `Ego·-` / `Ego·?` | `CDP·H/V/-/?·port` |

When `backend=ego`, helper **ChromeDebugAutoStart** is turned off so WezTerm
boot does not also pull up the CDP instance. Switch back with
`apply-browser-backend --set cdp` (next helper ensure picks it up).

Status file (Windows runtime FS): `state/browser-agent/status.json`, written by
`apply-browser-backend`, the `ego-browser` CLI wrapper, the ego Alt+b
PowerShell helper (`ego-window.ps1` under `~/.wezterm-x/scripts/` after apply),
and the **helper ego heartbeat** (`EgoHeartbeatSampler` in
`wezdeck-runtime.exe`): while `backend=ego`, each helper tick may refresh
`ego.alive` / `updated_at_ms` (throttled to ~30s, or immediately on alive
flip). That keeps the badge off `Ego·?` when ego is still running but idle.
`Ego·?` still means the status file itself is stale or missing a usable
timestamp (helper down, path wrong, or no writer yet).

Probe:

```bash
ego-browser nodejs -e "console.log('ego-browser ready')"
curl -sS -m 3 http://127.0.0.1:9222/json/version
cat "$(wslpath -u "$LOCALAPPDATA")/wezterm-runtime/state/browser-agent/status.json" 2>/dev/null \
  || cat /mnt/c/Users/$USER/AppData/Local/wezterm-runtime/state/browser-agent/status.json
```

## The four daily paths (CDP)

The default day is **headless**: the Windows helper auto-launches a headless Chrome the moment it boots, MCP / agent tools attach without ever surfacing a window, and nothing is allowed to grab the foreground or flash the taskbar. When you actually need to look at the page yourself, you pivot from your default browser through `chrome://inspect` (or `edge://inspect`) — no need to switch the headless instance to visible just to peek.

1. **Daily — auto-start (zero keystrokes)**. Helper boot runs `ReconcileOnStartup` then mode-agnostic detection on `localhost:<remote_debugging_port>` + the configured `user_data_dir`; if any chrome (visible or headless) is already there it adopts the existing PID, otherwise it launches a fresh headless one. The status segment lands on `CDP·H·<port>` immediately. MCP servers in your agent / Claude Code config can stay attached via `--browser-url=http://localhost:<port>` across sessions; nothing depends on you having pressed `Alt+b`.
2. **Programmatic — agent tools and MCP**. With auto-start running, every Chrome DevTools MCP server, every agent that takes `--browser-url=http://localhost:<port>`, and every CDP-aware automation script just connects. The endpoint always answers (you can confirm with `curl -sS http://localhost:<port>/json/version` from any pane in WSL or Windows). The agent never has to wait for a human to "set up" the browser. **OpenClaw** registers this as local `mcp.servers.chrome-devtools` (see [`openclaw/README.md`](../openclaw/README.md#chrome-devtools-mcp-core-browser-capability) and skill `openclaw/workspace/skills/chrome-devtools/`); Grok/Claude MCP sessions are separate processes that still attach to the same CDP port.
3. **Human inspection — `chrome://inspect` from your default browser**. Open your normal Chrome (or Edge / any Chromium) and go to `chrome://inspect/#devices`. Click *Configure…* in the *Discover network targets* row and add `localhost:<remote_debugging_port>` (default `9222`). The headless instance's pages and service workers appear under *Remote Target*; click *inspect* on any one to open the standard DevTools window — Console, Network, Elements, Sources, Performance — fully connected to the headless session your agent is driving. This is the path for "agent broke, let me look at what it sees" and "I need to manually adjust state then hand it back". It works because the launch flags use `--remote-allow-origins=*`, so the WebSocket from `chrome://inspect` is not rejected. The headless instance keeps running afterward; closing the inspector does not change anything in the session.
4. **Manual override — `Alt+b` / `Alt+Shift+b`**. Reserved for the cases where `chrome://inspect` is not enough: `Alt+b` resets the instance to headless (kills any visible chrome on the same port + user_data_dir first, then relaunches headless), `Alt+Shift+b` kills headless and switches to a fully visible chrome (pops a window into the foreground). Use these when the agent flow requires a clean slate, or when `chrome://inspect`'s read-mostly view is not enough and you need a real visible browser window to type in. After either action the right-status badge flips to `CDP·H·<port>` or `CDP·V·<port>` to confirm.

## Auto-start behavior

The Windows helper auto-starts a headless Chrome debug instance the moment it boots (after `ReconcileOnStartup`), so `http://localhost:<remote_debugging_port>` always has a CDP endpoint for MCP / agent tools without requiring `Alt+b` to be pressed first.

- Detection is **mode-agnostic**: any chrome already running on that port + `user_data_dir` is adopted as-is regardless of mode (so a visible session you started yesterday survives helper restarts intact). Only when nothing is running does the helper launch one, and that launch is **always headless** to avoid interrupting whatever app currently owns the foreground.
- Auto-start never steals focus and never writes the WindowReuseService cache (those belong to user-driven `Alt+b`).
- To disable: set `chrome_debug_browser.auto_start = false` in `wezterm-x/local/constants.lua`.
- The `chrome_debug_browser.headless` field still governs the user-driven `Alt+b` path and is independent of auto-start.

## `Alt+b` — headless launch / reuse

Launches or reuses the Chrome debug browser profile from `wezterm-x/local/constants.lua` in headless mode. Pressing it never steals focus or flashes the taskbar; MCP clients attach via `--browser-url=http://localhost:<port>`.

The launch always adds these hardening flags:

- `--remote-allow-origins=*` — covers MCP `http://localhost:<port>` clients and the human-debug path through `chrome://inspect` / `edge://inspect` / `devtools://devtools`. The wildcard is acceptable because Chrome binds the port to 127.0.0.1 and the dedicated `user_data_dir` is not the user's main profile.
- `--no-first-run`, `--no-default-browser-check`.
- `--headless=new` and `--window-size=1920,1080` — headless defaults to 800×600, which breaks MCP screenshots and viewport-sensitive scrapes.

Browser extensions are **not** disabled — install whatever you need via `Alt+Shift+b` (visible mode) → `chrome://extensions/`. The extensions are stored in the dedicated debug `user_data_dir` and persist across mode switches, so a headless instance launched later will load them too.

If a visible-mode Chrome is already holding the same port + `--user-data-dir`, the helper terminates it (entire process tree) before launching headless so the Chrome singleton lock is released — this is the automatic mode switch; `Alt+Shift+b` is the visible-direction companion.

In `hybrid-wsl` this goes through the same Windows native helper path as `Alt+v`. In `posix-local` it stays unavailable until a native WezDeck Runtime exists.

## `Alt+Shift+b` — visible launch / reuse

Launches or reuses the same Chrome debug browser profile in visible (headful) mode for manual acceptance or UI verification. Shares the same `user_data_dir` (cookies, logins, extensions state preserved across mode switches) and same port as `Alt+b`, so only one mode can run at a time.

Pressing this when a headless instance is running will kill that headless first, wait for the `--user-data-dir` singleton lock to release, and start a visible Chrome with the same hardening flags (minus `--headless=new` and `--window-size=1920,1080`, which are headless-only). MCP connections from the previous headless session will drop and can be reestablished on the visible instance. The right-status segment flips to `CDP·V·<port>` after launch.

## Right-status layout (browser slot and neighbors)

Right-status order (left → right):

`IME` · **browser slot (`Ego·…` or `CDP·…`)** · **`◆ SB·N`** (session-bridge watch, absent while idle) · **`C·…` / `D·…`** (system + WSL host disk, absent while healthy) · **`M·…`** (guest mem, absent while healthy) · **`L·…`** (guest load, absent while healthy) · attention counters

The browser slot follows `WEZDECK_BROWSER_BACKEND` (see [backends](#browser-backends-ego--cdp)). The `◆ SB·N` badge is owned by session-bridge take/watch (`Ctrl+K w`); it renders only while the poller heartbeat is fresh (no always-on `SB·-`). The `◆` matches the glyph the `Alt+/` picker puts on that poller's watch rows and is overridable per machine via `session_bridge_watch.icon` in `wezterm-x/local/constants.lua` (`''` leaves a bare `SB·N`). See [`openclaw/docs/session-bridge.md`](../openclaw/docs/session-bridge.md). Heartbeat file: `state/session-bridge-watch/status.json` under the WezTerm runtime state dir. Disk / mem / load: [`host-disk.md`](./host-disk.md) · [`guest-oom.md`](./guest-oom.md) · [`diagnostics.md`](./diagnostics.md) "Guest load badge".

## Right-status browser badge

### `backend=ego`

| Badge | Meaning | Style |
|---|---|---|
| `Ego·A` | ego process recently alive (`status.json` ego.alive) | running-attention palette, Bold |
| `Ego·-` | backend is ego but process not running | idle palette, Italic |
| `Ego·?` | ego heartbeat older than `browser_agent.ego_heartbeat_timeout_ms` (default 120 s) | warning palette, Italic |

With a live helper, the ~30s ego heartbeat should keep `Ego·A` / `Ego·-`
current while `backend=ego`. Persistent `Ego·?` usually means the helper is
not running or `browserAgentStatusPath` is missing from manager-config (re-run
`wezdeck-runtime-ops` / restart WezTerm so `ensure-wezdeck-runtime.ps1`
rewrites config).

Marks stay ASCII (same cell width as `CDP·H`) so the tab-bar font does not
leave a blank hole between IME and attention.

### `backend=cdp` (default when status missing)

The WezTerm right-status renders just to the right of the IME segment as a fixed-width badge. The four states share the same glyph count so the bar width never jitters when you switch CDP modes:

| Badge | Meaning | Style |
|---|---|---|
| `CDP·H·<port>` | headless ready | inactive palette, Normal intensity |
| `CDP·V·<port>` | visible ready | running-attention palette, Bold |
| `CDP·-·<port>` | helper alive but Chrome not running (`mode=none` or `alive=false`; auto-start failed or you killed chrome and have not relaunched). The port falls back to `remote_debugging_port` when no state file exists yet | idle palette, Italic |
| `CDP·?·<port>` | helper itself looks dead — its `state.env` heartbeat is older than `helper_heartbeat_timeout_seconds`, so the chrome state file may be arbitrarily stale and the badge cannot be trusted | warning palette, Italic |

## State file contract

The helper writes the current mode/port/pid/alive to `chrome_debug_browser.state_file` (defaults to `$runtime_state_dir/state/chrome-debug/state.json`) on every successful request, and rewrites it to `mode=none, alive=false` the moment the Chrome process exits.

Liveness detection runs through `ChromeLivenessWatcher`, which subscribes `Process.Exited` plus a 5-second `HasExited` poll fallback, and re-subscribes on helper restart through `ReconcileOnStartup`.

After a tracked Chrome exits, the same 5-second poll keeps looking for a new chrome.exe matching the same port + `user_data_dir` and adopts it if one shows up — Chrome's own auto-update path kills the running chrome and immediately respawns a fresh one on the same port, and without this re-detection the badge would stay at `CDP·-·<port>` until the user pressed `Alt+b`. Adoption uses the same mode-agnostic match spec as `AutoStart`, records the actual mode (headless vs. visible) read from the new process's command line, and re-subscribes `Process.Exited` on the new PID.

## End-to-end smoke check

```bash
curl -sS http://localhost:<port>/json/version
```

A healthy chain returns a JSON blob with `Browser`, `Protocol-Version`, and `webSocketDebuggerUrl`; that single response confirms helper, chrome, and the inspect path are all live.

If the badge shows `CDP·?·<port>`, run `wezdeck-runtime-ops` or restart WezTerm to respawn the helper. See also [`diagnostics.md`](./diagnostics.md) for the runtime-side traceability fields.
