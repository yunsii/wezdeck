#!/usr/bin/env bash
# Read-only checks and explicit installation for user-level agent hooks.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd -P)"
template_dir="$repo_root/scripts/runtime/agent-attention/install"
hooks_home="${AGENT_HOOKS_HOME:-${HOME:-}}"
provider=all
quiet=0

usage() {
  cat <<'EOF'
usage:
  scripts/dev/agent-hooks.sh check [--provider all|claude|codex] [--quiet]
  scripts/dev/agent-hooks.sh install --provider claude|codex|all
  scripts/dev/agent-hooks.sh probe

AGENT_HOOKS_HOME overrides the home directory used for user hook settings.
EOF
}

die() { printf 'agent-hooks: %s\n' "$*" >&2; exit 2; }
require_jq() { command -v jq >/dev/null 2>&1 || die 'jq is required'; }

provider_file() {
  case "$1" in
    claude) printf '%s/.claude/settings.json\n' "$hooks_home" ;;
    codex) printf '%s/.codex/hooks.json\n' "$hooks_home" ;;
    *) return 1 ;;
  esac
}

provider_template() {
  case "$1" in
    claude) printf '%s/claude-hooks.json\n' "$template_dir" ;;
    codex) printf '%s/codex-hooks.json\n' "$template_dir" ;;
    *) return 1 ;;
  esac
}

load_requirements() {
  case "$1" in
    claude)
      events=(UserPromptSubmit Notification Stop PreToolUse PostToolUse SessionStart)
      actions=(running waiting done resolved resolved pane-evict)
      adapter_fragment='scripts/claude-hooks/emit-agent-status.sh'
      adapter_path="$repo_root/scripts/claude-hooks/emit-agent-status.sh"
      ;;
    codex)
      events=(UserPromptSubmit PermissionRequest Stop PreToolUse PostToolUse SessionStart)
      actions=(running waiting done resolved resolved pane-evict)
      adapter_fragment='scripts/runtime/agent-attention/adapters/codex.sh'
      adapter_path="$repo_root/scripts/runtime/agent-attention/adapters/codex.sh"
      ;;
    *) return 1 ;;
  esac
}

expected_adapter_command() { printf '%s %s' "$adapter_path" "$2"; }
expected_refresh_command() {
  printf 'bash %s --force --refresh-client >/dev/null 2>&1 &' \
    "$repo_root/scripts/runtime/tmux-status-refresh.sh"
}

json_has_command() {
  local file="$1" event="$2" command="$3"
  jq -e --arg event "$event" --arg command "$command" '
    [ .hooks[$event][]?.hooks[]?
      | select(.type? == "command") | .command ]
    | any(. == $command)
  ' "$file" >/dev/null 2>&1
}

json_has_clear_command() {
  local file="$1" command="$2"
  jq -e --arg command "$command" '
    [ .hooks.SessionStart[]? | select(.matcher? == "clear")
      | .hooks[]? | select(.type? == "command") | .command ]
    | any(. == $command)
  ' "$file" >/dev/null 2>&1
}

json_has_fragment() {
  local file="$1" fragment="$2"
  jq -r '.. | objects
    | select(.type? == "command" and (.command? | type == "string"))
    | .command' "$file" 2>/dev/null | grep -Fq "$fragment"
}

config_is_inline_codex() {
  local file="$hooks_home/.codex/config.toml"
  [[ ! -f "$(provider_file codex)" && -f "$file" ]] || return 1
  grep -Eq '^[[:space:]]*\[\[?hooks|^[[:space:]]*hooks\.' "$file"
}

