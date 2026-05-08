#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_PROMPT_LIB="$SCRIPT_DIR/sync-prompt-lib.sh"
RUNTIME_LOG_LIB="$SCRIPT_DIR/../../../scripts/runtime/runtime-log-lib.sh"
WINDOWS_SHELL_LIB="$SCRIPT_DIR/../../../scripts/runtime/windows-shell-lib.sh"
HELPER_WINDOWS_LIB="$SCRIPT_DIR/sync-helper-windows-lib.sh"
TARGET_LIB="$SCRIPT_DIR/sync-target-lib.sh"

# Shared with the prompt test script so output regressions are easy to verify.
source "$SYNC_PROMPT_LIB"
# shellcheck disable=SC1091
source "$RUNTIME_LOG_LIB"
# shellcheck disable=SC1091
source "$WINDOWS_SHELL_LIB"
# Helper-windows + target-resolution functions live in sibling lib files so
# the main entry point stays focused on flow orchestration. Order matters
# only in that the libs above (runtime-log, windows-shell) must already be
# sourced — the helper-windows lib calls runtime_log_* / windows_run_*.
# shellcheck disable=SC1091
source "$HELPER_WINDOWS_LIB"
# shellcheck disable=SC1091
source "$TARGET_LIB"
export WEZTERM_RUNTIME_LOG_SOURCE="sync-runtime"

sync_trace() {
  printf '[sync] %s\n' "$*"
}

usage() {
  cat <<'EOF'
Usage:
  skills/wezterm-runtime-sync/scripts/sync-runtime.sh
  skills/wezterm-runtime-sync/scripts/sync-runtime.sh --list-targets
  skills/wezterm-runtime-sync/scripts/sync-runtime.sh --target-home /absolute/path

Options:
  --list-targets        Print candidate user home directories and exit.
  --target-home PATH    Sync directly to PATH and cache it in .sync-target.
  -h, --help            Show this help text.

Environment:
  WEZDECK_REPO          Repository root (legacy WEZTERM_CONFIG_REPO still accepted). Defaults to the current working directory.
EOF
}

write_text_file_atomic() {
  local target_path="${1:?missing target path}"
  local temp_path="${target_path}.tmp.$$"
  cat > "$temp_path"
  mv -f "$temp_path" "$target_path"
}

copy_file_atomic() {
  local source_path="${1:?missing source path}"
  local target_path="${2:?missing target path}"
  if [[ -f "$target_path" ]] && cmp -s "$source_path" "$target_path"; then
    return 0
  fi
  local temp_path="${target_path}.tmp.$$"
  cp "$source_path" "$temp_path"
  mv -f "$temp_path" "$target_path"
}

write_agent_tools_file() {
  # Drops the discovery marker on the WSL user home, NOT the wezterm runtime
  # target home. The marker advertises bash-callable wrappers under
  # /home/<user>/..., which Windows-side processes cannot consume; the only
  # readers are WSL-resident agents (Claude Code, Codex CLI, etc.). In
  # posix-local mode the WSL home and target home coincide, so this still
  # lands in the right place. Schema lives in docs/setup.md.
  local wsl_home="${1:?missing WSL home}"
  local repo_root_path="${2:?missing repo root path}"
  local target_dir="$wsl_home/.wezterm-x"
  local target_file="$target_dir/agent-tools.env"
  local clipboard_wrapper="$repo_root_path/scripts/runtime/agent-clipboard.sh"

  mkdir -p "$target_dir"
  write_text_file_atomic "$target_file" <<EOF
version=1
repo_root=$repo_root_path
agent_clipboard=$clipboard_wrapper
EOF
}

wait_for_flow() {
  local flow_name="${1:?missing flow name}"
  local pid="${2:-}"

  if [[ -z "$pid" ]]; then
    return 0
  fi

  sync_trace "flow=$flow_name status=waiting pid=$pid"
  wait "$pid"
}

lua_quote() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//\'/\\\'}"
  printf "'%s'" "$value"
}

lua_runtime_path() {
  local path="${1:?missing path}"
  if [[ "$path" =~ ^/mnt/[A-Za-z]/ ]]; then
    wslpath -w "$path"
    return 0
  fi

  printf '%s\n' "$path"
}

