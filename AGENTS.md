# AGENTS

This file is the project-level agent entry point.
User-level reusable agent profiles hosted under `agent-profiles/` are separate and do not override this file unless a user explicitly points an external tool at them.

## Loading Rule

Read `AGENTS.md` first, then open only the matching file under `docs/`. Read additional docs only when the current doc points to them or the task crosses that boundary.

## Design stance

Control plane, not a hotkey dump. Every new/changed interaction must be
(1) **keyboard-first**, (2) **headless-verify for agents** (CDP without stealing
focus), (3) **observable** — leave reviewable signals (badge / category
log·latency / timeline·habit). **Blind features are incomplete.** Summary:
[`README.md#design-stance`](README.md#design-stance). Operator:
[`docs/diagnostics.md`](docs/diagnostics.md). Emit:
[`docs/logging-conventions.md`](docs/logging-conventions.md).

## Task Routing

One line per topic: the trigger words, then the doc. Details live in the doc.

- Setup, prerequisites, machine-local config → [`docs/setup.md`](docs/setup.md);
  env loading / secrets (`~/.config/shell-env.d/`, `runtime_env_load_managed`,
  `shared.env`) → [`docs/setup.md#env-loading-model`](docs/setup.md#env-loading-model).
- Human-only script handoff (`wd-run` / `x`, propose → ready → wait, no
  multi-line paste; agent self-exec is out of scope) →
  [`docs/agent-run.md`](docs/agent-run.md).
- Sync, reload, verification, maintenance, **落地上线** →
  [`docs/daily-workflow.md`](docs/daily-workflow.md); web UI bug loop (reproduce on
  the device with `wezdeck-wsl diag`, `red-green.sh`, check `current` before a
  retest) → [`#verification`](docs/daily-workflow.md#verification)
  ([Commit / land](docs/daily-workflow.md#commit--land-wezdeck-standing-policy));
  repo hygiene (budgets, links, pre-commit, `run.sh audit`) →
  [`#repo-hygiene`](docs/daily-workflow.md#repo-hygiene).
- Renames, compatibility layers, keeping an old interface →
  [`docs/compatibility-policy.md`](docs/compatibility-policy.md).
- Capability sources, user-level links, agent profiles, `WEZDECK_REPO`, upstream
  skills → [`docs/skill-sources.md`](docs/skill-sources.md).
- 「重置开发分支」 / recycle a checkout or workstation onto `origin/HEAD` / next round →
  [`worktree-task recycle`](scripts/runtime/worktree/worktree-task) (not hand-rolled
  `git reset`; `--fresh-agent` for a blank round) —
  [`docs/workspaces.md`](docs/workspaces.md#recycle-primary-or-workstation-round-reset).
- Workspaces → [`docs/workspaces.md`](docs/workspaces.md); keybindings →
  [`docs/keybindings.md`](docs/keybindings.md).
- tmux UI, titles, status, copy-mode → [`docs/tmux-ui.md`](docs/tmux-ui.md):
  Vim in tmux (page-skip scroll, `@` rows, `'termsync'`, `Shift+drag`) →
  [`#vim-in-tmux`](docs/tmux-ui.md#vim-in-tmux); Grok Build TUI (focus flash,
  focus-filter wrapper, `grok update` heal, wheel feel, follow ▼ click) →
  [`#grok-build-in-tmux`](docs/tmux-ui.md#grok-build-in-tmux); Claude Code
  fullscreen TUI and wheel speed → [`#claude-code-in-tmux`](docs/tmux-ui.md#claude-code-in-tmux).
- Appearance presets (`opaque` / `frosted`, backdrop, opacity) →
  [`docs/appearance-presets.md`](docs/appearance-presets.md).
- tmux vs herdr, tmux 3.8 borrow list, control mode →
  [`docs/multiplexer-comparison.md`](docs/multiplexer-comparison.md).
- Agent attention (hooks, attention.json, badges, auto-ack, `Alt+j` / `Alt+k`
  / `Alt+l` / `Alt+/`, Codex) → [`docs/agent-attention.md`](docs/agent-attention.md).
- Reminders (cron tmux popups, `reminder.sh`, crontab) →
  [`docs/reminders.md`](docs/reminders.md).
- Phone / Android via OpenClaw, Termux → [`docs/mobile-access.md`](docs/mobile-access.md).
- Web console PWA (service worker, layouts, navigation, Web Push) →
  [`docs/web-pwa.md`](docs/web-pwa.md); motion spec (tokens, `.list-row`,
  sticky prompt, split switches) → [`docs/web-motion.md`](docs/web-motion.md).
- Remote web console (`wezdeck.yuns.love`, HostRelay, `wezdeck-wsl relay`,
  WebRTC / WebSocket, pairing, `wezdeck-release.sh`, test stack, frame probe) →
  [`docs/remote-access.md`](docs/remote-access.md); what it sees and does in
  sessions, repo to-dos → [`docs/remote-sessions.md`](docs/remote-sessions.md).
- Laggy Pad / phone remote control (link → office → router → host; OPPO 互联
  is a contrib plugin, `contrib/plugins/oppo-remote`, its own `docs/oppo.md`) → [`docs/remote-input-stickiness.md`](docs/remote-input-stickiness.md).
- Browsers (slot / backend / everyday, debug Chrome, `Alt+b`, profiles,
  `ego` \| `cdp` backend) → [`docs/browser-debug.md`](docs/browser-debug.md).
- Releases: Windows runtime → [`docs/wezdeck-runtime-release.md`](docs/wezdeck-runtime-release.md);
  Go picker → [`docs/picker-release.md`](docs/picker-release.md).
- Diagnostics, logs, smoke tests, counters → [`docs/diagnostics.md`](docs/diagnostics.md);
  open questions (record new ones there, not only in a commit body) →
  [`#open-questions`](docs/diagnostics.md#open-questions); adding a log callsite →
  [`docs/logging-conventions.md`](docs/logging-conventions.md).
- 开发习惯周报 → repo skill [`habit-weekly`](skills/habit-weekly/SKILL.md)
  (`scripts/dev/habit-report.sh`; not `coco-weekly-report`).
- Guest OOM, reclaim livelock, `Memory·` / `LoadAvg·` badges, host vs guest
  memory → [`docs/guest-oom.md`](docs/guest-oom.md); host disk, `ext4.vhdx`
  compaction, `SystemDisk·` / `WslDisk·` → [`docs/host-disk.md`](docs/host-disk.md).
- Cross-host failures (Windows, WSL, DNS, VPN, shells, agent CLIs, silent exit,
  `Failed to translate`) →
  [`docs/development-environment-troubleshooting.md`](docs/development-environment-troubleshooting.md).
- Performance (Alt+/ popup, state-file routing, benches, sync hot path) →
  [`docs/performance.md`](docs/performance.md); IME / DEC 2026 / tmux 3.7+ /
  render flicker → [`docs/ime-flicker-and-sync-output.md`](docs/ime-flicker-and-sync-output.md).
- Signals into WezTerm Lua (OSC vs file, new events) → [`docs/event-bus.md`](docs/event-bus.md);
  tab focus stats / top-N slots → [`docs/tab-visibility.md`](docs/tab-visibility.md);
  plugins (`plugin.json`, badges, samplers) → [`docs/plugin-architecture.md`](docs/plugin-architecture.md).
- Architecture, ownership, entry points → [`docs/architecture.md`](docs/architecture.md);
  agent-CLI launch chain (`agent-launcher.sh`, `${WEZDECK_REPO}`) →
  [`#startup-invariants`](docs/architecture.md#startup-invariants).
- Agent 执行通道调度、`host-agent-invoke` 读写分档、票仓协议 vs 多目录挂载 →
  [`docs/agent-scheduling.md`](docs/agent-scheduling.md); cross-repo tickets
  (`ticket api`, runs, metrics) → [`docs/collab.md`](docs/collab.md).
- Adversarial review → [`docs/adversarial-review.md`](docs/adversarial-review.md);
  brainstorm → [`docs/brainstorm.md`](docs/brainstorm.md). Host-CLI invoke is
  one-way: single-shot `adversarial-review/lib/provider.sh`, multi-shot
  `agent-fanout/lib/fanout-lib.sh` (sources provider, never the reverse); no
  hand-rolled `claude & wait`, no `__invoke` from feature code.
- Design proposal / RFC / ADR / 方案评审 → `Design proposal review` in
  [`agent-profiles/v1/en/validation.md`](agent-profiles/v1/en/validation.md).
- Host↔Claw session interop (`session-bridge`) →
  [`openclaw/docs/session-bridge.md`](openclaw/docs/session-bridge.md); OpenClaw
  control plane → [`openclaw/README.md`](openclaw/README.md),
  [`openclaw/workspace/AGENTS.md`](openclaw/workspace/AGENTS.md).

## Hard Rules

- This repository is the source of truth.
- Treat `agent-profiles/` as hosted user-level profile source, not as the project-level instruction source for this repo.
- Windows runtime files are generated from this repo by `skills/wezdeck-runtime-ops/scripts/sync-runtime.sh`. The `skills/wezdeck-runtime-ops/` directory holds the workflow doc + scripts but is **not** a Claude Code Skill (it lives in the repo, not in `~/.claude/skills/`), so do not invoke it via the `Skill` tool — run the script directly with Bash.
- When agents run Windows-related scripts or smoke tests from WSL, prefer the repo-local wrappers and `scripts/dev/...` entrypoints in this repository over direct `cmd.exe` invocations or ad-hoc `powershell.exe -Command ...`.
- For Windows file inspection from agents, resolve runtime paths through `scripts/runtime/windows-runtime-paths-lib.sh` and then use WSL-native tools on the `*_WSL` paths instead of `cmd.exe /c dir`, `cmd.exe /c type`, or similar console commands.
- Keep workspace definitions in `wezterm-x/workspaces.lua`, not inline in `wezterm.lua`.
- Keep private machine and project overrides in `wezterm-x/local/` and keep tracked templates in `wezterm-x/local.example/`.
- User-level secrets (CNB tokens, third-party API keys, etc.) live under `~/.config/shell-env.d/<name>.env`. Managed agents glob it via `runtime_env_load_managed`; interactive zsh does too only after the one-time `wezdeck:shell-env.d` snippet ([`docs/setup.md#interactive-zsh-shell-envd`](docs/setup.md#interactive-zsh-shell-envd)). Do not add ad-hoc filename loaders. Repo-machine Lua+shell config stays in `wezterm-x/local/shared.env`. Full rules: [`docs/setup.md#env-loading-model`](docs/setup.md#env-loading-model).
- Every agent-CLI launch path must terminate at `scripts/runtime/agent-launcher.sh <profile>` — workspace first-open, `Alt+g` on-demand window, `refresh-current-window`, and tab-overflow cold-spawn all share this single env-loading site. Do not invoke `claude` / `codex` directly from a `tmux new-window` / `respawn-pane` call site or from a new `*_RESUME_COMMAND` in `config/worktree-task.env`. Shell paths that resolve the resume argv share `scripts/runtime/worktree/lib/resume-command.sh::resolve_managed_primary_command` (cold-spawn included — do not reimplement key lookup). The `${WEZDECK_REPO}` placeholder used in `worktree-task.env` is expanded in lockstep by `resume-command.sh` and `wezterm-x/lua/config/managed_cli.lua::parse_managed_cli_env`.
- Prefer updating an existing doc in `docs/` over adding a new sibling file; keep presentations under `docs/presentations/`. When a topic doc is already over the soft line budget (see `skills/repo-hygiene/budgets.conf`), split by decision domain instead of growing it further.

- Design user-facing features keyboard-first: every new or changed interaction must have a keyboard path, and mouse bindings are only acceptable as fallbacks (for example cross-pane text selection or quick pane focus). Weigh key ergonomics when picking a binding — reachability, OS- / IME-level hotkey conflicts (Ctrl+Space, Alt+Shift, etc.), chord depth, and whether the action already has a keyboard home in `docs/keybindings.md`.
- Design for an **observable development process** (stance #3): new/changed hot paths must leave reviewable signals (state-transition/outcome category rows; threshold-gated latency when input-feel matters; badges or `workflow-timeline` / `habit-report` when glance or day/week reconstruction is needed). Prefer existing categories / status segments / projectors over ad-hoc prints. Blind behavior changes are incomplete. Detail: [`docs/logging-conventions.md`](docs/logging-conventions.md) · [`docs/diagnostics.md`](docs/diagnostics.md).
- `wezterm-x/commands/manifest.json` is the single source of truth for every shortcut. Adding or renaming a hotkey means: (1) add / update the manifest item with a `binding` field; (2) for wezterm-layer bindings, add the named handler to `wezterm-x/lua/ui/action_registry.lua`; (3) for tmux-chord leaves, the `binding.exec` tmux-action string is everything — no code changes elsewhere; `scripts/runtime/render-tmux-bindings.sh` regenerates `wezterm-x/tmux/chord-bindings.generated.conf` during `wezdeck-runtime-ops` and `tmux.conf` loads it via `source-file -Fq`. Do not re-declare keys or actions in `keymaps.lua` or `tmux.conf` directly; both are driven by the manifest now. Missing or unregistered ids show up as `(unregistered)` in `scripts/dev/hotkey-usage-report.sh` — treat that report as the audit signal.
- Per-machine user overrides live in `wezterm-x/local/keybindings.lua` keyed by manifest id (string → new key, `false` → disable, list → per-variant). The WezTerm side applies them at reload; the tmux-chord side applies them when the renderer runs. Template: `wezterm-x/local.example/keybindings.lua`. Full rules in `docs/keybindings.md`.
- If behavior, keybindings, workspace semantics, tmux UI, or diagnostics change, update the matching docs in the same edit.
- Markdown with mermaid diagrams: after editing a mermaid code block, run `scripts/dev/check-mermaid.sh` (validates every block via `mermaid.parse` under jsdom — real grammar check, no chromium; deps cached outside the repo). Do not hand-eyeball mermaid syntax. Commits also run this via `skills/repo-hygiene/` pre-commit when staged `.md` files change.
- Repo hygiene: install once with `skills/repo-hygiene/install-hooks.sh`. Every commit runs the L0 gate (broken relative doc links, `bash -n` on staged shells, mermaid on staged docs, secret heuristics, new/crossing line-budget violations, and `README.md` ↔ `README.zh-CN.md` structural parity when either is staged). Full-repo report: `skills/repo-hygiene/run.sh audit`. Do not use `--no-verify` / `WEZTERM_HYGIENE_SKIP=1` except emergencies. Naming: this is **卫生审计**, not 对抗审查 / 设计评审. Details: [`docs/daily-workflow.md`](docs/daily-workflow.md#repo-hygiene).

- After runtime config changes, run `skills/wezdeck-runtime-ops/scripts/sync-runtime.sh` (Bash, not the `Skill` tool — see the note above). **Default sync stages a canary tree, auto-launches an isolated WezTerm probe, and promotes to live only if `healthy.stamp` appears** (otherwise live is left untouched). Use `--live` to skip the gate; `WEZTERM_SYNC_SKIP_CANARY_AUTO=1` to stage without probing. Full flow: [`docs/daily-workflow.md`](docs/daily-workflow.md).
- Do not run Git commands that can contend on the index lock in parallel.
- **落地上线（本仓 standing）：** 一轮可交付改动做完且验证过、用户未要求「先别提交 / 分步实现 / 等我确认」时，agent **自行** `coco-commit` → push 到 `origin` 默认分支 → 若触及 runtime/skill/CLI/同步面则跑 `sync-runtime.sh` → 若触及 `web/` 或 `native/wezdeck-wsl/` 则跑 `scripts/dev/wezdeck-release.sh` 发布网页与 relay（同样不等「上线」）。例外与细节：[`docs/daily-workflow.md#commit--land-wezdeck-standing-policy`](docs/daily-workflow.md#commit--land-wezdeck-standing-policy)。用户明确叫停或仍处 plan/分步未收口时，不要自动提交推送。
- **Default-branch delivery:** this repo develops on primary `master`. When
  committing and/or pushing and HEAD is already `master`/`main` (or the
  resolved default), **do it there** — do **not** ask whether to create a
  feature branch vs continue on the default branch (any commit helper that
  prompts that way is overridden here). Still ask on detached HEAD,
  mid-rebase/merge, or when the user explicitly wants a branch; force-push /
  history rewrite still needs explicit yes.
- **Worktree maintenance:** workstations (linked worktrees, one per direction) are for **isolation**, not PRs.
  Finish a round by delivering **directly onto mainline** (`origin/HEAD` / primary
  `master` push or ff — **no pull request**), then **immediately** recycle so the
  workstation's `dev/<name>` tip **stays equal to** `origin/HEAD` (lagging is out of policy).
  Keep `WEZDECK_REPO` / platform skills / `agent-tools.env` on the primary tree.
  Detail:
  [`docs/workspaces.md#maintenance-loop-wezdeck-standing-policy`](docs/workspaces.md#maintenance-loop-wezdeck-standing-policy).
