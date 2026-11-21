# Plugin Architecture

WezDeck capabilities ship as **plugins**: the built-in ones (disk / memory /
load guards, OPPO remote, session-bridge watch, agent CLIs) live under
`wezterm-x/plugins/<id>/`, and a machine can add its own under
`~/.config/wezdeck/plugins/<id>/`. Different people run different remotes,
agents and browsers; a plugin is the unit they enable, disable and configure.

Status: **adopted and rolled out 2026-11-21** — see [Rollout](#rollout).

## Why

Before this, one capability was smeared across layers with no shared shape:

- 6 right-status badges were 6 near-identical Lua modules; adding one meant
  editing `constants.lua`, `config/defaults.lua`, `runtime-entry.lua`,
  `titles.lua` and a test (the `OppoRemote·` badge on 2026-11-21 did exactly
  that).
- Each background sampler had its own install / check / uninstall script.
- `grok` alone appears in 15 directories (launcher, attention adapters,
  habit providers, adversarial-review providers, openclaw, session-bridge).
- Four plugin-ish registries already existed, each with its own convention:
  `host/feature_registry.lua`, `habit_report/providers`,
  `adversarial-review/lib/providers`, `commands/manifest.json`.

## Core decision: the contract is files and processes

A capability spans four runtimes — WezTerm Lua (Windows), bash / python
(WSL), systemd, and the C# helper. There is no in-process plugin API that
covers all of them, so the contract between a plugin and the core is:

1. **Declaration** — `plugin.json`: which extension points it contributes to.
2. **State** — `status.json` (+ optional `*.ndjson` history) written by the
   producer, read by WezTerm and reports. Every status file carries
   `heartbeat_at_ms`.
3. **Process** — CLIs (`report` / `status` / `daemon` / `doctor`) for people,
   agents and systemd.

Lua is the one in-process surface: a badge plugin may ship a Lua module with
the existing badge interface (`configure(opts)` + `render_status_segment(palette)`).
Shared status.json plumbing (`parse_json`, `read_file`, `current_epoch_ms`)
comes from the badge SDK, `require 'wezdeck.badge'`
([`wezterm-x/lua/badge_common.lua`](../wezterm-x/lua/badge_common.lua)),
which `plugin_host` registers before loading any plugin.

Built-in plugins may point `producer` / `cli` at existing repo scripts with a
relative path (`../../../scripts/runtime/wsl-disk-guard.sh`) when the script
has other callers; a self-contained capability keeps its scripts in
`bin/` (see the external `oppo-remote` plugin).

The WezTerm status tick runs every 250 ms and must not scan directories or
parse manifests, so `sync-runtime` **compiles** the enabled plugins into a
generated registry — the same pattern as `render-tmux-bindings.sh` →
`chord-bindings.generated.conf`.

```text
wezterm-x/plugins/<id>/plugin.json   ~/.config/wezdeck/plugins/<id>/plugin.json
                 \                    /
     wezterm-x/local/plugins.json (enable / disable / config per machine)
                          |
      scripts/runtime/render-plugins.sh  (validate → generate, in sync)
                          |
        wezterm-x/plugins/registry.generated.lua   (gitignored; Lua reads)
        wezterm-x/plugins/registry.generated.json  (gitignored; CLIs read)
```

## plugin.json

Example: the manifest of the external `oppo-remote` plugin
(`wezdeck-plugin-oppo-remote`).

```json
{
  "id": "oppo-remote",
  "name": "OPPO 互联 remote link",
  "kind": "remote",
  "default_enabled": true,
  "requires": { "host": ["hybrid-wsl"] },
  "badge": {
    "module": "lua/badge.lua",
    "order": 20,
    "config": {
      "state_file": "${runtime_state_dir}/state/oppo-remote/status.json",
      "heartbeat_timeout_ms": 20000,
      "warn_pct": 10
    }
  },
  "producer": { "install": "bin/install.sh", "check": "bin/install.sh --check" },
  "cli": { "oppo-remote-quality": "bin/oppo-remote-quality.sh" },
  "docs": "README.md"
}
```

| Field | Meaning |
|---|---|
| `id` | `[a-z0-9-]+`, unique; namespaces commands, log category, state dir |
| `kind` | free-form grouping (`guard`, `remote`, `agent`, `browser`, …) |
| `default_enabled` | enabled unless `local/plugins.json` disables it |
| `requires.host` | runtime kinds it can run on (`hybrid-wsl`, `posix`) |
| `badge` | right-status contribution; `module` relative to the plugin dir; `config` passed to `configure()` after `${runtime_state_dir}` / `${plugin_dir}` expansion |
| `producer` | background sampler lifecycle hooks (`install`, `check`, `uninstall`) |
| `cli` | operator / agent entry points, exposed via `wezdeck-plugin.sh run <id> <cli>` |
| `agent` | agent-CLI provider attach points (see [Agent providers](#agent-providers)) |
| `docs` | operator doc inside the plugin dir |

`wezterm-x/local/plugins.json` (machine-local, gitignored):

```json
{ "disabled": ["agent-grok"], "config": { "load-guard": { "warn_loadavg_1": 12 } } }
```

`config` entries shallow-merge over the plugin's `badge.config`.

## Extension points

Only points with **two or more existing implementations** get a contract;
a single implementation moves into plugin form without a speculative
interface (e.g. `remote`: the OPPO plugin is the only one — a cross-remote
status schema is extracted when a second remote appears).

| Point | Implementations at adoption | Core owns |
|---|---|---|
| `badge` | disk, mem, load, oppo-remote, session-bridge | load + configure modules, order, skip disabled, shared read / parse / freshness helpers (`lua/badge_common.lua`) |
| `producer` | disk-guard, oom-guard, oppo-remote | `wezdeck-plugin.sh install/check/uninstall <id>` dispatch |
| `cli` | oppo-remote, disk-guard, … | `wezdeck-plugin.sh run <id> <name>` |
| `agent` | claude, codex, grok | provider discovery for habit-report and adversarial-review |

## Not pluginized (yet)

What stays in core, why (checked against the code on 2026-11-21), and what
would have to be true before it moves. Tracked in
[`diagnostics.md#open-questions`](./diagnostics.md#open-questions) §27.

| Capability | Why it is still core | Closes when |
|---|---|---|
| **Windows helper request domains** (clipboard, IME sampling, VS Code, Chrome, WSL heal) | Compiled into `wezdeck-runtime.exe` (`*RequestHandler.cs`, `ImeStateSampler.cs`, `WslHealWatcher*.cs`). Runtime-loading C# is costly and the helper lifecycle is the most fragile part of the stack (§26). | A capability needs to ship without a helper release; then add a generic "exec" request domain rather than C# plugins. |
| **IME badge** (`中` / `英` / `EN`) | Not a standalone producer: `ImeStateSampler` inside the helper writes `ime_mode` into the helper's `state.env`, and Lua reads it through the host feature layer (`host:feature('ime_state')`, rendered in `titles.lua`). It is **not** tied to key handling. A badge-only plugin is possible; the plugin contract just has no "fed by the helper" producer kind yet. | `producer` gains a `helper` kind (badge reads the helper's state via an SDK call), then the badge moves; sampling stays in the helper. |
| **Browser slot badge** (`Ego·…` / `CDP·…`) | One config block (`constants.browser_agent` / `chrome_debug_browser`) is shared by the badge, the `Alt+b` / `Alt+Shift+b` actions (`ui/actions.lua`, 4 call sites), link-open publishing, and the helper's Chrome auto-start args (`host/runtime_helper.lua`). Moving only the badge would split one capability's config in two. | The whole browser capability (actions, link-open, backend switch, badge) moves together — which first needs plugin-contributed actions (next row). |
| **Hotkeys** | `wezterm-x/commands/manifest.json` is the single source for every binding (AGENTS.md hard rule); WezTerm keys and tmux chords are generated from it. A plugin cannot declare its own binding today — binding a plugin CLI is a manual manifest edit. | Plugins contribute `commands` that `render-plugins.sh` merges into the manifest render with namespaced ids and a key-conflict check; the manifest stays the one place bindings resolve. |
| **Agent launch** | Every `claude` / `codex` / `grok` launch terminates at `scripts/runtime/agent-launcher.sh <profile>` (AGENTS.md hard rule: one env-loading site); launch / resume argv lives in `config/worktree-task.env` and `managed_cli.lua`. `agent` plugins only cover provider discovery for review and habit reports, so a new agent CLI still needs a launcher profile edit. | `agent` gains a `launch` contribution that the launcher reads (still the single launch site), replacing the per-CLI `*_RESUME_COMMAND` keys. |

## Agent providers

`kind: "agent"` plugins declare where their per-tool pieces live:

```json
"agent": {
  "habit_provider": "habit_provider.py",
  "review_provider": "review_provider.sh"
}
```

`habit-report` and `adversarial-review` discover providers from
`registry.generated.json` instead of hard-coded lists; a disabled agent
plugin drops out of both.

## Invariants (checked by `render-plugins.sh`)

- `id` matches the directory name and `[a-z0-9-]+`; no duplicates.
- Every referenced file exists.
- A plugin with a `producer` must declare a `badge` or a `cli` with a
  `status` subcommand — blind background work is rejected (design stance #3,
  observability).
- `badge.order` unique among enabled plugins.

## Operating

```bash
scripts/dev/wezdeck-plugin.sh list                     # discovered plugins, on/off, contributions
scripts/dev/wezdeck-plugin.sh disable agent-grok       # writes wezterm-x/local/plugins.json + recompiles
scripts/dev/wezdeck-plugin.sh enable agent-grok --sync # … and runs sync-runtime (badges reach WezTerm)
scripts/dev/wezdeck-plugin.sh doctor                   # files, producer check, status freshness
scripts/dev/wezdeck-plugin.sh install disk-guard       # producer.install (uninstall / check likewise)
scripts/dev/wezdeck-plugin.sh run disk-guard wsl-disk-guard status
```

Agent-provider changes apply as soon as the registry recompiles; badge
changes need `sync-runtime.sh` (or `--sync`). `doctor` exits non-zero only on
FAIL (missing file, failing producer check, compile error); a stale status is
WARN — e.g. `session-bridge` while its watch loop is off.

### Writing a machine plugin

Put it in `~/.config/wezdeck/plugins/<id>/` (or `$WEZDECK_PLUGIN_DIR`).
`render-plugins.sh` validates it and copies it to
`wezterm-x/plugins/.external/<id>/` so sync ships its Lua to the Windows
runtime. Badge modules use the SDK for status files:

```lua
local badge = require 'wezdeck.badge'
local M = { cfg = {} }
function M.configure(c) M.cfg = c end
function M.render_status_segment(palette)
  local st = badge.parse_json(badge.read_file(M.cfg.state_file) or '')
  if not st then return nil end            -- absent while nothing to say
  return ' Hello·' .. tostring(st.n) .. ' ' -- or wezterm.format { … } with palette colours
end
return M
```

A machine habit provider (`agent.habit_provider`) is loaded by path and
must use absolute imports (`from habit_report.schema import ProviderMetrics`).

## Rollout

All five steps landed 2026-11-21, each verified and synced on its own;
parity = the final artifact matches the pre-change path.

| Step | Landed | Acceptance |
|---|---|---|
| 1. RFC | `df19de4` | this doc + design review |
| 2. Kernel + `oppo-remote` | `d2beeb1` | compiler 8 tests; plugin_host parity (6 states) vs direct module; live + canary load without `plugins` warnings |
| 3. Other badges + SDK | `1a5e4a7` | 55 fixtures old vs new modules identical; full plugin bar via host vs old hard-coded order identical in 3 scenarios |
| 4. Agent providers | `e71675c` | provider discovery 6 + habit discovery 4 tests; real `disabled: agent-grok` drops grok from review and habit, restore brings it back; fanout / host-invoke / brainstorm offline suites green |
| 5. CLI + machine plugins | `f472b31` | CLI end-to-end 16 tests (external badge rendered by plugin_host); live probe plugin loaded by canary **and** live WezTerm, then removed cleanly |

## Design review

| Check | Result |
|---|---|
| Problem real and current? | Yes — 5 wiring edits per badge, agent pieces in 15 dirs. |
| Simpler alternative? | Shared badge helper only: removes read/parse duplication but not wiring or enable/disable; rejected as the end state, kept as part of step 3. |
| WezTerm native plugins (`wezterm.plugin.require`)? | Lua-only; cannot carry samplers / systemd / WSL CLIs. Possible future distribution channel for the Lua part only. |
| Blast radius | Lua status bar (every window), sync pipeline (new compile step), habit-report / adversarial-review provider lookup. No change to helper, launcher, hotkeys. |
| Hard rules preserved? | Manifest single source, launcher single site, `local/` for machine overrides — yes. |
| Failure mode | Missing / invalid registry → Lua logs and renders no plugin badges (bar degrades, WezTerm still loads); compile errors fail sync before publication. |
| Observability | Plugin load errors → `plugins` log category; `wezdeck-plugin.sh doctor` per plugin. |
| Reversibility | Each step is one commit; registry is generated, so revert = revert commit + sync. |