run_lua_source_syntax_check() {
  # Pre-sync gate: byte-compile every *.lua under the source tree with
  # `luac -p` so a syntax error in any file (not just the ones constants.lua
  # transitively requires) aborts before rsync overwrites the Windows
  # runtime with a broken file. The post-copy lua-precheck only loads
  # constants.lua → it can't catch a busted titles.lua.
  local source_runtime_dir="${1:?missing source_runtime_dir}"

  local luac_bin=""
  for candidate in luac5.4 luac5.3 luac; do
    if command -v "$candidate" >/dev/null 2>&1; then
      luac_bin="$candidate"
      break
    fi
  done
  if [[ -z "$luac_bin" ]]; then
    sync_trace "step=lua-source-syntax status=skipped reason=no_luac"
    return 0
  fi

  sync_trace "step=lua-source-syntax status=running luac_bin=$luac_bin source_runtime_dir=$source_runtime_dir"

  local errors=""
  while IFS= read -r -d '' lua_file; do
    local err
    if ! err="$("$luac_bin" -p "$lua_file" 2>&1)"; then
      errors+="$err"$'\n'
    fi
  done < <(find "$source_runtime_dir" -type f -name '*.lua' -print0)

  if [[ -n "$errors" ]]; then
    runtime_log_error sync "lua source syntax check failed" "source_runtime_dir=$source_runtime_dir"
    sync_trace "step=lua-source-syntax status=failed source_runtime_dir=$source_runtime_dir"
    printf '[sync] lua syntax errors in source tree (sync aborted before copy):\n%s' "$errors" >&2
    return 1
  fi

  sync_trace "step=lua-source-syntax status=completed source_runtime_dir=$source_runtime_dir"
}

run_lua_precheck() {
  local target_runtime_dir="${1:?missing target_runtime_dir}"
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local precheck_script="$script_dir/lua-precheck.lua"

  if [[ ! -f "$precheck_script" ]]; then
    sync_trace "step=lua-precheck status=skipped reason=script_missing precheck_script=$precheck_script"
    return 0
  fi

  # Skip-if-current: cache success as a touch'd sentinel under the runtime
  # state dir. As long as no input file (lua/, repo-worktree-task.env, the
  # precheck script itself) is newer than the sentinel, the prior result
  # is still valid. Override with WEZTERM_SYNC_FORCE_LUA_PRECHECK=1.
  local sentinel="${TARGET_RUNTIME_STATE_DIR:-$target_runtime_dir/.state}/lua-precheck.ok"
  if [[ -f "$sentinel" && "${WEZTERM_SYNC_FORCE_LUA_PRECHECK:-0}" != "1" ]]; then
    local newer_input
    newer_input="$(find \
      "$target_runtime_dir/lua" \
      "$target_runtime_dir/repo-worktree-task.env" \
      "$precheck_script" \
      -newer "$sentinel" -print -quit 2>/dev/null)"
    if [[ -z "$newer_input" ]]; then
      sync_trace "step=lua-precheck status=skipped reason=up-to-date sentinel=$sentinel"
      return 0
    fi
  fi

  local lua_bin=""
  for candidate in lua5.4 lua5.3 lua; do
    if command -v "$candidate" >/dev/null 2>&1; then
      lua_bin="$candidate"
      break
    fi
  done

  if [[ -z "$lua_bin" ]]; then
    runtime_log_warn sync "skipped lua precheck after sync" "reason=no_lua_runtime"
    sync_trace "step=lua-precheck status=skipped reason=no_lua_runtime"
    printf 'Skipped lua precheck: install lua5.4 (`sudo apt install lua5.4`) to enable.\n' >&2
    return 0
  fi

  sync_trace "step=lua-precheck status=running lua_bin=$lua_bin target_runtime_dir=$target_runtime_dir"
  if ! "$lua_bin" "$precheck_script" "$target_runtime_dir"; then
    runtime_log_error sync "lua precheck failed" "target_runtime_dir=$target_runtime_dir"
    sync_trace "step=lua-precheck status=failed target_runtime_dir=$target_runtime_dir"
    return 1
  fi
  mkdir -p "$(dirname "$sentinel")" 2>/dev/null || true
  : >"$sentinel"
  sync_trace "step=lua-precheck status=completed target_runtime_dir=$target_runtime_dir sentinel=$sentinel"
}

