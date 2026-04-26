#!/usr/bin/env bash
# sync-target-lib.sh
#
# Repo-root + target-home resolution for sync-runtime.sh: pick where this
# repo lives, where to sync to, and what state dir layout the target uses.
# Sourced (do not execute).
#
# Public functions used by sync-runtime.sh:
#   resolve_repo_root            → repo root from $WEZDECK_REPO / cwd
#   resolve_main_repo_root       → repo root walked up out of any worktree
#   target_runtime_state_dir     → AppData (Windows) vs ~/.local/state (POSIX)
#   list_candidate_homes         → for `--list-targets`
#   choose_target_home           → resolves explicit/cached/prompted target
#
# Required from caller's environment:
#   - runtime_log_info function
#   - sync_prompt_* helpers + render_sync_prompt_output from sync-prompt-lib.sh
#   - $SYNC_CACHE_FILE / $TARGET_HOME_OVERRIDE / $WEZTERM_SYNC_TARGET globals

resolve_repo_root() {
  local repo_root="${WEZDECK_REPO:-${WEZTERM_CONFIG_REPO:-$PWD}}"
  [[ -d "$repo_root" ]] || { printf 'Repository root does not exist: %s\n' "$repo_root" >&2; return 1; }
  repo_root="$(cd "$repo_root" && pwd -P)"
  [[ -f "$repo_root/wezterm.lua" ]] || { printf 'Expected %s/wezterm.lua. Run from the repo root or set WEZDECK_REPO.\n' "$repo_root" >&2; return 1; }
  [[ -d "$repo_root/wezterm-x" ]] || { printf 'Expected %s/wezterm-x. Run from the repo root or set WEZDECK_REPO.\n' "$repo_root" >&2; return 1; }
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

target_runtime_state_dir() {
  local target_home="${1:?missing target home}"

  if [[ "$target_home" =~ ^/mnt/[A-Za-z]/Users/[^/]+$ ]]; then
    printf '%s/AppData/Local/wezterm-runtime\n' "$target_home"
    return 0
  fi

  printf '%s/.local/state/wezterm-runtime\n' "$target_home"
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
