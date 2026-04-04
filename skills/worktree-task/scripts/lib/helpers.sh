#!/usr/bin/env bash

wt_die() {
  if declare -F runtime_log_error >/dev/null 2>&1; then
    runtime_log_error task "worktree-task failed" "message=$*"
  fi
  printf '%s\n' "$*" >&2
  exit 1
}

wt_hash() {
  local value="${1:-}"

  if command -v sha1sum >/dev/null 2>&1; then
    printf '%s' "$value" | sha1sum | awk '{print substr($1, 1, 10)}'
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$value" | shasum | awk '{print substr($1, 1, 10)}'
    return
  fi

  printf '%s' "$value" | cksum | awk '{print $1}'
}

wt_shell_quote() {
  printf '%q' "${1:-}"
}

wt_sanitize_name() {
  printf '%s' "${1:-}" | tr '/ .:' '____'
}

wt_slugify() {
  local raw_value="${1:-}"
  local fallback="${2:-task}"
  local slug=""

  slug="$(printf '%s' "$raw_value" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
  slug="${slug#-}"
  slug="${slug%-}"

  if [[ -z "$slug" ]]; then
    slug="$fallback"
  fi

  printf '%s\n' "$slug"
}

wt_abs_path() {
  local path="${1:-$PWD}"
  (
    cd "$path"
    pwd -P
  )
}

wt_resolve_path() {
  local base="${1:?missing base path}"
  local path="${2:?missing path}"

  if [[ "$path" == /* ]]; then
    printf '%s\n' "$path"
    return 0
  fi

  printf '%s/%s\n' "$base" "$path"
}

wt_bool_is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

wt_trim() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s\n' "$value"
}

wt_write_kv_file() {
  local file="${1:?missing file}"
  shift

  : > "$file"
  while [[ $# -gt 0 ]]; do
    local key="${1:?missing key}"
    local value="${2-}"
    printf '%s=%s\n' "$key" "$value" >> "$file"
    shift 2
  done
}

wt_parse_kv_file() {
  local file="${1:?missing file}"
  local line=""
  local key=""
  local value=""

  [[ -f "$file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    printf '%s\t%s\n' "$key" "$value"
  done < "$file"
}

wt_json_escape() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}
