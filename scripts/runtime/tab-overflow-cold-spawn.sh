#!/usr/bin/env bash
# Cold-session bring-up for the overflow tab. Called when the Alt+t
# picker selects an `○` cold item (configured in workspaces.lua but
# without a live tmux session). Creates a managed tmux session for the
# given cwd via the same `open-project-session.sh` path the visible
# tabs use, then switch-clients the overflow pane to it.
#
# Usage: tab-overflow-cold-spawn.sh <workspace> <cwd>
#
# Resolution shape mirrors the lua side: read worktree-task.env (the
# tracked managed_cli profile registry) + wezterm-x/local/shared.env
# (the per-machine MANAGED_AGENT_PROFILE selection), prefer the
# `<base>_resume` variant when the profile defines one (matches lua's
# default_resume_profile resolution in constants.lua), and fall back to
# the bare profile command. open-project-session.sh accepts the resolved
# argv as its `[command...]` and wraps it in primary-pane-wrapper.sh,
# which gives the same two-pane layout (left agent, right shell) as a
# fresh visible tab.
set -u

workspace="${1:?missing workspace}"
cwd="${2:?missing cwd}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
# shellcheck disable=SC1091
. "$script_dir/wezterm-event-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/tmux-worktree-lib.sh" 2>/dev/null || {
  printf '[tab-overflow-cold-spawn] tmux-worktree-lib unavailable\n' >&2
  exit 1
}

session_name="$(tmux_worktree_session_name_for_path "$workspace" "$cwd" 2>/dev/null || true)"
if [[ -z "$session_name" ]]; then
  printf '[tab-overflow-cold-spawn] could not compute session name for %s\n' "$cwd" >&2
  exit 1
fi

# If the session is already up (raced with another spawn), skip create
# and go straight to attach + activate.
if tmux has-session -t "$session_name" 2>/dev/null; then
  if ! bash "$script_dir/tab-overflow-attach.sh" "$workspace" "$session_name"; then
    printf '[tab-overflow-cold-spawn] tab-overflow-attach.sh failed\n' >&2
    exit 3
  fi
  WEZTERM_EVENT_FORCE_FILE=1 \
    wezterm_event_send "tab.activate_overflow" \
      "v1|workspace=${workspace}|session=${session_name}" || true
  exit 0
fi

# Resolve the managed agent argv from worktree-task.env + shared.env.
# These files cannot be `source`-d safely — `worktree-task.env` carries
# values like `codex -c 'tui.theme="github"'` that bash treats as a
# command invocation under set-a / dot-source. Use a literal key=value
# reader instead (the lua side has its own parser via
# wezterm-x/lua/config/managed_cli.parse_managed_cli_env, which mirrors
# the same shape).
read_env_var() {
  local file="$1" key="$2" line raw
  [[ -f "$file" ]] || return 1
  line="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1)"
  [[ -n "$line" ]] || return 1
  raw="${line#${key}=}"
  # Strip a single layer of single OR double quotes.
  if [[ "${raw:0:1}" == "'" && "${raw: -1}" == "'" ]]; then
    raw="${raw:1:${#raw}-2}"
  elif [[ "${raw:0:1}" == '"' && "${raw: -1}" == '"' ]]; then
    raw="${raw:1:${#raw}-2}"
  fi
  printf '%s' "$raw"
}

shared_env="$repo_root/wezterm-x/local/shared.env"
worktree_env="$repo_root/config/worktree-task.env"
profile="$(read_env_var "$shared_env" MANAGED_AGENT_PROFILE 2>/dev/null || true)"
[[ -z "$profile" ]] && profile="$(read_env_var "$worktree_env" WT_PROVIDER_AGENT_PROFILE 2>/dev/null || true)"
[[ -z "$profile" ]] && profile="claude"
upper="$(printf '%s' "$profile" | tr '[:lower:]-' '[:upper:]_')"
agent_command_str="$(read_env_var "$worktree_env" "WT_PROVIDER_AGENT_PROFILE_${upper}_RESUME_COMMAND" 2>/dev/null || true)"
[[ -z "$agent_command_str" ]] && \
  agent_command_str="$(read_env_var "$worktree_env" "WT_PROVIDER_AGENT_PROFILE_${upper}_COMMAND" 2>/dev/null || true)"
[[ -z "$agent_command_str" ]] && agent_command_str="$profile"