maybe_reload_tmux() {
  local repo_root="${1:?missing repo root}"
  local reload_script="$repo_root/scripts/dev/reload-tmux.sh"
  sync_trace "step=tmux-reload status=checking reload_script=$reload_script"

  if [[ ! -f "$reload_script" ]]; then
    runtime_log_info sync "skipped tmux reload after sync" "reason=reload_script_missing" "reload_script=$reload_script"
    sync_trace "step=tmux-reload status=skipped reason=reload_script_missing"
    printf 'Skipped tmux reload: missing reload script %s\n' "$reload_script"
    return 0
  fi

  if ! command -v tmux >/dev/null 2>&1; then
    runtime_log_info sync "skipped tmux reload after sync" "reason=tmux_not_installed"
    sync_trace "step=tmux-reload status=skipped reason=tmux_not_installed"
    printf 'Skipped tmux reload: tmux is not installed\n'
    return 0
  fi

  if ! tmux list-sessions >/dev/null 2>&1; then
    runtime_log_info sync "skipped tmux reload after sync" "reason=no_accessible_tmux_server"
    sync_trace "step=tmux-reload status=skipped reason=no_accessible_tmux_server"
    printf 'Skipped tmux reload: no accessible tmux server\n'
    return 0
  fi

  if bash "$reload_script"; then
    runtime_log_info sync "reloaded tmux config after sync" "reload_script=$reload_script"
    sync_trace "step=tmux-reload status=completed reload_script=$reload_script"
    return 0
  fi

  runtime_log_error sync "tmux reload after sync failed" "reload_script=$reload_script"
  sync_trace "step=tmux-reload status=failed reload_script=$reload_script"
  printf 'Warning: synced runtime files, but tmux reload failed: %s\n' "$reload_script" >&2
}

