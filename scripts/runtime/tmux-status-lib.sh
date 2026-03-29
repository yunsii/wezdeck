#!/usr/bin/env bash
set -euo pipefail

is_enabled() {
  local value="${1:-1}"
  [[ "$value" != "0" && "$value" != "false" && "$value" != "off" && "$value" != "no" ]]
}

tmux_option() {
  local option_name="$1"
  local default_value="${2:-}"
  local value

  value="$(tmux show -gv "$option_name" 2>/dev/null || true)"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
  else
    printf '%s' "$default_value"
  fi
}

tmux_option_or_env() {
  local env_name="$1"
  local option_name="$2"
  local default_value="${3:-}"

  if [[ -n "${!env_name+x}" ]]; then
    printf '%s' "${!env_name}"
  else
    tmux_option "$option_name" "$default_value"
  fi
}

join_with_separator() {
  local separator="$1"
  shift

  local first=1
  local part
  for part in "$@"; do
    if (( first )); then
      printf '%s' "$part"
      first=0
    else
      printf '%s%s' "$separator" "$part"
    fi
  done
}

style() {
  local spec="$1"
  local text="$2"
  printf '#[%s]%s#[default]' "$spec" "$text"
}

epoch_to_day() {
  local value="$1"

  if date -d "@$value" +%Y-%m-%d >/dev/null 2>&1; then
    date -d "@$value" +%Y-%m-%d
    return
  fi

  date -r "$value" +%Y-%m-%d
}

file_mtime() {
  local path="$1"

  if stat -c %Y "$path" >/dev/null 2>&1; then
    stat -c %Y "$path"
    return
  fi

  stat -f %m "$path"
}
