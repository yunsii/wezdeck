# AGENTS

This file is the project-level agent entry point.
User-level reusable agent profiles hosted under `agent-profiles/` are separate and do not override this file unless a user explicitly points an external tool at them.

## Loading Rule

Read `AGENTS.md` first, then open only the matching file under `docs/`. Read additional docs only when the current doc points to them or the task crosses that boundary.

## Task Routing

- Setup, local prerequisites, or machine-local config:
  Read [`docs/setup.md`](docs/setup.md).
- Human-only script handoff (`wd-run` / `x`), propose→peek→CAS run, handoff
  audit / retention, or “do not paste multi-line scripts for the human to run”:
  Read [`docs/agent-run.md`](docs/agent-run.md). Agent self-exec is out of scope.
- Sync, reload, verification, or day-to-day maintenance:
  Read [`docs/daily-workflow.md`](docs/daily-workflow.md).
- Repo hygiene (doc/code size budgets, broken relative links, pre-commit gate, `run.sh audit`):
  Read [`docs/daily-workflow.md#repo-hygiene`](docs/daily-workflow.md#repo-hygiene); run `scripts/dev/repo-hygiene/`.

- Resetting a long-lived `dev-*` workstation / 「重置开发分支」 / recycle onto
  `origin/HEAD` / closing a round then starting the next task:
  Load platform skill [`scripts/dev/worktree-recycle/SKILL.md`](scripts/dev/worktree-recycle/SKILL.md)
  (linked as `worktree-recycle`); do **not** hand-roll `git reset` or ask the
  human to run CLI. Docs: [`docs/workspaces.md`](docs/workspaces.md#recycle-long-lived-dev--round-reset).
  **Standing policy:** after a worktree round is delivered onto mainline, always
  recycle the `dev-*` tree so the next round starts from `origin/HEAD`; keep
  primary `master` / `WEZTERM_REPO` as the machine source of truth
  ([Maintenance loop](docs/workspaces.md#maintenance-loop-wezdeck-standing-policy)).
- Workspace definitions or workspace behavior:
  Read [`docs/workspaces.md`](docs/workspaces.md).
- Keybindings:
  Read [`docs/keybindings.md`](docs/keybindings.md).
- tmux UI, tab titles, status rendering, copy-mode, or visible terminal behavior:
  Read [`docs/tmux-ui.md`](docs/tmux-ui.md).
- Terminal Vim inside tmux: scroll that feels like page-skips, windows full of
  `@` rows, `'termsync'` / DEC 2026 under tmux DA2, or `Shift+drag` jumping
  into copy-mode while editing:
  Read [`docs/tmux-ui.md#vim-in-tmux`](docs/tmux-ui.md#vim-in-tmux)
  (install / vimrc: [`docs/setup.md#vim-92-optional`](docs/setup.md#vim-92-optional)).
- Grok Build fullscreen TUI: whole-transcript flash on `Alt+o` / pane focus,
  FocusGained `terminal.clear()`, cream `#eeeeee` vs pane `bg_base`, the
  PATH focus-filter (`grok-with-focus-filter.sh --install` / `--check` /
  launch `--ensure`; `~/.grok/bin/grok` → wrapper, `grok.real` = ELF; zshrc
  prepends `~/.grok/bin`), **interactive `grok` after `grok update`**
  (updater clobbers `~/.grok/bin/grok`; heal = shell-env `grok()` absolute
  wrap + launch ensure reseats PATH **and** re-applies GrokDay cream/`Reset`
  theme patch, then exit/`--resume` live panes — do not redesign
  focus-events), why managed `agent-launcher.sh grok` can look fine while a
  bare-PATH `grok` flashes (launcher uses wrapper absolute path), why
  macOS WezTerm+tmux can look fine with the same heal (sub-frame client
  burst, not OS-exempt), why WSL→Windows still flashes even on a tiny pane,
  `scripts/dev/repro-grok-focus-flash.sh`, mouse-wheel feel under tmux
  (`scroll_lines` / `scroll_mode=wheel` / `scroll_speed` in `~/.grok/config.toml`),
  or Grok follow ▼ click dead while a stock-tmux macOS box works
  (`MouseDown1Pane` must `send-keys -M` when `alternate_on` / `mouse_any_flag`):
  Read [`docs/tmux-ui.md#grok-build-in-tmux`](docs/tmux-ui.md#grok-build-in-tmux).
- Window appearance presets (`opaque` / `frosted`), transparency /
  frosted-glass, `win32_system_backdrop`, `window_background_opacity`, the
  `WEZTERM_APPEARANCE_PRESET` selector, `render-tmux-appearance.sh`, or the
  tab-bar / pane / status background colors that make the frosted look cohere:
  Read [`docs/appearance-presets.md`](docs/appearance-presets.md).
- Choosing or revisiting the inner multiplexer (tmux vs herdr), or planning
  feature work that a tmux upgrade could absorb — the tmux 3.8 borrow list
  (OSC 133 pane events, floating / modal panes, `set-hook -B` monitors, theme
  reporting, `#{A/count:frames}`), the measured herdr 0.8.0 numbers
  (per-session server memory, session-level focus, sidebar limits, no
  `#(shell)` equivalent, no ad-hoc popup CLI), and why the 2026-08-18
  evaluation ended with tmux staying:
  Read [`docs/multiplexer-comparison.md`](docs/multiplexer-comparison.md).
- Agent-attention pipeline: Claude hook install / upgrade, attention.json
  schema and transitions, tab badges + right-status counters, focus-based
  auto-ack, the `Alt+j` / `Alt+k` / `Alt+l` / `Alt+Shift+l` / `Alt+/` keyboard entry points, or
  Codex integration:
  Read [`docs/agent-attention.md`](docs/agent-attention.md).
- Timed reminders (cron-driven tmux popups), the `reminder.sh` /
  `tmux-popup-active.sh` wrappers, or the
  `wezterm-x/local/crontab` install workflow:
  Read [`docs/reminders.md`](docs/reminders.md).
- Phone / Android remote work (OpenClaw only; Happy + Tailscale phone
  shell retired 2026-07), tmux window-size limits, Termux IME notes:
  Read [`docs/mobile-access.md`](docs/mobile-access.md).
- Headless Chrome debug instance, auto-start behavior, `Alt+b` /
  `Alt+Shift+b`, `chrome://inspect` workflow, or the right-status `CDP·…`
  badge:
  Read [`docs/browser-debug.md`](docs/browser-debug.md).
- Cutting a Windows host-helper release, updating
  `release-manifest.json`, forcing the release-install branch, or
  side-loading the release zip:
  Read [`docs/host-helper-release.md`](docs/host-helper-release.md).
- Cutting a Go picker (`native/picker/`) release, updating its
  multi-asset `release-manifest.json`, or the install-side fetcher
  (`WEZTERM_PICKER_INSTALL_SOURCE=auto|local|release`) that lets end
  users without Go consume the prebuilt tarball:
  Read [`docs/picker-release.md`](docs/picker-release.md).
- Diagnostics, logs, smoke tests, latency / hotkey counters, or operator
  troubleshooting (env knobs, file paths):
  Read [`docs/diagnostics.md`](docs/diagnostics.md).
- Personal development-habit weekly report（开发习惯周报 / habit weekly）:
  Load platform skill [`scripts/dev/habit-weekly/SKILL.md`](scripts/dev/habit-weekly/SKILL.md)
  (`habit-weekly`); collector is `scripts/dev/habit-report.sh`. Not
  `coco-weekly-report` (business delivery).
- Guest OOM hardening (distro restart loop, reclaim livelock, high-order
  allocation / VM reboot; `wsl-oom-guard.sh`, `M·…` / earlyoom; standing
  memory consumers including MCP/`uxc` and IDE `tsgo` / `goMemLimit`):
  Read [`docs/guest-oom.md`](docs/guest-oom.md).
- Host disk space (host volume full, `ext4.vhdx` never shrinking, sparse-VHD
  trap, trim→shutdown→Optimize-VHD / compact, OEM preinstalls, `D·…` badge):
  Read [`docs/host-disk.md`](docs/host-disk.md).
- Unverified claims, deferred decisions, or "what still needs following up" on
  any of the above — dated, each with how to close it:
  Read [`docs/diagnostics.md#open-questions`](docs/diagnostics.md#open-questions).
  Record new ones there rather than only in a commit body, which is not
  reviewable day to day.
- Cross-host development environment failures involving Windows, WSL, DNS,
  VPN/proxy software, shells, or agent CLIs; also the first-triage path when
  the whole WSL distro disappears at once (distro restart vs VM reboot):
  Read [`docs/development-environment-troubleshooting.md`](docs/development-environment-troubleshooting.md).
- Adding or modifying a logger callsite, choosing a category, deciding
  log level / required fields, or moving a log file across the WSL
  boundary (author surface):
  Read [`docs/logging-conventions.md`](docs/logging-conventions.md).
- Performance work on the Alt+/ popup, the cross-FS routing rule for
  state files, the bench harnesses, or the sync-runtime hot path
  (skip-if-current gates, rsync-vs-cp tradeoff, mtime-based change
  detection):
  Read [`docs/performance.md`](docs/performance.md).
- IME candidate-window stability, DEC mode 2026 (synchronized output),
  why tmux 3.7+ is required, or agent-CLI render flicker investigation:
  Read [`docs/ime-flicker-and-sync-output.md`](docs/ime-flicker-and-sync-output.md).
- Sending a signal from a hook / picker / external helper into the
  WezTerm Lua process, picking between OSC and file transports, adding
  a new event, or migrating producers/consumers when upstream tmux or
  wezterm fix popup OSC pass-through:
  Read [`docs/event-bus.md`](docs/event-bus.md).
- Per-workspace tmux-session focus statistics, the `tab-stats-bump.sh`
  hook chain, the on-disk `<workspace>.json` schema, weight decay /
  normalization formula, or planning the top-N tab bar slots / overflow
  tab / warm preheat layer:
  Read [`docs/tab-visibility.md`](docs/tab-visibility.md).
- Ownership boundaries, runtime architecture, or entry points:
  Read [`docs/architecture.md`](docs/architecture.md).
- Agent 执行通道调度（人工 TUI / 跨仓工单 Ticket-headless / OpenClaw ACP·Main /
  审查 headless）、`host-agent-invoke` 读写分档、或「统一什么 / 刻意不合什么」:
  Read [`docs/agent-scheduling.md`](docs/agent-scheduling.md)（平台知识；**不**放
  `openclaw/docs/`）。
- Env loading, secret placement, the `~/.config/shell-env.d/`
  convention, `runtime-env-lib.sh::runtime_env_load_managed`, or
  deciding whether a value belongs in `wezterm-x/local/shared.env`
  vs `~/.config/shell-env.d/`:
  Read [`docs/setup.md#env-loading-model`](docs/setup.md#env-loading-model).
- Agent-CLI launch chain, `agent-launcher.sh`, the `${WEZTERM_REPO}`
  placeholder used in `config/worktree-task.env`, or any path that
  spawns `claude` / `codex`:
  Read [`docs/architecture.md#startup-invariants`](docs/architecture.md#startup-invariants).
- Adversarial code review skill (find→refute→repro), cross-agent backend
  selection, the shared `lib/provider.sh` layer, per-stage reasoning effort,
  the no-session-resume rationale, or offline mock testing:
  Read [`docs/adversarial-review.md`](docs/adversarial-review.md).
- Multi-persona brainstorm skill (diverge→challenge→converge), persona/provider
  selection, per-stage effort, the no-resume design, or the offline mock harness:
  Read [`docs/brainstorm.md`](docs/brainstorm.md).
- Host-CLI invoke layers (one-way dependency):
  - **Single-shot:** `adversarial-review/lib/provider.sh` → `run_agent` /
    `agent_text` → plugin `__invoke` (no temp dir).
  - **Multi-shot / parallel:** `agent-fanout/lib/fanout-lib.sh`
    (`fanout_call` / `fanout_run` / `fanout_run_jobs`) + CLI `run.sh`.
  Fanout sources provider; provider never loads fanout. Do **not** hand-roll
  `claude & wait` or call `__invoke` from feature code. Offline smoke:
  `scripts/dev/agent-fanout/test.sh`. Notes:
  [`docs/adversarial-review.md`](docs/adversarial-review.md) /
  [`docs/brainstorm.md`](docs/brainstorm.md).
- Design proposal / RFC / ADR / 方案评审 (no runtime diff — **not** a dedicated
  skill): structured 设计评审 checklist and intent routing live in the
  user-level profile
  [`agent-profiles/v1/en/validation.md`](agent-profiles/v1/en/validation.md)
  (`Design proposal review`); also summarized under
  [`docs/adversarial-review.md`](docs/adversarial-review.md) (out of scope) and
  [`docs/brainstorm.md`](docs/brainstorm.md) (when alternatives are still needed).
- Host↔Claw session interop (Session Adapter Kit / `session-bridge`: list/read
  host tmux + claw sessions, gated `poke` / `host-send-keys` under lease, panic
  freeze, `bot-send` / `say-as-me` identities, attention merge, tmux side-load
  safety):
  Read [`openclaw/docs/session-bridge.md`](openclaw/docs/session-bridge.md).
- Personal OpenClaw control plane (Feishu gateway templates, main-agent
  protocol, link/smoke scripts — **not** the WezTerm/tmux execution hot path):
  Read [`openclaw/README.md`](openclaw/README.md) and
  [`openclaw/workspace/AGENTS.md`](openclaw/workspace/AGENTS.md).

## Hard Rules

- This repository is the source of truth.
- Treat `agent-profiles/` as hosted user-level profile source, not as the project-level instruction source for this repo.
- Windows runtime files are generated from this repo by `skills/wezterm-runtime-sync/scripts/sync-runtime.sh`. The `skills/wezterm-runtime-sync/` directory holds the workflow doc + scripts but is **not** a Claude Code Skill (it lives in the repo, not in `~/.claude/skills/`), so do not invoke it via the `Skill` tool — run the script directly with Bash.
- When agents run Windows-related scripts or smoke tests from WSL, prefer the repo-local wrappers and `scripts/dev/...` entrypoints in this repository over direct `cmd.exe` invocations or ad-hoc `powershell.exe -Command ...`.
- For Windows file inspection from agents, resolve runtime paths through `scripts/runtime/windows-runtime-paths-lib.sh` and then use WSL-native tools on the `*_WSL` paths instead of `cmd.exe /c dir`, `cmd.exe /c type`, or similar console commands.
- Keep workspace definitions in `wezterm-x/workspaces.lua`, not inline in `wezterm.lua`.
- Keep private machine and project overrides in `wezterm-x/local/` and keep tracked templates in `wezterm-x/local.example/`.
- User-level secrets (CNB tokens, third-party API keys, etc.) live under `~/.config/shell-env.d/<name>.env` — the canonical convention auto-discovered by both `~/.zshrc` and `scripts/runtime/runtime-env-lib.sh::runtime_env_load_managed`. Do not introduce new ad-hoc dotfile loaders that hardcode specific filenames; drop a file in `shell-env.d/` instead. Repo-machine config consumed by both Lua and shell stays in `wezterm-x/local/shared.env` (synced to Windows runtime). Full rules: [`docs/setup.md#env-loading-model`](docs/setup.md#env-loading-model).
- Every agent-CLI launch path must terminate at `scripts/runtime/agent-launcher.sh <profile>` — workspace first-open, `Alt+g` on-demand window, `refresh-current-window`, and tab-overflow cold-spawn all share this single env-loading site. Do not invoke `claude` / `codex` directly from a `tmux new-window` / `respawn-pane` call site or from a new `*_RESUME_COMMAND` in `config/worktree-task.env`. Shell paths that resolve the resume argv share `scripts/runtime/worktree/lib/resume-command.sh::resolve_managed_primary_command` (cold-spawn included — do not reimplement key lookup). The `${WEZTERM_REPO}` placeholder used in `worktree-task.env` is expanded in lockstep by `resume-command.sh` and `wezterm-x/lua/config/managed_cli.lua::parse_managed_cli_env`.
- Prefer updating an existing doc in `docs/` over adding a new sibling file; keep presentations under `docs/presentations/`. When a topic doc is already over the soft line budget (see `scripts/dev/repo-hygiene/budgets.conf`), split by decision domain instead of growing it further.

- Design user-facing features keyboard-first: every new or changed interaction must have a keyboard path, and mouse bindings are only acceptable as fallbacks (for example cross-pane text selection or quick pane focus). Weigh key ergonomics when picking a binding — reachability, OS- / IME-level hotkey conflicts (Ctrl+Space, Alt+Shift, etc.), chord depth, and whether the action already has a keyboard home in `docs/keybindings.md`.
- `wezterm-x/commands/manifest.json` is the single source of truth for every shortcut. Adding or renaming a hotkey means: (1) add / update the manifest item with a `binding` field; (2) for wezterm-layer bindings, add the named handler to `wezterm-x/lua/ui/action_registry.lua`; (3) for tmux-chord leaves, the `binding.exec` tmux-action string is everything — no code changes elsewhere; `scripts/runtime/render-tmux-bindings.sh` regenerates `wezterm-x/tmux/chord-bindings.generated.conf` during `wezterm-runtime-sync` and `tmux.conf` loads it via `source-file -Fq`. Do not re-declare keys or actions in `keymaps.lua` or `tmux.conf` directly; both are driven by the manifest now. Missing or unregistered ids show up as `(unregistered)` in `scripts/dev/hotkey-usage-report.sh` — treat that report as the audit signal.
- Per-machine user overrides live in `wezterm-x/local/keybindings.lua` keyed by manifest id (string → new key, `false` → disable, list → per-variant). The WezTerm side applies them at reload; the tmux-chord side applies them when the renderer runs. Template: `wezterm-x/local.example/keybindings.lua`. Full rules in `docs/keybindings.md`.
- If behavior, keybindings, workspace semantics, tmux UI, or diagnostics change, update the matching docs in the same edit.
- Markdown with mermaid diagrams: after editing a mermaid code block, run `scripts/dev/check-mermaid.sh` (validates every block via `mermaid.parse` under jsdom — real grammar check, no chromium; deps cached outside the repo). Do not hand-eyeball mermaid syntax. Commits also run this via `scripts/dev/repo-hygiene/` pre-commit when staged `.md` files change.
- Repo hygiene: install once with `scripts/dev/repo-hygiene/install-hooks.sh`. Every commit runs the L0 gate (broken relative doc links, `bash -n` on staged shells, mermaid on staged docs, secret heuristics, new/crossing line-budget violations). Full-repo report: `scripts/dev/repo-hygiene/run.sh audit`. Do not use `--no-verify` / `WEZTERM_HYGIENE_SKIP=1` except emergencies. Naming: this is **卫生审计**, not 对抗审查 / 设计评审. Details: [`docs/daily-workflow.md`](docs/daily-workflow.md#repo-hygiene).

- After runtime config changes, run `skills/wezterm-runtime-sync/scripts/sync-runtime.sh` (Bash, not the `Skill` tool — see the note above). **Default sync stages a canary tree, auto-launches an isolated WezTerm probe, and promotes to live only if `healthy.stamp` appears** (otherwise live is left untouched). Use `--live` to skip the gate; `WEZTERM_SYNC_SKIP_CANARY_AUTO=1` to stage without probing. Full flow: [`docs/daily-workflow.md`](docs/daily-workflow.md).
- Do not run Git commands that can contend on the index lock in parallel.
- Do not auto-commit or auto-push unless the user asks or the task explicitly calls for it.
- **Worktree maintenance:** linked `dev-*` trees are for **isolation**, not PRs.
  Finish a round by delivering **directly onto mainline** (`origin/HEAD` / primary
  `master` push or ff — **no pull request**), then **immediately** recycle so the
  `dev-*` tip **stays equal to** `origin/HEAD` (lagging `dev/*` is out of policy).
  Keep `WEZTERM_REPO` / platform skills / `agent-tools.env` on the primary tree.
  Detail:
  [`docs/workspaces.md#maintenance-loop-wezdeck-standing-policy`](docs/workspaces.md#maintenance-loop-wezdeck-standing-policy).
