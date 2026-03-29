#!/usr/bin/env bash

runtime_log_init() {
  if [[ -n "${__WEZTERM_RUNTIME_LOG_INITIALIZED:-}" ]]; then
    return
  fi

  local script_dir repo_root config_file
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="${WEZTERM_REPO_ROOT:-$(cd "$script_dir/../.." && pwd)}"
  config_file="$repo_root/wezterm-x/local/runtime-logging.sh"

  if [[ -f "$config_file" ]]; then
    # shellcheck disable=SC1090
    source "$config_file"
  fi

  : "${WEZTERM_RUNTIME_LOG_ENABLED:=0}"
  : "${WEZTERM_RUNTIME_LOG_LEVEL:=info}"
  : "${WEZTERM_RUNTIME_LOG_CATEGORIES:=}"
  : "${WEZTERM_RUNTIME_LOG_FILE:=${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime.log}"

  __WEZTERM_RUNTIME_LOG_INITIALIZED=1
}

runtime_log_level_rank() {
  case "$1" in
    error) printf '1\n' ;;
    warn) printf '2\n' ;;
    info) printf '3\n' ;;
    debug) printf '4\n' ;;
    *) printf '3\n' ;;
  esac
}

runtime_log_should_emit() {
  runtime_log_init

  local level="$1"
  local category="$2"
  local requested current categories

  [[ "$WEZTERM_RUNTIME_LOG_ENABLED" == "1" ]] || return 1

  requested="$(runtime_log_level_rank "$level")"
  current="$(runtime_log_level_rank "$WEZTERM_RUNTIME_LOG_LEVEL")"
  (( requested <= current )) || return 1

  categories=",$WEZTERM_RUNTIME_LOG_CATEGORIES,"
  if [[ "$categories" != ",," && "$categories" != *",$category,"* ]]; then
    return 1
  fi

  return 0
}

runtime_log_emit() {
  runtime_log_init

  local level="$1"
  local category="$2"
  local message="$3"
  shift 3

  runtime_log_should_emit "$level" "$category" || return 0

  mkdir -p "$(dirname "$WEZTERM_RUNTIME_LOG_FILE")"

  local timestamp line
  timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
  line="[$timestamp] [${level^^}] [$category] $message"

  if [[ $# -gt 0 ]]; then
    line="$line $*"
  fi

  printf '%s\n' "$line" >> "$WEZTERM_RUNTIME_LOG_FILE"
}

runtime_log_debug() {
  runtime_log_emit debug "$@"
}

runtime_log_info() {
  runtime_log_emit info "$@"
}

runtime_log_warn() {
  runtime_log_emit warn "$@"
}

runtime_log_error() {
  runtime_log_emit error "$@"
}
