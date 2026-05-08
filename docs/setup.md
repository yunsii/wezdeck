# Setup

Use this doc when you need prerequisites and local setup.

## Prerequisites

- `hybrid-wsl` uses the Windows WezTerm nightly build plus a WSL domain configured in `wezterm-x/local/constants.lua`.
- `posix-local` runs directly on Linux or macOS without a WSL domain.
- `tmux 3.6+` must be available in the runtime environment that will host managed project tabs. Required because the repo's `tmux.conf` advertises DEC mode 2026 (synchronized output) and tmux 3.4 deadlocks on stuck sync windows where 3.6's 1-second flush timeout does not. Ubuntu 24.04 LTS still ships 3.4, so build 3.6+ from source if your distro lags. Background, verification recipe, and the IME-flicker symptom that originally drove this requirement: [`ime-flicker-and-sync-output.md`](./ime-flicker-and-sync-output.md).
- `lua5.4` (or `lua5.3` / `lua`) **recommended** in the WSL/Linux side. Used by `wezterm-runtime-sync`'s `lua-precheck` step (`skills/wezterm-runtime-sync/scripts/lua-precheck.lua`) to dofile the synced `wezterm-x/lua/constants.lua` under a mocked `wezterm` module and assert that managed-launcher resolution still works (`default_profile` resolves, `default_resume_profile ≠ default_profile`, and the resume command contains a recognized sentinel — `--continue`, `resume`, or `agent-launcher.sh`). Without it, sync skips the precheck with a warning instead of failing — same surface that historically let `<base>-resume` vs `<base>_resume` mis-naming and unreachable WSL-path env files slip through to runtime. Install with `sudo apt install lua5.4` on Ubuntu/Debian.
- `jq` **recommended** in the WSL/Linux side. Used by the agent-attention state writer (`scripts/runtime/attention-state-lib.sh`), the focus emit path (`scripts/runtime/tmux-focus-emit.sh`), and the hotkey-usage telemetry (`scripts/runtime/hotkey-usage-bump.sh`); also opportunistically by `scripts/claude-hooks/emit-agent-status.sh` to extract `session_id` / `message` / `prompt` from hook payloads. Without it, the Claude hook still writes attention entries but keys them to `pane:<WEZTERM_PANE>` with canned per-status labels, and the other call sites take their respective degraded paths. Install with `sudo apt install jq` on Ubuntu/Debian.
- WakaTime status needs `python3` in that same runtime environment and a private `WAKATIME_API_KEY`. Drop it in `~/.config/shell-env.d/wakatime.env` (the canonical home for user-level secrets — see [Env Loading Model](#env-loading-model)) or, equivalently, in `wezterm-x/local/shared.env` if you prefer to keep it next to the rest of the repo-machine config. Both paths feed the unified loader; if both files set the key, `~/.config/shell-env.d/` wins.
- Repo-local helper wrappers such as `scripts/runtime/agent-clipboard.sh` require `hybrid-wsl`, `cmd.exe`, `powershell.exe`, `wslpath`, and a synced Windows helper runtime.
- In `hybrid-wsl` mode, `wezterm.exe` runs on Windows and its Lua cannot resolve WSL-native paths like `/home/yuns/...`, so `wezterm-runtime-sync` mirrors `config/worktree-task.env` into the runtime dir as `repo-worktree-task.env` (Windows-readable NTFS path) on every sync. Skipping a sync after editing `config/worktree-task.env` will leave wezterm.exe on the previous snapshot. Full pickup chain and the `<base>-resume` / `<base>_resume` naming asymmetry: see [`workspaces.md#behavior`](./workspaces.md#behavior).

## Local Setup

1. Copy `wezterm-x/local.example/` to `wezterm-x/local/`.
2. Edit `wezterm-x/local/constants.lua` for `runtime_mode`, runtime shell, UI variant, and OS-specific integrations such as `default_domain` or Chrome debug profile path.
3. Edit `wezterm-x/local/shared.env` for repo-machine config values consumed by both Lua and shell — `MANAGED_AGENT_PROFILE`, `WEZTERM_VSCODE_PROFILE`, and so on. For user-level secrets that should not be tied to a specific repo clone (CNB tokens, third-party API keys), prefer `~/.config/shell-env.d/<name>.env` instead — see [Env Loading Model](#env-loading-model) for the contract.
4. Edit `wezterm-x/local/workspaces.lua` for your private project directories.
5. Optionally create `~/.config/worktree-task/config.env` when you need to point globally installed `worktree-task` back at this checkout with `WEZDECK_REPO=/absolute/path` (legacy `WEZTERM_CONFIG_REPO=...` still accepted).
6. Optionally edit `wezterm-x/local/command-panel.sh` for machine-local tmux command palette entries exposed through `Ctrl+Shift+P`.
7. One-time: in VS Code, open Profiles → Import Profile → select `wezterm-x/local.example/vscode/ai-dev.code-profile` (or your customized `wezterm-x/local/vscode/ai-dev.code-profile`). `Alt+v` and `scripts/runtime/open-current-dir-in-vscode.sh` read `WEZTERM_VSCODE_PROFILE` from `wezterm-x/local/shared.env` (default `ai-dev`); set it to empty to use VS Code's default profile instead. After import, open the target WSL folder once in the new profile and click "Install in WSL" for each workspace extension you want enabled (GitLens, etc.) — VS Code tracks WSL-remote extensions per profile and does not replicate them automatically. The Windows helper's window-reuse key is `distro + folder`, not profile; if the folder is already open in another profile, `Alt+v` focuses that window instead of launching a new one — close the existing window first.
8. Recommended: source `scripts/runtime/tmux-status-prompt-hook.sh` from your shell rc so the tmux status line reflects local `git` commands immediately instead of lagging up to 30s on the fallback poll. See [Tmux Status Prompt Hook](#tmux-status-prompt-hook) for the source line and a verification command.

## File Boundaries

- `wezterm-x/workspaces.lua`: tracked shared workspace defaults
- `wezterm-x/local/workspaces.lua`: private directories and machine-local workspace overrides
- `wezterm-x/local/shared.env`: shared scalar values used by Lua and shell code (repo-machine scope)
- `wezterm-x/local/constants.lua`: machine-local structured Lua settings
- `wezterm-x/local.example/`: tracked templates for `wezterm-x/local/`
- `~/.config/shell-env.d/*.env`: user-level secrets and per-user env vars; auto-discovered by both `~/.zshrc` and `scripts/runtime/runtime-env-lib.sh::runtime_env_load_managed`. Mode 600 per file, dir mode 700.

## Env Loading Model

There is one unified env loader for managed-runtime shell scripts: `scripts/runtime/runtime-env-lib.sh`. Any agent / status / hook entry point that needs env should source it and call `runtime_env_load_managed`, which sources two layers in this order (later wins):

1. `wezterm-x/local/shared.env` — repo-machine config (synced to Windows runtime; consumed by both Lua and shell). Use for non-secret machine choices like `MANAGED_AGENT_PROFILE` and `WEZTERM_VSCODE_PROFILE`.
2. `${SHELL_ENV_DIR:-~/.config/shell-env.d}/*.env` in lex order — user-level secrets. Drop a new file there to add a secret; no loader edits, no rc-file edits. The same dir is sourced by `~/.zshrc`, so interactive zsh and machine-spawned agents share one source of truth.

The Lua side reads `shared.env` independently via `helpers.load_optional_env_file`; that is a structural cross-language constraint — Lua cannot call into bash — and is the only second loader implementation that exists.

| Genre | Goes in | Notes |
|---|---|---|
| User-level secret (CNB, OpenAI, …) | `~/.config/shell-env.d/<name>.env` | Mode 600. Files are auto-globbed. |
| Repo-machine config (Lua + shell) | `wezterm-x/local/shared.env` | Synced to Windows runtime. |
| Repo-machine shell init / functions | `wezterm-x/local/runtime-logging.sh`, `wezterm-x/local/command-panel.sh` | Sourced as bash, not as `.env`. |
| Repo-machine Lua tables | `wezterm-x/local/constants.lua`, `keybindings.lua`, `workspaces.lua` | Lua return-tables. |
| Repo-tracked config | `config/worktree-task.env` | Read literally — values may contain command strings. Never source. |

For agent-CLI launch chains specifically, `scripts/runtime/agent-launcher.sh` is the single env-loading site (it calls `runtime_env_load_managed` before exec'ing the agent). All four launch paths — workspace first-open, `Alt+g` on-demand window, `refresh-current-window`, tab-overflow cold-spawn — terminate at this launcher. See [`architecture.md#startup-invariants`](./architecture.md#startup-invariants) for the invariant statement.

## Repo-Local Runtime Wrappers

- When your automation can already resolve the repository root, prefer repo-local wrappers under `scripts/runtime/` over rebuilding helper IPC or Windows bootstrap logic.
- `scripts/runtime/agent-clipboard.sh` is the current agent-facing clipboard wrapper. It stays in WSL, ensures the Windows helper is healthy, and then writes text or an image file to the Windows clipboard.
- If that wrapper reports that the helper bootstrap is missing, sync the runtime first, then rerun the command.
- `sync-runtime.sh` writes `$HOME/.wezterm-x/agent-tools.env` on the **WSL user home**, not on the Windows-side wezterm runtime target home. Windows-side processes do not consume this file — its only readers are WSL-resident agents (Claude Code, Codex CLI, etc.) that need to discover repo-local wrappers without inferring paths.
- Read `agent_clipboard` from `$HOME/.wezterm-x/agent-tools.env` instead of inferring wrapper paths from the current task repository or AGENTS symlinks. Schema and contract: [agent-tools.env schema](#agent-toolsenv-schema) below.

### `agent-tools.env` schema

- **Location**: `$HOME/.wezterm-x/agent-tools.env` on the WSL user home that ran `sync-runtime.sh`. In `posix-local` mode the WSL home and the wezterm-runtime target home coincide; in `hybrid-wsl` they diverge (the wezterm runtime lands at `%USERPROFILE%\.wezterm-x\` while the marker stays on `/home/<user>/.wezterm-x/`).
- **Format**: UTF-8 text, one `key=value` per line. Written via temp+rename by `sync-runtime.sh::write_agent_tools_file`, so consumers either see the previous full file or the new full file — never a partial read.
- **Keys**:
  - `version` — schema version, currently `1`. Bump on incompatible key changes; consumers should refuse unknown major versions.
  - `repo_root` — absolute path to the wezterm-config clone that produced this marker. Lets external agents resolve sibling resources in the same clone (e.g. other scripts under `scripts/runtime/`).
  - `agent_clipboard` — absolute path to `scripts/runtime/agent-clipboard.sh`. Bash script; callable only from WSL. Writes text or an image file to the Windows clipboard via host-helper named-pipe IPC.
- **Sample**:

  ```ini
  version=1
  repo_root=/home/yuns/github/wezterm-config
  agent_clipboard=/home/yuns/github/wezterm-config/scripts/runtime/agent-clipboard.sh
  ```

- **Discovery contract**:
  - Existence of the file means "wezterm-config host-effects shipped this WSL home". Absent file → consumer must treat host-side wrappers as unavailable, **not** fall back to raw `clip.exe` / `pbcopy` / `xclip` / `Set-Clipboard`. The naive WSL → `clip.exe` path produces CJK mojibake (stdin reinterpreted under the system ANSI codepage, e.g. CP936/GBK on Chinese Windows). Manual `iconv -f UTF-8 -t UTF-16LE` + BOM piping can technically fix the encoding, but the raw binaries still only handle text — no image DIB/PNG dual-write, no STA threading, no helper trace_id / format negotiation — so re-implementing per call site is strictly worse than treating the capability as unavailable.
  - Before invoking a wrapper, the consumer must verify the referenced path still exists and is executable. A stale marker pointing at a deleted clone is "capability unavailable", not a fatal error.
  - Do not infer wrapper paths from anywhere else — not the current task repository, AGENTS symlinks, `which`, or environment variables. The marker is the single discovery surface.

## Windows Launch Hotkey

For `hybrid-wsl` on Windows, pin WezTerm to the taskbar together with the two apps you reach most often so the built-in `Win+N` shortcut can launch or focus them without a background hotkey daemon. Recommended layout:

- `Win+1`: WezTerm
- `Win+2`: primary browser
- `Win+3`: primary IM client (Feishu, Slack, Teams, etc.)

Pin each app, then drag the icons so WezTerm sits in slot 1, the browser in slot 2, and the IM client in slot 3. The binding survives reboots, needs no extra tooling, and stays out of the in-WezTerm keymap documented in [`keybindings.md`](./keybindings.md).

## Claude Agent Attention Hooks

Hook install / upgrade template, "what each hook does", verification, and Codex integration live in [`agent-attention.md#hook-installation`](./agent-attention.md#hook-installation). The hook script ships in this repo at `scripts/claude-hooks/emit-agent-status.sh`.

## Tmux Status Prompt Hook

This is a **recommended** part of local setup. The tmux status line polls git state on a 30-second timer and refreshes when you switch pane, window, or client. Neither path fires right after you run a `git` command from the shell, so branch and change counters can lag up to 30s behind reality. The prompt hook closes that gap: every time the shell returns to the prompt, it asks tmux to force-refresh (debounced to 2s by `@tmux_status_force_debounce`, so rapid commands do not stampede).

The hook ships at `scripts/runtime/tmux-status-prompt-hook.sh`. It is safe to re-source, a no-op outside tmux, and self-locates through the tmux `@wezterm_runtime_root` option so the sourcing line does not hardcode a repo path. Add one line to your shell rc:

```sh
# ~/.zshrc (zsh) or ~/.bashrc (bash)
[ -n "$TMUX" ] && . /home/yuns/github/wezterm-config/scripts/runtime/tmux-status-prompt-hook.sh
```

Substitute the absolute path for your clone if different. Existing shells also need `source ~/.zshrc` (or a restart) to pick up the new line.

Verify the hook is active from a tmux pane running the shell you configured:

```sh
typeset -f __tmux_status_prompt_refresh >/dev/null && echo ok || echo missing
```

If it prints `missing`, the rc did not source the hook. Without the hook, the 30s poll and pane-switch hooks keep working unchanged, so `git` state can lag up to 30s before the status line updates.

The same gap exists for file edits driven by Claude Code (Edit / Write / Bash `git …`) — the shell prompt is not in the loop, so the prompt hook never fires. The agent-side counterpart lives in the Claude install template at [`agent-attention.md#install--update`](./agent-attention.md#install--update): a second hook entry under `PostToolUse` and `Stop` backgrounds the same `tmux-status-refresh.sh --force --refresh-client` after every tool call and at turn end, sharing the 2s `@tmux_status_force_debounce` window with this prompt hook.

## IME State Indicator

In `hybrid-wsl` the WezTerm right status bar renders a compact IME state badge so keyboard-first interactions (chord prefixes, `y/n` confirmations, single-letter shortcuts) do not have to guess which input mode is active.

The badge reflects what the Windows host-helper reads from the foreground window, not WezTerm's internal `use_ime` flag:

- `中`: a CJK IME is loaded and currently in native composition mode (about to produce Chinese/Japanese/Korean characters).
- `英`: a CJK IME is loaded but the user has toggled the IME itself to English mode (typically via `Shift` on Microsoft Pinyin, Sogou, QQ, etc.).
- `EN`: the active keyboard layout is a non-CJK language (e.g. `en-US`); IMM composition is not in play.
- `中?` (italic, dim): the helper is unreachable or the IME did not expose a conversion state. Usually transient while the helper is restarting.

The badge is hidden entirely in `posix-local` because no Windows host-helper is running to query IMM. On Windows the helper pulls state via `GetForegroundWindow` → `GetKeyboardLayout` → `ImmGetConversionStatus`, so tapping `Shift` (or your IME's own toggle key) updates the badge within the next `update-status` tick. There is no WezTerm-managed override: the OS IME and this badge agree by construction.

## Windows Script Execution

- For Windows-facing shell automation in this repo, source `scripts/runtime/windows-shell-lib.sh` and run PowerShell through `windows_run_powershell_script_utf8` or `windows_run_powershell_command_utf8`.
- Prefer checked-in `.ps1` entrypoints over ad-hoc inline `powershell.exe -Command ...`; when inline PowerShell is unavoidable, keep the body inside the shared UTF-8 wrapper instead of calling `powershell.exe` directly.
- Do not use `cmd.exe /c dir`, `cmd.exe /c type`, or similar commands for file inspection. Resolve the Windows runtime paths with `scripts/runtime/windows-runtime-paths-lib.sh`, convert to WSL paths there, and then use WSL-native tools such as `ls`, `cat`, and `rg`.
- Keep `cmd.exe` usage limited to ASCII-safe environment discovery such as `%LOCALAPPDATA%` or `%USERPROFILE%`.

## Maintainer Setup

This section applies **only to maintainers** who cut releases or develop the native components (Windows host-helper / Go popup picker). Regular contributors and end users can skip it — the prerequisites above are sufficient for daily use, since native components ship as prebuilt binaries via [`host-helper-release.md`](./host-helper-release.md) and [`picker-release.md`](./picker-release.md). End users without a Go or .NET toolchain still get the fast Go picker through the release-manifest fetcher in `native/picker/build.sh` (auto mode).

- `gh` (GitHub CLI) **required** for the release flow in [`host-helper-release.md`](./host-helper-release.md). It pushes tags, watches the release workflow, merges the auto-generated manifest-update PR, and toggles the repo Actions permission described below. Install with `sudo apt install gh` on Ubuntu/Debian, `brew install gh` on macOS, or follow <https://cli.github.com/>. After install, authenticate once with `gh auth login` and verify with `gh auth status`.
- Repo `Settings → Actions → General → Workflow permissions` must have **Allow GitHub Actions to create and approve pull requests** enabled, otherwise the release workflow's `update-manifest` job fails its final step with `GitHub Actions is not permitted to create or approve pull requests`. The release archive is still published, but the manifest-update PR has to be opened manually. Enable from the CLI (one-time per repo):

  ```bash
  gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow \
    -f default_workflow_permissions=read \
    -F can_approve_pull_request_reviews=true
  ```

  Verify with `gh api repos/<owner>/<repo>/actions/permissions/workflow` — the response should include `"can_approve_pull_request_reviews": true`. The `default_workflow_permissions` field is unrelated; the release workflow declares its own `permissions:` block, so leave whatever value is already set.
- `go 1.21+` in the WSL/Linux side. **Required** for maintainers iterating on `native/picker/` source — `native/picker/build.sh` builds the static `native/picker/bin/picker` ELF that powers the three high-frequency tmux popups: `Alt+/` (attention), `Alt+g` (worktree), and `Ctrl+Shift+P` (command palette). `wezterm-runtime-sync`'s `build-picker` step (`native/picker/build.sh`, invoked from `skills/wezterm-runtime-sync/scripts/sync-runtime.sh`) auto-discovers `go` in `PATH` → `~/.local/go/bin/go` → `/usr/local/go/bin/go`. End users without Go are covered by the release-fetcher in the same script: with the default `WEZTERM_PICKER_INSTALL_SOURCE=auto`, a missing Go toolchain falls through to the prebuilt tarball pinned in `native/picker/release-manifest.json`, sha256-verified and extracted into `native/picker/bin/picker`; cache lives at `${WEZDECK_PICKER_CACHE:-$XDG_CACHE_HOME/wezdeck/picker}/<version>`. Force a specific source with `WEZTERM_PICKER_INSTALL_SOURCE=local|release`. Only direct Go dep is `golang.org/x/term`. Install Go with `sudo apt install golang-go` on Ubuntu 24.04+ (ships ≥ 1.22), or download from <https://go.dev/dl/> into `~/.local/go`. After install, run `wezterm-runtime-sync` once and confirm `native/picker/bin/picker` exists and the sync trace logs `step=build-picker status=completed`. Bash fallback (`tmux-attention-picker.sh`, `tmux-worktree-picker.sh`, `tmux-command-picker.sh`) only kicks in when both source modes fail (~30-80ms vs ~2-5ms, per `docs/performance.md`). Full source-toggle semantics: [`picker-release.md#install-path`](./picker-release.md#install-path).
- `dotnet 8.0+` SDK on Windows **required** to build `native/host-helper/windows/...` locally and to verify the local-build install path with `WEZTERM_WINDOWS_HELPER_INSTALL_SOURCE=local` ([`host-helper-release.md#forcing-the-release-path-locally`](./host-helper-release.md#forcing-the-release-path-locally)). Not required for cutting releases — the GitHub Actions runner installs its own SDK via `actions/setup-dotnet@v4`. Install from <https://dotnet.microsoft.com/download/dotnet/8.0>, or with `winget install Microsoft.DotNet.SDK.8`. Verify with `dotnet --list-sdks` from a PowerShell prompt.

## Read Next

- Workspace semantics and config shape:
  Read [`workspaces.md`](./workspaces.md).
- Sync, reload, and verification:
  Read [`daily-workflow.md`](./daily-workflow.md).
- Runtime ownership and entry points:
  Read [`architecture.md`](./architecture.md).
