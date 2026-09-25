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

# True when a status line has visible text after stripping tmux style
# markers (#[...]) and whitespace. Used to pack status rows: empty /
# placeholder-only producers must emit "" so they do not reserve a row.
tmux_status_line_is_visible() {
  local raw="${1:-}"
  local plain=""

  plain="$(printf '%s' "$raw" | sed -E 's/#\[[^]]*\]//g')"
  plain="${plain#"${plain%%[![:space:]]*}"}"
  plain="${plain%"${plain##*[![:space:]]}"}"
  [[ -n "$plain" ]]
}

style() {
  local spec="$1"
  local text="$2"
  printf '#[%s]%s#[default]' "$spec" "$text"
}

# Map a git toplevel basename to a status-bar display label.
# Remaps use shared.env WEZTERM_REPO_ALIASES as comma-separated
# `basename=label` entries (default wezterm-config=wezdeck). Legacy
# TMUX_STATUS_REPO_ALIAS / @tmux_status_repo_alias values are ignored with a
# warning. Set the shared value to none|off|0 (or empty) to show raw basenames.
tmux_status_repo_display_label() {
  local label="${1:-}"
  local alias=""
  local key=""
  local value=""

  [[ -n "$label" ]] || {
    printf '%s' "$label"
    return
  }

  if [[ -n "${TMUX_STATUS_REPO_ALIAS+x}" || -n "${WEZTERM_REPO_ALIAS+x}" ]]; then
    printf 'warning: legacy repo alias variable ignored; use WEZTERM_REPO_ALIASES\n' >&2
  fi
  if [[ -n "${WEZTERM_REPO_ALIASES+x}" ]]; then
    alias="$WEZTERM_REPO_ALIASES"
  else
    local legacy_option
    legacy_option="$(tmux_option @tmux_status_repo_alias '')"
    if [[ -n "$legacy_option" ]]; then
      printf 'warning: legacy tmux repo alias option ignored; use WEZTERM_REPO_ALIASES\n' >&2
    fi
    alias='wezterm-config=wezdeck'
  fi
  case "$alias" in
    ''|none|off|0)
      printf '%s' "$label"
      return
      ;;
  esac

  local entry key value
  while IFS= read -r entry; do
    key="${entry%%=*}"
    value="${entry#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$key" == "$label" && -n "$value" && "$value" != "$entry" ]]; then
      printf '%s' "$value"
      return
    fi
  done < <(printf '%s\n' "$alias" | tr ',' '\n')

  printf '%s' "$label"
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
