#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_PROMPT_LIB="$SCRIPT_DIR/sync-prompt-lib.sh"
RUNTIME_LOG_LIB="$SCRIPT_DIR/../../../scripts/runtime/runtime-log-lib.sh"

# Shared with the prompt test script so output regressions are easy to verify.
source "$SYNC_PROMPT_LIB"
# shellcheck disable=SC1091
source "$RUNTIME_LOG_LIB"
export WEZTERM_RUNTIME_LOG_SOURCE="sync-runtime"

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
  WEZTERM_CONFIG_REPO   Repository root. Defaults to the current working directory.
EOF
}

cleanup_stale_windows_runtime_processes() {
  local repo_root="${1:?missing repo root}"
  local target_home="${2:?missing target home}"
  local release_id="${3:?missing release id}"
  local cleanup_script="$repo_root/skills/wezterm-runtime-sync/scripts/cleanup-stale-windows-runtime-processes.ps1"
  local cleanup_script_win="" target_home_win="" killed_count=""

  [[ "$target_home" =~ ^/mnt/[A-Za-z]/Users/ ]] || return 0
  command -v powershell.exe >/dev/null 2>&1 || return 0
  command -v wslpath >/dev/null 2>&1 || return 0
  [[ -f "$cleanup_script" ]] || return 0

  cleanup_script_win="$(wslpath -w "$cleanup_script" 2>/dev/null || true)"
  target_home_win="$(wslpath -w "$target_home" 2>/dev/null || true)"
  [[ -n "$cleanup_script_win" && -n "$target_home_win" ]] || return 0

  if killed_count="$(powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
    -File "$cleanup_script_win" \
    -TargetHome "$target_home_win" \
    -CurrentRelease "$release_id" 2>/dev/null | tr -d '\r' | tail -n 1)"; then
    runtime_log_info sync "cleaned stale windows runtime processes after sync" \
      "target_home=$target_home" \
      "release_id=$release_id" \
      "killed_count=${killed_count:-0}"
    return 0
  fi

  runtime_log_warn sync "failed to clean stale windows runtime processes after sync" \
    "target_home=$target_home" \
    "release_id=$release_id"
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

write_current_release_files() {
  local runtime_state_dir="${1:?missing runtime state dir}"
  local release_id="${2:?missing release id}"
  local release_root="${3:?missing release root}"
  local runtime_dir="${4:?missing runtime dir}"
  local current_release_file="$runtime_state_dir/current-release.txt"
  local current_lua_file="$runtime_state_dir/current.lua"
  local release_root_lua runtime_dir_lua state_dir_lua

  release_root_lua="$(lua_quote "$(lua_runtime_path "$release_root")")"
  runtime_dir_lua="$(lua_quote "$(lua_runtime_path "$runtime_dir")")"
  state_dir_lua="$(lua_quote "$(lua_runtime_path "$runtime_state_dir")")"

  write_text_file_atomic "$current_release_file" <<EOF
$release_id
EOF

  write_text_file_atomic "$current_lua_file" <<EOF
return {
  release_id = $(lua_quote "$release_id"),
  release_root = $release_root_lua,
  runtime_dir = $runtime_dir_lua,
  state_dir = $state_dir_lua,
}
EOF
}

cleanup_old_releases() {
  local releases_dir="${1:?missing releases dir}"
  local keep_count="${2:?missing keep count}"
  local current_release="${3:?missing current release}"
  local releases=()
  local release_name

  [[ -d "$releases_dir" ]] || return 0

  while IFS= read -r release_name; do
    [[ -n "$release_name" ]] || continue
    releases+=("$release_name")
  done < <(find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r)

  local kept=0
  for release_name in "${releases[@]}"; do
    if (( kept < keep_count )) || [[ "$release_name" == "$current_release" ]]; then
      ((kept += 1))
      continue
    fi

    rm -rf "$releases_dir/$release_name"
  done
}