# Mirror resume-command.sh's ${WEZTERM_REPO} expansion: worktree-task.env
# uses the placeholder so resume commands can reference repo-internal
# scripts (agent-launcher.sh) without an absolute path; this cold-spawn
# path bypasses resume-command.sh's resolver, so we expand here too.
agent_command_str="${agent_command_str//\$\{WEZTERM_REPO\}/$repo_root}"

# Split into argv. open-project-session.sh's build_primary_shell_command
# quotes each element with %q, so the result is a single primary command
# string that primary-pane-wrapper.sh execs. The lua side parses these
# values with config/managed_cli.parse_command_spec, which honors POSIX
# single/double quoting — we need the shell side to match so resume
# wrappers like `sh -c 'claude --continue || exec claude'` survive
# tokenization. xargs is POSIX-quote aware (single AND simple double
# quotes); fall back to naïve whitespace split when xargs rejects the
# input (e.g. nested quoting in codex DARK variant) so the cold-spawn
# path at least matches the prior behavior instead of failing outright.
agent_argv=()
if tokens_output="$(printf '%s\n' "$agent_command_str" | xargs -n1 printf '%s\n' 2>/dev/null)" \
   && [[ -n "$tokens_output" ]]; then
  while IFS= read -r token; do
    [[ -n "$token" ]] && agent_argv+=("$token")
  done <<< "$tokens_output"
fi
if (( ${#agent_argv[@]} == 0 )); then
  read -ra agent_argv <<< "$agent_command_str"
fi

# Spawn open-project-session.sh in a fully detached background process.
# The script's tail does `exec tmux attach-session` which fails without
# a controlling tty — but `tmux new-session -d` runs first and creates
# the session, so we still get the managed two-pane layout. setsid +
# the closed std streams keep the child from holding our stdio.
#
# Strip WEZTERM_PANE before invoking. The picker popup (tmux display-
# popup) inherits WEZTERM_PANE from whichever wezterm pane the user
# pressed Alt+t in, and that value flows through dispatch.sh into here.
# open-project-session.sh would then (a) propagate it into the new tmux
# session via `-e WEZTERM_PANE=…` and (b) overwrite
# pane-session/<id>.txt with the new session name — both wrong for
# cold-spawn, because the new session is not bound to the calling pane.
# It will be projected into the overflow pane via switch-client, and
# the lua-side `tab.activate_overflow` handler is what writes the
# in-memory pane→session map for that pane. Leaving WEZTERM_PANE set
# causes the badge to also light up the calling tab (e.g. blue running
# block on tab #1 after Alt+t from the first tab) and misroutes Alt+/
# jumps via stale entry.wezterm_pane_id.
# Pass `--agent-profile <base>` so open-project-session.sh tags the
# primary pane with `@wezterm_pane_role=agent-cli:<base>`. Without this
# tag, `@agent_pane_match` in tmux.conf can't see through the resume
# wrapper's `pane_current_command=sh`/`node` boot transient, and Ctrl+N
# / Ctrl+P fall through to the pass-through branch on a fresh cold-spawn
# tab until something else (refresh-session) re-tags the pane. Mirrors
# the lua-side wiring at workspace/runtime.lua:project_session_args.
( setsid env -u WEZTERM_PANE bash "$script_dir/open-project-session.sh" \
    "$workspace" "$cwd" --agent-profile "$profile" "${agent_argv[@]}" \
    </dev/null >/dev/null 2>&1 & ) >/dev/null 2>&1

# Poll for the session to come up. open-project-session.sh's setup
# (git resolution, primary command build, two-pane split) typically
# lands within 500-800 ms; cap at ~5 s for slow disks.
for _ in $(seq 1 50); do
  if tmux has-session -t "$session_name" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

if ! tmux has-session -t "$session_name" 2>/dev/null; then
  printf '[tab-overflow-cold-spawn] session %s did not come up in 5 s\n' \
    "$session_name" >&2
  exit 2
fi

# Tag the new session with the workspace (set-option is idempotent;
# open-project-session.sh sets it too via tmux_worktree_set_session_metadata
# but we may race with that call).
tmux set-option -t "$session_name" -q @wezterm_workspace "$workspace" 2>/dev/null || true

if ! bash "$script_dir/tab-overflow-attach.sh" "$workspace" "$session_name"; then
  printf '[tab-overflow-cold-spawn] tab-overflow-attach.sh failed\n' >&2
  exit 3
fi

WEZTERM_EVENT_FORCE_FILE=1 \
  wezterm_event_send "tab.activate_overflow" \
    "v1|workspace=${workspace}|session=${session_name}" || true
