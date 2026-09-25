#!/usr/bin/env bash
# Read-only WezDeck environment check orchestrator.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/../../.." && pwd -P)"
# shellcheck disable=SC1091
source "$repo_root/scripts/runtime/runtime-env-lib.sh"
runtime_env_load_managed
runtime_env_add_user_cli_paths
advisory=0
skip_deps=0
timeout_seconds=10
prefix=""

usage() {
  cat <<'EOF'
Usage:
  skills/wezdeck-runtime-ops/scripts/check-runtime.sh [options]

Options:
  --advisory          Always exit 0; report failed checks as warnings.
  --skip-deps         Skip the network-backed upstream dependency check.
  --timeout SECONDS   Upstream dependency timeout (default: 10).
  --prefix STR        Prefix every output line.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --advisory) advisory=1; shift ;;
    --skip-deps) skip_deps=1; shift ;;
    --timeout) timeout_seconds="${2:-}"; shift 2 ;;
    --prefix) prefix="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf '%sunknown argument: %s\n' "$prefix" "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$timeout_seconds" =~ ^[0-9]+$ ]] || {
  printf '%sinvalid timeout: %s\n' "$prefix" "$timeout_seconds" >&2
  exit 2
}

failures=0
check_count=0

emit() {
  printf '%s%s\n' "$prefix" "$1"
}

run_check() {
  local name="$1"
  shift
  local output_file=""
  local rc=0
  local line=""

  check_count=$((check_count + 1))

  output_file="$(mktemp "${TMPDIR:-/tmp}/wezdeck-runtime-check.XXXXXX")"
  if "$@" >"$output_file" 2>&1; then
    rc=0
  else
    rc=$?
  fi

  if (( rc == 0 )); then
    emit "[runtime-check] check=$name status=healthy"
  else
    failures=$((failures + 1))
    emit "[runtime-check] check=$name status=warning rc=$rc"
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    emit "[runtime-check] check=$name output=$line"
  done < "$output_file"
  rm -f "$output_file"
}

run_advisory_check() {
  local name="$1"
  shift
  local output_file=""
  local rc=0
  local line=""

  check_count=$((check_count + 1))
  output_file="$(mktemp "${TMPDIR:-/tmp}/wezdeck-runtime-check.XXXXXX")"
  if "$@" >"$output_file" 2>&1; then
    rc=0
  else
    rc=$?
  fi

  if (( rc == 0 )); then
    emit "[runtime-check] check=$name status=healthy"
  else
    # Optional integrations must be visible without making the base runtime
    # check fail. The check itself provides the actionable install command.
    emit "[runtime-check] check=$name status=warning rc=$rc advisory=1"
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    emit "[runtime-check] check=$name output=$line"
  done < "$output_file"
  rm -f "$output_file"
}

check_agent_tools_marker() {
  local marker="$HOME/.wezterm-x/agent-tools.env"
  local version=""
  local key=""
  local value=""

  [[ -f "$marker" ]] || {
    printf 'marker missing: %s\n' "$marker"
    return 1
  }
  version="$(sed -n 's/^version=//p' "$marker" | head -n1)"
  [[ "$version" == 1 ]] || {
    printf 'unsupported marker version: %s\n' "${version:-missing}"
    return 1
  }
  for key in repo_root agent_clipboard open_file_in_vscode wd_run; do
    value="$(sed -n "s/^${key}=//p" "$marker" | head -n1)"
    [[ -n "$value" && -x "$value" ]] || {
      printf 'marker key unavailable: %s=%s\n' "$key" "${value:-missing}"
      return 1
    }
  done
}

check_managed_agent_cli() {
  local profile="${MANAGED_AGENT_PROFILE:-}"
  local binary=""

  [[ -n "$profile" ]] || {
    printf 'MANAGED_AGENT_PROFILE is unset\n'
    return 1
  }
  case "$profile" in
    claude|claude_sub2api|claude-sub2api) binary=claude ;;
    codex) binary=codex ;;
    grok) binary=grok ;;
    *)
      printf 'unsupported MANAGED_AGENT_PROFILE: %s\n' "$profile"
      return 1
      ;;
  esac
  command -v "$binary" >/dev/null 2>&1 || {
    printf 'managed agent binary unavailable: profile=%s binary=%s\n' \
      "$profile" "$binary"
    return 1
  }
  printf 'managed agent binary: profile=%s path=%s\n' \
    "$profile" "$(command -v "$binary")"
}