generate_release_id() {
  local repo_root="${1:?missing repo root}"
  local timestamp git_short
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  git_short="$(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || printf 'nogit')"
  printf '%s-%s-%s\n' "$timestamp" "$git_short" "$$"
}

maybe_reload_tmux() {
  local repo_root="${1:?missing repo root}"
  local reload_script="$repo_root/scripts/dev/reload-tmux.sh"

  if [[ ! -f "$reload_script" ]]; then
    runtime_log_info sync "skipped tmux reload after sync" "reason=reload_script_missing" "reload_script=$reload_script"
    printf 'Skipped tmux reload: missing reload script %s\n' "$reload_script"
    return 0
  fi

  if ! command -v tmux >/dev/null 2>&1; then
    runtime_log_info sync "skipped tmux reload after sync" "reason=tmux_not_installed"
    printf 'Skipped tmux reload: tmux is not installed\n'
    return 0
  fi

  if ! tmux list-sessions >/dev/null 2>&1; then
    runtime_log_info sync "skipped tmux reload after sync" "reason=no_accessible_tmux_server"
    printf 'Skipped tmux reload: no accessible tmux server\n'
    return 0
  fi

  if bash "$reload_script"; then
    runtime_log_info sync "reloaded tmux config after sync" "reload_script=$reload_script"
    return 0
  fi

  runtime_log_error sync "tmux reload after sync failed" "reload_script=$reload_script"
  printf 'Warning: synced runtime files, but tmux reload failed: %s\n' "$reload_script" >&2
}

resolve_repo_root() {
  local repo_root="${WEZTERM_CONFIG_REPO:-$PWD}"
  [[ -d "$repo_root" ]] || { printf 'Repository root does not exist: %s\n' "$repo_root" >&2; return 1; }
  repo_root="$(cd "$repo_root" && pwd -P)"
  [[ -f "$repo_root/wezterm.lua" ]] || { printf 'Expected %s/wezterm.lua. Run from the repo root or set WEZTERM_CONFIG_REPO.\n' "$repo_root" >&2; return 1; }
  [[ -d "$repo_root/wezterm-x" ]] || { printf 'Expected %s/wezterm-x. Run from the repo root or set WEZTERM_CONFIG_REPO.\n' "$repo_root" >&2; return 1; }
  printf '%s\n' "$repo_root"
}