LIST_TARGETS=0
TARGET_HOME_OVERRIDE=""
start_ms="$(runtime_log_now_ms)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list-targets)
      LIST_TARGETS=1
      shift
      ;;
    --target-home)
      [[ $# -ge 2 ]] || { printf 'Missing value for --target-home.\n' >&2; usage >&2; exit 1; }
      TARGET_HOME_OVERRIDE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if (( LIST_TARGETS )) && [[ -n "$TARGET_HOME_OVERRIDE" ]]; then
  printf 'Use either --list-targets or --target-home, not both.\n' >&2
  exit 1
fi

if (( LIST_TARGETS )); then
  list_candidate_homes
  exit 0
fi

REPO_ROOT="$(resolve_repo_root)"
SOURCE_FILE="$REPO_ROOT/wezterm.lua"
RUNTIME_SOURCE_DIR="$REPO_ROOT/wezterm-x"
NATIVE_SOURCE_DIR="$REPO_ROOT/native"
SYNC_CACHE_FILE="$REPO_ROOT/.sync-target"
MAIN_REPO_ROOT="$(resolve_main_repo_root "$REPO_ROOT")"

TARGET_HOME="$(choose_target_home)"
TARGET_FILE="$TARGET_HOME/.wezterm.lua"
TARGET_RUNTIME_STATE_DIR="$(target_runtime_state_dir "$TARGET_HOME")"
TARGET_RUNTIME_DIR="$TARGET_HOME/.wezterm-x"
TARGET_NATIVE_DIR="$TARGET_HOME/.wezterm-native"
TEMP_BOOTSTRAP_FILE="$TARGET_RUNTIME_STATE_DIR/.wezterm.lua.tmp.$$"
RUNTIME_NATIVE_FLOW_PID=""
BOOTSTRAP_FLOW_PID=""

runtime_log_info sync "sync-runtime invoked" \
  "repo_root=$REPO_ROOT" \
  "main_repo_root=$MAIN_REPO_ROOT" \
  "target_home=$TARGET_HOME" \
  "target_file=$TARGET_FILE" \
  "target_runtime_dir=$TARGET_RUNTIME_DIR"
sync_trace "step=init repo_root=$REPO_ROOT main_repo_root=$MAIN_REPO_ROOT"
sync_trace "step=target target_home=$TARGET_HOME target_file=$TARGET_FILE"
sync_trace "step=target target_runtime_dir=$TARGET_RUNTIME_DIR target_native_dir=$TARGET_NATIVE_DIR"

prepare_runtime_subflow() {
  local repo_root_path="${1:?missing repo root path}"

  if ! run_lua_source_syntax_check "$RUNTIME_SOURCE_DIR"; then
    return 1
  fi

  if [[ -x "$REPO_ROOT/scripts/runtime/render-tmux-bindings.sh" ]]; then
    "$REPO_ROOT/scripts/runtime/render-tmux-bindings.sh"
    sync_trace "step=render-tmux-bindings status=completed"
  fi

  # Mirror source → target directly. --delete removes stale files; the
  # --exclude flags protect per-target metadata files (written below)
  # from being deleted as "unknown to source" on subsequent syncs.
  # rsync writes per-file via temp+rename so each file is atomic; the
  # tree as a whole has a brief window of mixed old/new during sync.
  rsync -a --delete \
    --exclude=/repo-root.txt \
    --exclude=/repo-main-root.txt \
    --exclude=/repo-worktree-task.env \
    "$RUNTIME_SOURCE_DIR"/ "$TARGET_RUNTIME_DIR"/
  sync_trace "step=copy-runtime status=completed runtime_source=$RUNTIME_SOURCE_DIR"

  printf '%s\n' "$repo_root_path" > "$TARGET_RUNTIME_DIR/repo-root.txt"
  printf '%s\n' "$MAIN_REPO_ROOT" > "$TARGET_RUNTIME_DIR/repo-main-root.txt"
  # Copy repo-side worktree-task.env into the runtime dir so the
  # Windows-side wezterm.exe Lua can read it. The repo-root.txt path
  # is a WSL-native path which Windows file APIs can't resolve, so
  # constants.lua's `io.open(<repo-root>/config/worktree-task.env)`
  # would otherwise return nil and the `<base>_resume` profile defined
  # only in that env file never gets registered on the Windows side.
  if [[ -f "$repo_root_path/config/worktree-task.env" ]]; then
    # -p preserves source mtime so downstream mtime-based skip checks
    # (lua-precheck) only see a change when the source file actually
    # changes, not on every sync.
    cp -p "$repo_root_path/config/worktree-task.env" "$TARGET_RUNTIME_DIR/repo-worktree-task.env"
  fi
  sync_trace "step=write-metadata repo_root_path=$repo_root_path repo_main_root=$MAIN_REPO_ROOT"
}

prepare_native_subflow() {
  # Build the static Go picker binary used by tmux-attention-menu.sh
  # (and friends). Same gitignored-artifact pattern as the chord bindings:
  # rebuild every sync so source changes pick up; skip silently when `go`
  # is missing so machines without the toolchain still complete the sync
  # (the bash fallback in tmux-attention-menu.sh handles the absence).
  if [[ -x "$REPO_ROOT/native/picker/build.sh" ]]; then
    if "$REPO_ROOT/native/picker/build.sh"; then
      sync_trace "step=build-picker status=completed"
    else
      sync_trace "step=build-picker status=failed"
    fi
  fi

  if [[ -d "$NATIVE_SOURCE_DIR" ]]; then
    rsync -a --delete "$NATIVE_SOURCE_DIR"/ "$TARGET_NATIVE_DIR"/
    sync_trace "step=copy-native status=completed native_source=$NATIVE_SOURCE_DIR"
  fi
}

run_runtime_native_flow() {
  local repo_root_path=""
  local runtime_sub_pid="" native_sub_pid=""
  local runtime_sub_rc=0 native_sub_rc=0

  sync_trace "flow=runtime-native status=starting target_runtime_dir=$TARGET_RUNTIME_DIR target_native_dir=$TARGET_NATIVE_DIR"

  mkdir -p "$TARGET_HOME"
  mkdir -p "$TARGET_RUNTIME_STATE_DIR"
  mkdir -p "$TARGET_RUNTIME_DIR" "$TARGET_NATIVE_DIR"
  sync_trace "step=prepare target_runtime_dir=$TARGET_RUNTIME_DIR target_native_dir=$TARGET_NATIVE_DIR"

  repo_root_path="${WEZTERM_REPO_ROOT:-}"
  if [[ -z "$repo_root_path" ]]; then
    repo_root_path="$(cd "$REPO_ROOT" && pwd -P)"
  fi

  # Two independent chains run in parallel:
  #   runtime: render-tmux-bindings → rsync runtime → write metadata
  #   native:  picker build         → rsync native
  # rsync writes incrementally to TARGET (no temp+rename publish step);
  # subsequent syncs only write changed files.
  prepare_runtime_subflow "$repo_root_path" &
  runtime_sub_pid=$!
  sync_trace "subflow=runtime status=running async=1 pid=$runtime_sub_pid"

  prepare_native_subflow &
  native_sub_pid=$!
  sync_trace "subflow=native status=running async=1 pid=$native_sub_pid"

  wait "$runtime_sub_pid" || runtime_sub_rc=$?
  sync_trace "subflow=runtime status=completed rc=$runtime_sub_rc"
  wait "$native_sub_pid" || native_sub_rc=$?
  sync_trace "subflow=native status=completed rc=$native_sub_rc"

  if (( runtime_sub_rc != 0 )); then
    runtime_log_error sync "runtime subflow failed" "rc=$runtime_sub_rc"
    return "$runtime_sub_rc"
  fi
  if (( native_sub_rc != 0 )); then
    runtime_log_error sync "native subflow failed" "rc=$native_sub_rc"
    return "$native_sub_rc"
  fi

  run_lua_precheck "$TARGET_RUNTIME_DIR"

  install_windows_helper_manager "$TARGET_RUNTIME_DIR"
  ensure_windows_helper_running "$TARGET_RUNTIME_DIR"
  sync_trace "flow=runtime-native status=completed target_runtime_dir=$TARGET_RUNTIME_DIR target_native_dir=$TARGET_NATIVE_DIR"
}

run_bootstrap_prepare_flow() {
  sync_trace "flow=wezdeck-bootstrap status=starting target_file=$TARGET_FILE temp_file=$TEMP_BOOTSTRAP_FILE"
  mkdir -p "$TARGET_HOME"
  mkdir -p "$TARGET_RUNTIME_STATE_DIR"
  cp "$SOURCE_FILE" "$TEMP_BOOTSTRAP_FILE"
  sync_trace "step=prepare-bootstrap status=completed temp_file=$TEMP_BOOTSTRAP_FILE"
  sync_trace "flow=wezdeck-bootstrap status=prepared target_file=$TARGET_FILE temp_file=$TEMP_BOOTSTRAP_FILE"
}

finalize_bootstrap_refresh() {
  [[ -f "$TEMP_BOOTSTRAP_FILE" ]] || {
    printf 'Prepared bootstrap file is missing: %s\n' "$TEMP_BOOTSTRAP_FILE" >&2
    return 1
  }

  copy_file_atomic "$TEMP_BOOTSTRAP_FILE" "$TARGET_FILE"
  rm -f "$TEMP_BOOTSTRAP_FILE"
  touch "$TARGET_FILE"
  sync_trace "step=refresh-bootstrap status=completed target_file=$TARGET_FILE"
}

# Fire-and-forget + daily rate-limit: deps-check is purely advisory (it
# hits the network to look up wezterm/tmux/go versions) and historically
# dominates wall time at ~40s. Skip if we already ran today; otherwise
# detach it before the heavy sync work so it overlaps and never blocks
# the user. Output is written to a per-target log file; freshness is
# determined from that log file's mtime so a single source of truth.
# Override with WEZTERM_SYNC_FORCE_DEPS_CHECK=1 to bypass the daily gate.
DEPS_CHECK_SCRIPT="$REPO_ROOT/scripts/dev/check-deps-updates.sh"
DEPS_CHECK_LOG_DIR="$TARGET_RUNTIME_STATE_DIR/logs"
DEPS_CHECK_LOG="$DEPS_CHECK_LOG_DIR/deps-check.log"
if [[ -x "$DEPS_CHECK_SCRIPT" ]] && [[ "${WEZTERM_SYNC_SKIP_DEPS_CHECK:-0}" != "1" ]]; then
  mkdir -p "$DEPS_CHECK_LOG_DIR"
  deps_log_date=""
  deps_today="$(date '+%Y-%m-%d')"
  if [[ -s "$DEPS_CHECK_LOG" ]]; then
    deps_log_date="$(date -r "$DEPS_CHECK_LOG" '+%Y-%m-%d' 2>/dev/null || true)"
  fi
  if [[ "${WEZTERM_SYNC_FORCE_DEPS_CHECK:-0}" != "1" && -n "$deps_log_date" && "$deps_log_date" == "$deps_today" ]]; then
    sync_trace "step=deps-check status=skipped reason=already_ran_today log_date=$deps_log_date log=$DEPS_CHECK_LOG"
    printf '[sync] deps-check skipped (last run %s), log: %s\n' "$deps_log_date" "$DEPS_CHECK_LOG"
  else
    sync_trace "step=deps-check status=detached log=$DEPS_CHECK_LOG previous_log_date=${deps_log_date:-none}"
    printf '[sync] deps-check running in background, log: %s\n' "$DEPS_CHECK_LOG"
    nohup "$DEPS_CHECK_SCRIPT" --advisory --no-color --timeout 10 --prefix '[sync] ' \
      >"$DEPS_CHECK_LOG" 2>&1 </dev/null &
    disown 2>/dev/null || true
  fi
fi

run_runtime_native_flow &
RUNTIME_NATIVE_FLOW_PID=$!
sync_trace "flow=runtime-native status=running async=1 pid=$RUNTIME_NATIVE_FLOW_PID"

run_bootstrap_prepare_flow &
BOOTSTRAP_FLOW_PID=$!
sync_trace "flow=wezdeck-bootstrap status=running async=1 pid=$BOOTSTRAP_FLOW_PID"

wait_for_flow runtime-native "$RUNTIME_NATIVE_FLOW_PID"
wait_for_flow wezdeck-bootstrap "$BOOTSTRAP_FLOW_PID"
finalize_bootstrap_refresh

# Discovery marker for WSL-resident agents (Claude Code, Codex CLI, etc.).
# Lands in $HOME/.wezterm-x/, not $TARGET_HOME/.wezterm-x/, because the
# wrappers it advertises are bash scripts under WSL paths (/home/...) that
# Windows-side processes cannot consume. In posix-local mode $HOME equals
# $TARGET_HOME, so this is the same destination; in hybrid-wsl it diverges.
# Schema documented in docs/setup.md (#agent-tools-env-schema).
write_agent_tools_file "$HOME" "$REPO_ROOT"
runtime_log_info sync "agent-tools marker written" "agent_tools_path=$HOME/.wezterm-x/agent-tools.env"
sync_trace "step=write-agent-tools agent_tools_path=$HOME/.wezterm-x/agent-tools.env"

# Two independent post-sync tasks run in parallel; each captures its
# output to a temp file so the on-screen log stays in a stable, readable
# order when we replay them after `wait`. (deps-check runs detached at
# the start of the script and writes to its own log.)
POSTSYNC_OUT_DIR="$(mktemp -d -t wezterm-sync-postXXXXXX)"
POSTSYNC_TMUX_OUT="$POSTSYNC_OUT_DIR/tmux-reload.out"
POSTSYNC_VSCODE_OUT="$POSTSYNC_OUT_DIR/vscode-links.out"

VSCODE_LINKS_SETUP="$REPO_ROOT/scripts/runtime/setup-vscode-links.sh"

(
  maybe_reload_tmux "$REPO_ROOT"
) >"$POSTSYNC_TMUX_OUT" 2>&1 &
POSTSYNC_TMUX_PID=$!

(
  if [[ -x "$VSCODE_LINKS_SETUP" ]]; then
    sync_trace "step=vscode-links-setup status=starting"
    # Default mode: auto-install if missing, advise (no auto-replace) if behind.
    # Output is prefixed so it slots into the same [sync] table as other steps.
    "$VSCODE_LINKS_SETUP" 2>&1 | sed 's/^/[sync] /' || true
    sync_trace "step=vscode-links-setup status=completed"
  fi
) >"$POSTSYNC_VSCODE_OUT" 2>&1 &
POSTSYNC_VSCODE_PID=$!

sync_trace "step=postsync status=running tmux_pid=$POSTSYNC_TMUX_PID vscode_pid=$POSTSYNC_VSCODE_PID"

wait "$POSTSYNC_TMUX_PID" || true
wait "$POSTSYNC_VSCODE_PID" || true

if [[ -s "$POSTSYNC_TMUX_OUT" ]]; then cat "$POSTSYNC_TMUX_OUT"; fi
if [[ -s "$POSTSYNC_VSCODE_OUT" ]]; then cat "$POSTSYNC_VSCODE_OUT"; fi
rm -rf "$POSTSYNC_OUT_DIR"

runtime_log_info sync "sync-runtime completed" \
  "repo_root=$REPO_ROOT" \
  "target_home=$TARGET_HOME" \
  "target_file=$TARGET_FILE" \
  "target_runtime_dir=$TARGET_RUNTIME_DIR" \
  "duration_ms=$(runtime_log_duration_ms "$start_ms")"
sync_trace "step=completed duration_ms=$(runtime_log_duration_ms "$start_ms")"

printf 'Synced %s -> %s\n' "$SOURCE_FILE" "$TARGET_FILE"
printf 'Synced %s -> %s\n' "$RUNTIME_SOURCE_DIR" "$TARGET_RUNTIME_DIR"
if [[ -d "$NATIVE_SOURCE_DIR" ]]; then
  printf 'Synced %s -> %s\n' "$NATIVE_SOURCE_DIR" "$TARGET_NATIVE_DIR"
fi