check_lua_source_syntax() {
  local luac_bin=""
  local lua_file=""
  local errors=""

  for candidate in luac5.4 luac5.3 luac; do
    if command -v "$candidate" >/dev/null 2>&1; then
      luac_bin="$candidate"
      break
    fi
  done
  [[ -n "$luac_bin" ]] || {
    printf 'luac unavailable; source syntax was not checked\n'
    return 1
  }

  while IFS= read -r -d '' lua_file; do
    local err=""
    if ! err="$("$luac_bin" -p "$lua_file" 2>&1)"; then
      errors+="$lua_file: $err\n"
    fi
  done < <(find "$repo_root/wezterm-x" -type f -name '*.lua' -print0)

  if [[ -n "$errors" ]]; then
    printf '%b' "$errors"
    return 1
  fi
}

check_lua_precheck() {
  local lua_bin=""
  local candidate=""
  local runtime_dir=""
  local rc=0

  for candidate in lua5.4 lua5.3 lua; do
    if command -v "$candidate" >/dev/null 2>&1; then
      lua_bin="$candidate"
      break
    fi
  done
  [[ -n "$lua_bin" ]] || {
    printf 'lua runtime unavailable; managed config precheck was not run\n'
    return 1
  }

  runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/wezdeck-lua-precheck.XXXXXX")"
  ln -s "$repo_root/wezterm-x/lua" "$runtime_dir/lua"
  ln -s "$repo_root/wezterm-x/local" "$runtime_dir/local"
  if [[ ! -f "$repo_root/config/worktree-task.env" ]]; then
    printf 'missing config/worktree-task.env for managed config precheck\n'
    rm -rf "$runtime_dir"
    return 1
  fi
  cp -p "$repo_root/config/worktree-task.env" "$runtime_dir/repo-worktree-task.env"
  printf '%s\n' "$repo_root" > "$runtime_dir/repo-root.txt"

  "$lua_bin" "$script_dir/lua-precheck.lua" "$runtime_dir" || rc=$?
  rm -rf "$runtime_dir"
  return "$rc"
}

agent_hooks_script="$repo_root/scripts/dev/agent-hooks.sh"
node_runtime_script="$repo_root/scripts/dev/check-node-runtime.sh"
deps_script="$repo_root/scripts/dev/check-deps-updates.sh"

if [[ -x "$agent_hooks_script" ]]; then
  run_check agent-hooks "$agent_hooks_script" check --provider all
else
  failures=$((failures + 1))
  emit '[runtime-check] check=agent-hooks status=warning reason=script_missing'
fi

run_check agent-tools check_agent_tools_marker
run_check managed-agent-cli check_managed_agent_cli
run_check agent-launcher bash "$repo_root/tests/agent-launcher/test.sh"
run_check agent-resume-lockstep bash \
  "$repo_root/tests/tmux-reset/cases/21-managed-primary-command-lockstep.sh"
run_check workspace-agent-map bash \
  "$repo_root/tests/tmux-reset/cases/22-resume-command-respects-workspace-agent-map.sh"
run_check lua-source-syntax check_lua_source_syntax
run_check lua-precheck check_lua_precheck

if [[ -x "$node_runtime_script" ]]; then
  run_check node-runtime "$node_runtime_script"
else
  failures=$((failures + 1))
  emit '[runtime-check] check=node-runtime status=warning reason=script_missing'
fi

rime_counter_script="$repo_root/scripts/dev/check-rime-commit-counter.sh"
if [[ -x "$rime_counter_script" ]]; then
  run_advisory_check rime-commit-counter "$rime_counter_script"
else
  emit '[runtime-check] check=rime-commit-counter status=warning advisory=1 reason=script_missing'
fi

if (( skip_deps )); then
  emit '[runtime-check] check=dependencies status=skipped reason=cli_override'
elif [[ -x "$deps_script" ]]; then
  run_check dependencies "$deps_script" --no-color --timeout "$timeout_seconds"
else
  failures=$((failures + 1))
  emit '[runtime-check] check=dependencies status=warning reason=script_missing'
fi

if (( failures == 0 )); then
  emit "[runtime-check] summary status=healthy checks=$check_count"
  exit 0
fi

emit "[runtime-check] summary status=warning failed=$failures advisory=$advisory"
if (( advisory )); then
  exit 0
fi
exit 1