resolve_main_repo_root() {
  local repo_root="${1:?missing repo root}"
  local common_dir=""

  common_dir="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [[ -z "$common_dir" ]]; then
    common_dir="$(git -C "$repo_root" rev-parse --git-common-dir 2>/dev/null || true)"
  fi

  if [[ -z "$common_dir" ]]; then
    printf '%s\n' "$repo_root"
    return 0
  fi

  if [[ "$common_dir" != /* ]]; then
    common_dir="$(
      cd "$repo_root"
      cd "$common_dir"
      pwd -P
    )"
  fi

  dirname "$common_dir"
}

append_unique_candidate() {
  local entry="$1"
  local existing

  for existing in "${DETECTED_CANDIDATES[@]:-}"; do
    if [[ "$existing" == "$entry" ]]; then
      return 0
    fi
  done

  DETECTED_CANDIDATES+=("$entry")
}

DETECTED_CANDIDATES=()

detect_candidate_homes() {
  DETECTED_CANDIDATES=()
  local roots=()
  local uname
  uname="$(uname -s)"
  [[ -n "$HOME" ]] && roots+=("$(dirname "$HOME")")
  case "$uname" in
    Linux)
      roots+=("/home" "/root")
      [[ -d /mnt/c/Users ]] && roots+=("/mnt/c/Users")
      ;;
    Darwin)
      roots+=("/Users")
      ;;
    *)
      roots+=("/home" "/Users")
      ;;
  esac

  local base
  for base in "${roots[@]}"; do
    [[ -d "$base" ]] || continue
    local entry
    for entry in "$base"/*; do
      [[ -d "$entry" ]] || continue
      local name
      name="$(basename "$entry")"
      [[ -n "$name" ]] || continue
      if [[ "$base" == "/mnt/c/Users" ]] && is_system_windows_profile "$name"; then
        continue
      fi
      append_unique_candidate "$entry"
    done
  done
}

is_system_windows_profile() {
  local name="$1"
  case "$name" in
    "All Users"|"Default"|"Default User"|"Public"|"desktop.ini"|"defaultuser0"|"WDAGUtilityAccount")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

list_candidate_homes() {
  local lang
  lang="$(sync_prompt_language)"

  detect_candidate_homes
  [[ ${#DETECTED_CANDIDATES[@]} -gt 0 ]] || { sync_prompt_no_dir_message "$lang" >&2; return 1; }
  runtime_log_info sync "listed sync target candidates" "candidate_count=${#DETECTED_CANDIDATES[@]}"

  printf '%s\n' "${DETECTED_CANDIDATES[@]}"
}

validate_explicit_target_home() {
  local target="$1"
  local lang
  lang="$(sync_prompt_language)"

  [[ "$target" =~ ^/ ]] || { sync_prompt_abs_message "$lang" >&2; return 1; }
  [[ -d "$target" ]] || { sync_prompt_missing_message "$lang" >&2; return 1; }
}

load_cached_target() {
  if [[ -n "${WEZTERM_SYNC_TARGET:-}" ]]; then
    runtime_log_info sync "using sync target from environment" "target_home=$WEZTERM_SYNC_TARGET"
    printf '%s\n' "$WEZTERM_SYNC_TARGET"
    return 0
  fi
  if [[ -f "$SYNC_CACHE_FILE" ]]; then
    local cached
    cached="$(< "$SYNC_CACHE_FILE")"
    if [[ -n "$cached" ]]; then
      runtime_log_info sync "using cached sync target" "target_home=$cached" "cache_file=$SYNC_CACHE_FILE"
      printf '%s\n' "$cached"
      return 0
    fi
  fi
  return 1
}

prompt_user_for_target() {
  local lang
  lang="$(sync_prompt_language)"

  detect_candidate_homes
  local candidates=("${DETECTED_CANDIDATES[@]}")
  [[ ${#candidates[@]} -gt 0 ]] || { sync_prompt_no_dir_message "$lang" >&2; return 1; }

  if [[ ! -t 0 ]]; then
    render_sync_prompt_output non-tty "$lang" "${candidates[@]}" >&2
    return 1
  fi
  render_sync_prompt_output tty "$lang" "${candidates[@]}" >&2

  while true; do
    read -r choice
    case "$choice" in
      '' ) continue ;;
      *[!0-9]* )
        [[ "$choice" =~ ^/ ]] || { sync_prompt_abs_message "$lang"; continue; }
        [[ -d "$choice" ]] || { sync_prompt_missing_message "$lang"; continue; }
        printf '%s\n' "$choice"
        return 0
        ;;
      *)
        if (( choice >= 1 && choice <= ${#candidates[@]} )); then
          printf '%s\n' "${candidates[choice-1]}"
          return 0
        fi
        sync_prompt_range_message "$lang"
        ;;
    esac
  done
}

choose_target_home() {
  if [[ -n "${TARGET_HOME_OVERRIDE:-}" ]]; then
    validate_explicit_target_home "$TARGET_HOME_OVERRIDE" || return 1
    printf '%s\n' "$TARGET_HOME_OVERRIDE" > "$SYNC_CACHE_FILE"
    runtime_log_info sync "using explicit sync target" "target_home=$TARGET_HOME_OVERRIDE" "cache_file=$SYNC_CACHE_FILE"
    printf '%s\n' "$TARGET_HOME_OVERRIDE"
    return 0
  fi

  local target
  if target="$(load_cached_target)"; then
    [[ -d "$target" ]] && printf '%s\n' "$target" && return 0
  fi
  target="$(prompt_user_for_target)" || return 1
  printf '%s\n' "$target" > "$SYNC_CACHE_FILE"
  runtime_log_info sync "selected sync target interactively" "target_home=$target" "cache_file=$SYNC_CACHE_FILE"
  printf '%s\n' "$target"
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
SYNC_CACHE_FILE="$REPO_ROOT/.sync-target"
MAIN_REPO_ROOT="$(resolve_main_repo_root "$REPO_ROOT")"

TARGET_HOME="$(choose_target_home)"
TARGET_FILE="$TARGET_HOME/.wezterm.lua"
TARGET_RUNTIME_STATE_DIR="$TARGET_HOME/.wezterm-runtime"
TARGET_RELEASES_DIR="$TARGET_RUNTIME_STATE_DIR/releases"
RELEASE_ID="$(generate_release_id "$REPO_ROOT")"
TARGET_RELEASE_ROOT="$TARGET_RELEASES_DIR/$RELEASE_ID"
TARGET_RUNTIME_DIR="$TARGET_RELEASE_ROOT/wezterm-x"
TEMP_RELEASE_ROOT="$TARGET_RUNTIME_STATE_DIR/.release-$RELEASE_ID-$$"
TEMP_RUNTIME_DIR="$TEMP_RELEASE_ROOT/wezterm-x"

runtime_log_info sync "sync-runtime invoked" \
  "repo_root=$REPO_ROOT" \
  "main_repo_root=$MAIN_REPO_ROOT" \
  "target_home=$TARGET_HOME" \
  "target_file=$TARGET_FILE" \
  "target_runtime_dir=$TARGET_RUNTIME_DIR" \
  "release_id=$RELEASE_ID"

mkdir -p "$TARGET_HOME"
mkdir -p "$TARGET_RUNTIME_STATE_DIR"
mkdir -p "$TARGET_RELEASES_DIR"
rm -rf "$TEMP_RELEASE_ROOT"
mkdir -p "$TEMP_RUNTIME_DIR"

cp -R "$RUNTIME_SOURCE_DIR"/. "$TEMP_RUNTIME_DIR"/

repo_root_path="${WEZTERM_REPO_ROOT:-}"
if [[ -z "$repo_root_path" ]]; then
  repo_root_path="$(cd "$REPO_ROOT" && pwd -P)"
fi
printf '%s\n' "$repo_root_path" > "$TEMP_RUNTIME_DIR/repo-root.txt"
printf '%s\n' "$MAIN_REPO_ROOT" > "$TEMP_RUNTIME_DIR/repo-main-root.txt"

mv "$TEMP_RELEASE_ROOT" "$TARGET_RELEASE_ROOT"

write_current_release_files "$TARGET_RUNTIME_STATE_DIR" "$RELEASE_ID" "$TARGET_RELEASE_ROOT" "$TARGET_RUNTIME_DIR"
copy_file_atomic "$SOURCE_FILE" "$TARGET_FILE"
cleanup_stale_windows_runtime_processes "$REPO_ROOT" "$TARGET_HOME" "$RELEASE_ID"
cleanup_old_releases "$TARGET_RELEASES_DIR" 5 "$RELEASE_ID"

maybe_reload_tmux "$REPO_ROOT"

runtime_log_info sync "sync-runtime completed" \
  "repo_root=$REPO_ROOT" \
  "target_home=$TARGET_HOME" \
  "target_file=$TARGET_FILE" \
  "target_runtime_dir=$TARGET_RUNTIME_DIR" \
  "release_id=$RELEASE_ID" \
  "duration_ms=$(runtime_log_duration_ms "$start_ms")"
printf 'Synced %s -> %s\n' "$SOURCE_FILE" "$TARGET_FILE"
printf 'Synced %s -> %s\n' "$RUNTIME_SOURCE_DIR" "$TARGET_RUNTIME_DIR"
