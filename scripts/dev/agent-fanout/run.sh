#!/usr/bin/env bash
# agent-fanout CLI — thin wrapper over lib/fanout-lib.sh
#
#   run.sh selfcheck [backends...]
#   run.sh providers
#   run.sh run  [options]   # same prompt → backends (N=1 ok; --print for body)
#   run.sh jobs [options]   # --job name|backend|prompt_file
#   run.sh [options]        # alias of run
#
# Single-shot without disk: use fanout_call from a sourced shell, or:
#   run.sh run --backend claude --prompt '...' --print
#
# Multi-shot layout under --out:
#   prompt.md, <stem>.md, <stem>.log, <stem>.meta.json, summary.json
#
# Exit: 0 ok · 1 usage · 2 no backend · 3 partial · 4 total fail · 5 internal

set -euo pipefail

tool_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$tool_root/lib/fanout-lib.sh"

die() { printf 'error: %s\n' "$*" >&2; exit "${2:-1}"; }
usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; }

cmd_selfcheck() { bash "$_FANOUT_PROVIDER" selfcheck "$@"; }
cmd_providers() { bash "$_FANOUT_PROVIDER" providers; }

_print_summary() {
  local want_json="$1" out_dir="${FANOUT_OUT:-}"
  [ -n "$out_dir" ] && [ -f "$out_dir/summary.json" ] || return 0
  if [ "$want_json" -eq 1 ]; then
    cat "$out_dir/summary.json"; echo
  else
    jq -r '"overall=" + .overall + " ok=" + (.counts.ok|tostring) + " fail=" + (.counts.fail|tostring) + " out=" + .out' \
      "$out_dir/summary.json"
    jq -r '.backends[]? | "  " + (.name // .backend) + "  status=" + .status + "  model=" + .model + "  bytes=" + (.bytes|tostring) + "  " + (.elapsed_sec|tostring) + "s"' \
      "$out_dir/summary.json" 2>/dev/null || true
  fi
}

cmd_run() {
  local want_json=0
  local -a args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) want_json=1; shift ;;
      -h|--help) usage; return 0 ;;
      *) args+=("$1"); shift ;;
    esac
  done
  set +e
  fanout_run "${args[@]}"
  local rc=$?
  set -e
  # --print already emitted body; still show summary on stderr path via log
  _print_summary "$want_json"
  return "$rc"
}

cmd_jobs() {
  local want_json=0
  local -a args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) want_json=1; shift ;;
      -h|--help) usage; return 0 ;;
      *) args+=("$1"); shift ;;
    esac
  done
  set +e
  fanout_run_jobs "${args[@]}"
  local rc=$?
  set -e
  _print_summary "$want_json"
  return "$rc"
}

main() {
  local sub="${1:-}"
  case "$sub" in
    selfcheck) shift; cmd_selfcheck "$@" ;;
    providers) shift; cmd_providers "$@" ;;
    run) shift; cmd_run "$@" ;;
    jobs) shift; cmd_jobs "$@" ;;
    -h|--help|help) usage ;;
    "") usage; exit 1 ;;
    --*) cmd_run "$@" ;;
    *) die "unknown subcommand: $sub (try: run | jobs | selfcheck | providers)" 1 ;;
  esac
}

main "$@"