check_provider() {
  local name="$1" file status=healthy event action expected
  local missing=() stale=() refresh_missing=()
  load_requirements "$name"
  file="$(provider_file "$name")"

  if [[ ! -f "$file" ]]; then
    if [[ "$name" == codex ]] && config_is_inline_codex; then status=inline-config; else status=missing; fi
    printf 'agent-hooks provider=%s status=%s file=%s\n' "$name" "$status" "$file"
    return 1
  fi
  if ! jq -e 'type == "object" and ((.hooks // {}) | type == "object")' "$file" >/dev/null 2>&1; then
    printf 'agent-hooks provider=%s status=invalid-config file=%s\n' "$name" "$file"
    return 1
  fi

  for i in "${!events[@]}"; do
    event="${events[$i]}"; action="${actions[$i]}"
    expected="$(expected_adapter_command "$name" "$action")"
    if [[ "$event" == SessionStart ]]; then
      json_has_clear_command "$file" "$expected" || {
        if json_has_fragment "$file" "$adapter_fragment"; then stale+=("$event"); else missing+=("$event"); fi
      }
    elif ! json_has_command "$file" "$event" "$expected"; then
      if json_has_fragment "$file" "$adapter_fragment"; then stale+=("$event"); else missing+=("$event"); fi
    fi
  done

  expected="$(expected_refresh_command)"
  for event in Stop PostToolUse; do
    json_has_command "$file" "$event" "$expected" || refresh_missing+=("$event")
  done
  if (( ${#stale[@]} > 0 )); then status=stale-path; fi
  if (( ${#missing[@]} > 0 || ${#refresh_missing[@]} > 0 )); then status=partial; fi
  if [[ ! -x "$adapter_path" || ! -x "$repo_root/scripts/runtime/tmux-status-refresh.sh" ]]; then status=source-missing; fi

  if [[ "$status" != healthy || "$quiet" != 1 ]]; then
    printf 'agent-hooks provider=%s status=%s file=%s' "$name" "$status" "$file"
    (( ${#missing[@]} > 0 )) && printf ' missing=%s' "$(IFS=,; printf '%s' "${missing[*]}")"
    (( ${#stale[@]} > 0 )) && printf ' stale=%s' "$(IFS=,; printf '%s' "${stale[*]}")"
    (( ${#refresh_missing[@]} > 0 )) && printf ' refresh_missing=%s' "$(IFS=,; printf '%s' "${refresh_missing[*]}")"
    printf '\n'
  fi
  [[ "$status" == healthy ]]
}

merge_config() {
  local source="$1" template="$2" output="$3"
  jq -s --arg repo "$repo_root" '
    def render: walk(if type == "string" then gsub("__WEZTERM_REPO__"; $repo) else . end);
    (.[0] // {}) as $user | (.[1] | render | .hooks) as $addition
    | if (($user | type) != "object" or (($user.hooks // {}) | type) != "object") then
        error("user config must contain an object-valued hooks field")
      else reduce ($addition | to_entries[]) as $entry
        ($user; .hooks[$entry.key] =
          reduce ($entry.value[]) as $item ((.hooks[$entry.key] // []);
            if any(.[]; . == $item) then . else . + [$item] end))
      end
  ' "$source" "$template" >"$output"
}

install_provider() {
  local name="$1" target template source output backup
  load_requirements "$name"
  target="$(provider_file "$name")"
  template="$(provider_template "$name")"
  [[ -f "$template" ]] || die "missing template: $template"
  if [[ "$name" == codex ]] && config_is_inline_codex; then
    printf 'agent-hooks provider=%s status=inline-config action=manual-merge\n' "$name" >&2
    return 1
  fi
  mkdir -p "$(dirname "$target")"
  source="$(mktemp)"
  output="$(mktemp)"
  if [[ -f "$target" ]]; then
    cp "$target" "$source"
  else
    printf '{"hooks":{}}\n' >"$source"
  fi
  if ! jq -e 'type == "object" and ((.hooks // {}) | type == "object")' "$source" >/dev/null 2>&1; then
    printf 'agent-hooks provider=%s status=invalid-config file=%s\n' "$name" "$target" >&2
    rm -f "$source" "$output"
    return 1
  fi
  if ! merge_config "$source" "$template" "$output"; then
    printf 'agent-hooks provider=%s status=invalid-config file=%s\n' "$name" "$target" >&2
    rm -f "$source" "$output"
    return 1
  fi
  if [[ -f "$target" ]] && cmp -s "$source" "$output"; then
    printf 'agent-hooks provider=%s status=unchanged file=%s\n' "$name" "$target"
    rm -f "$source" "$output"
    return 0
  fi
  if [[ -f "$target" ]]; then
    backup="$target.bak.$(date '+%Y%m%dT%H%M%S').$$"
    cp -p "$target" "$backup"
    printf 'agent-hooks provider=%s backup=%s\n' "$name" "$backup"
  fi
  chmod 600 "$output"
  mv "$output" "$target"
  rm -f "$source"
  printf 'agent-hooks provider=%s status=installed file=%s\n' "$name" "$target"
}

check_all() {
  local rc=0 name
  for name in claude codex; do
    check_provider "$name" || rc=1
  done
  return "$rc"
}

action="${1:-check}"
if [[ $# -gt 0 ]]; then shift; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider)
      [[ $# -ge 2 ]] || die 'missing value for --provider'
      provider="$2"
      shift 2
      ;;
    --provider=*) provider="${1#*=}"; shift ;;
    --quiet) quiet=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$action" in
  check)
    require_jq
    case "$provider" in
      all) check_all ;;
      claude|codex) check_provider "$provider" ;;
      *) die "unsupported provider: $provider" ;;
    esac
    ;;
  install)
    require_jq
    case "$provider" in
      all) install_provider claude; install_provider codex ;;
      claude|codex) install_provider "$provider" ;;
      *) die "unsupported provider: $provider" ;;
    esac
    ;;
  probe)
    test_script="$repo_root/tests/hook-units/test_agent_attention_adapters.sh"
    [[ -f "$test_script" ]] || die "missing adapter probe: $test_script"
    bash "$test_script"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
