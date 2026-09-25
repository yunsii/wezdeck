<p align="center">
  <img src="assets/brand/banner.svg" alt="WezDeck — A flight deck for your AI agents" width="960">
</p>

<h1 align="center">WezDeck</h1>

<p align="center">
  <em>A flight deck for your AI agents — built on WezTerm, tmux, and git worktrees.</em>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="WezTerm: nightly" src="https://img.shields.io/badge/wezterm-nightly-8b5cf6">
  <img alt="tmux: ≥ 3.7" src="https://img.shields.io/badge/tmux-%E2%89%A5%203.7-1f6feb">
  <img alt="Platform" src="https://img.shields.io/badge/platform-linux%20%C2%B7%20wsl%20%C2%B7%20macOS-22d3ee">
  <img alt="Lua" src="https://img.shields.io/badge/lua-5.4-000080">
</p>

> One WezTerm tab per repo. One tmux window per worktree. One pane per agent. One keystroke to find what's waiting on you.

This repository is the source of truth for the WezDeck runtime. The GitHub repo is [`yunsii/wezdeck`](https://github.com/yunsii/wezdeck) (the previous `yunsii/wezterm-config` URL still works via GitHub's permanent redirect).

## Design stance

WezDeck is not a pile of hotkeys — it is a **control plane** for multi-agent terminal work. Three constraints shape every new interaction. They are also **binding agent guidance** in [`AGENTS.md` · Design stance](AGENTS.md#design-stance) / Hard Rules — not README-only marketing.

| Constraint | What it means in practice |
|---|---|
| **Keyboard-first** | Every new or changed interaction has a keyboard path; mouse is fallback only. Manifest + palette cover the same actions. |
| **Headless verify for agents** | Debug Chrome auto-starts headless (`CDP·H·…`); agents attach via CDP/MCP without stealing GUI focus. |
| **Observable development process** | Hot paths emit structured signals so a day can be reconstructed, latency gated, and habits reviewed — not guessed from memory. Blind features (no badge / log / projector path) are incomplete. |

The third constraint is load-bearing for iteration: badges warn live, logs explain a sticky key or a stuck attention state, and day/week projectors turn those same signals into a reviewable loop. Longer narrative: [`docs/presentations/`](docs/presentations/).

## ✨ Highlights

- **Tab × Worktree × Agent in one frame** — every WezTerm tab is one repo, every tmux window inside it is a linked git worktree, every pane can host an agent CLI (`claude` / `codex` / `grok` / …).
- **Primary pane auto-resume** — managed agent panes boot through `agent-launcher.sh` with `<base>-resume`; after WezTerm or machine restart, entering a worktree continues the last conversation (falls back to a fresh session when none exists).
- **Live attention surface** — per-tab badges plus a right-status counter `▲ N waiting ✓ N done ● N running`, driven by agent hooks → `attention.json`.
- **In-slot jump keys** — `Alt+j` / `Alt+k` / `Alt+l` step waiting / done / running; `Alt+/` and `Alt+x` are occasional overview / overflow pickers, not the main loop.
- **One keystroke to spawn a worktree** — `Ctrl+k g d/t/h` carves out a linked worktree (with its own agent) when no suitable slot exists.
- **Manifest-driven hotkeys** — `wezterm-x/commands/manifest.json` is the single source of truth; per-machine overrides live in `wezterm-x/local/keybindings.lua`.
- **Dev-env observability** — right-status pressure badges, structured runtime / WezTerm logs, threshold-gated latency rows, plus day timeline and habit-weekly projectors for review.

## 🎛️ Workbench · A day in the loop

> Find the slot first (workspace / tab / worktree), keep the agent resumed, then
> jump and verify in-slot. Measured day loops are dominated by `Alt+j/k/l` and
> `Alt+v` — not by the overview pickers.

```text
need arises
  → switch workspace (Alt+w/c/…) · tab (Alt+1..9) · worktree (Alt+g)
       └─ no suitable slot → Ctrl+k g d|t|h  create, then enter
  → primary pane auto-resumes for that cwd
  → main loop: Alt+j waiting · Alt+k done · Alt+l running
               + Alt+v open VS Code (daily verify path)
       · side paths: Alt+b debug Chrome · Alt+/ overview · Alt+x overflow
  → deliver onto origin/HEAD → recycle (dev-*) / reclaim (task|hotfix)
```

| Stage | Capability | Deep dive |
|---|---|---|
| Land on the slot | Workspace switch + tab index + **`Alt+g`**; create only when missing | [Workspaces](docs/workspaces.md) |
| Continue after restart | **`<base>-resume`** via `agent-launcher.sh` + access-ledger focus restore | [Architecture · startup](docs/architecture.md#startup-invariants) |
| In-slot loop | Badges / counter + **`Alt+j/k/l`** (highest-frequency keys in a real day) | [Agent attention](docs/agent-attention.md) |
| Verify | **`Alt+v`** daily; **`Alt+b`** when you need the debug Chrome (MCP shares CDP) | [Browser debug](docs/browser-debug.md) |
| Close the round | Mainline delivery (no PR) → **`worktree-recycle`** / reclaim | [Maintenance loop](docs/workspaces.md#maintenance-loop-wezdeck-standing-policy) |
| Review the day / week | Timeline + habit report from the same signals | [Diagnostics · timeline](docs/diagnostics.md#workflow-timeline) · [Habit report](docs/diagnostics.md#habit-report) |

## 📡 Observability surface

Three layers share one idea: **if you cannot see it, you cannot improve it.**

### Live right-status (operator glance)

Left → right (pressure badges stay absent while healthy — presence *is* the signal):

`IME` · `CDP·…` · `◆ SB·N` · `D·…` · `M·…` · attention counters

| Segment | Meaning | Deep dive |
|---|---|---|
| `CDP·H/V/-/?·port` | Headless / visible / down / helper stale | [Browser debug](docs/browser-debug.md) |
| `◆ SB·N` | Session-bridge watch poller | [session-bridge](openclaw/docs/session-bridge.md) |
| `D·…` | Host volume headroom under WSL `ext4.vhdx` | [Host disk](docs/host-disk.md) |
| `M·…` | Guest memory pressure / earlyoom proximity | [Guest OOM](docs/guest-oom.md) |
| `▲ / ✓ / ●` | Waiting / done / running attention | [Agent attention](docs/agent-attention.md) |

### Structured logs + latency (why did it feel sticky?)

- WSL `runtime.log` + Windows `wezterm.log` / `helper.log` — category-scoped rows (`attention`, `hotkey`, `latency`, …).
- Threshold-gated slow hotkey / status-tick rows; slow samples attach guest pressure from the same `M·` status file.
- Operator entry: [`docs/diagnostics.md`](docs/diagnostics.md) · author conventions: [`docs/logging-conventions.md`](docs/logging-conventions.md) · report: `scripts/dev/latency-report.sh`.

### Day / week reconstruction (review & optimize)

| Projector | Question it answers | Entry |
|---|---|---|
| **Workflow timeline** | How did I move through workspaces / worktrees / attention / host verify today? | `scripts/dev/workflow-timeline.sh` · [docs](docs/diagnostics.md#workflow-timeline) |
| **Habit report / weekly** | Agent concurrency, skills/MCP/CLI, verify→iterate, hotkey intensity, optional WakaTime / Rime / git churn | `scripts/dev/habit-report.sh` · skill `habit-weekly` · [docs](docs/diagnostics.md#habit-report) |

```bash
scripts/dev/workflow-timeline.sh --summary
scripts/dev/habit-report.sh --days 7
# weekly write-up: load skill habit-weekly → skills/habit-weekly/run.sh
```

## 🧭 How It Works

```
WezTerm tab          ─┐
  └─ tmux window     ─┤  one repo  ·  one worktree  ·  one agent (resume)
       └─ tmux pane  ─┘
                       ↑
       agent hooks → attention.json → tab badges + right-status counter
                                       ↑
                         Alt+j/k/l  +  Alt+v  (main loop)
                       ↓
       structured logs → timeline / habit projectors  (review loop)
```

Full architecture, ownership boundaries, and the WSL ⇄ Windows channels: [`docs/architecture.md`](docs/architecture.md). Session + interop map (workspace/tab/tmux/worktree/agent/attention ↔ session-bridge ↔ Feishu): [Session & Interop Overview](docs/architecture.md#session--interop-overview).

## ✅ Requirements

| | Required | Notes |
|---|---|---|
| **WezTerm** | nightly | `hybrid-wsl` mode runs on the Windows nightly build |
| **tmux** | ≥ 3.7 | DEC sync 3.6+; `refresh-from-pane` 3.7+. Prefer OS/brew package when ≥ 3.7; user-prefix `~/.local` only if distro is older (e.g. Ubuntu apt 3.4). [Install](docs/tmux-install.md) · [Why](docs/ime-flicker-and-sync-output.md) |
| **lua5.4** | recommended | Powers the sync precheck; missing → precheck skipped with a warning |
| **jq** | recommended | Agent-attention writer & focus path; missing → degraded labels |
| **go ≥ 1.21** | optional | For maintainers of `native/picker/`. End users get a sha256-pinned prebuilt tarball via the release fetcher |
| **python3** | optional | Habit / timeline projectors; WakaTime status |

Supported runtime modes: `hybrid-wsl` (Windows WezTerm + WSL/tmux) and `posix-local` (Linux / macOS local).

## 🚀 Quick Start

```bash
# 1. Seed your machine-local config
cp -r wezterm-x/local.example/ wezterm-x/local/
$EDITOR wezterm-x/local/constants.lua   # runtime_mode, default_domain, shell, …
$EDITOR wezterm-x/local/shared.env      # WAKATIME_API_KEY, MANAGED_AGENT_PROFILE, …

# 2. Sync the runtime into $HOME (writes ~/.wezterm.lua + ~/.wezterm-x/)
skills/wezdeck-runtime-ops/scripts/sync-runtime.sh

# 3. Reload WezTerm and confirm the right status shows
#    attention counters (and CDP·… when the helper is up) — that means the
#    attention / CDP pipelines are live. D· / M· appear only under pressure.
```

Full setup walkthrough: [`docs/setup.md`](docs/setup.md). Optional guards on WSL hosts: [`docs/guest-oom.md`](docs/guest-oom.md) · [`docs/host-disk.md`](docs/host-disk.md).

## 📚 Documentation

**Get started**
- [Setup](docs/setup.md) · [Daily workflow](docs/daily-workflow.md) · [Workspaces](docs/workspaces.md) · [Presentations](docs/presentations/)

**Daily use**
- [Keybindings](docs/keybindings.md) · [tmux UI](docs/tmux-ui.md) · [Agent attention](docs/agent-attention.md) · [Browser debug](docs/browser-debug.md)

**Observability & ops**
- [Diagnostics](docs/diagnostics.md) (latency · [workflow timeline](docs/diagnostics.md#workflow-timeline) · [habit report](docs/diagnostics.md#habit-report)) · [Guest OOM](docs/guest-oom.md) (`M·`) · [Host disk](docs/host-disk.md) (`D·`) · [Logging conventions](docs/logging-conventions.md)

**Internals**
- [Architecture](docs/architecture.md) · [Performance](docs/performance.md) · [IME & sync output](docs/ime-flicker-and-sync-output.md) · [Dev-env troubleshooting](docs/development-environment-troubleshooting.md)

**Releases**
- [Host helper](docs/host-helper-release.md) · [Picker](docs/picker-release.md)

Docs map: [`docs/README.md`](docs/README.md). Agent rules: [`AGENTS.md`](AGENTS.md). Reusable user-level profiles: [`agent-profiles/`](agent-profiles/). Chinese twin: [`README.zh-CN.md`](README.zh-CN.md) — keep in structural sync (repo-hygiene L0 checks heading outline, relative links, fences/tables, and durable tokens).

## 🎨 Brand

Brand SVGs and the geometric construction notes live in [`assets/brand/`](assets/brand/) — see [`assets/brand/README.md`](assets/brand/README.md) for the asset table and proportional rules.

## 📄 License

MIT © Yuns. See [LICENSE](LICENSE).
