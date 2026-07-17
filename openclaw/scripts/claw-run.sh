#!/usr/bin/env bash
# Preferred host-shell entry for YunsClaw agents (protocol hard habit, option A).
#
#   1) claw-exec-gate.sh  (rules → Grok → human_required?)
#   2) allow  → run the command
#   3) deny   → print gate JSON, exit 2, do NOT run
#
# Usage:
#   claw-run.sh [--force] [--dry-run] [--skip-llm] -- <argv…>
#   claw-run.sh [--force] [--dry-run] [--skip-llm] 'command string'
#   claw-run.sh git status
#
# After Feishu human yes on a danger command, re-run with --force (or
# CLAW_RUN_FORCE=1). Prefer quoting the exact same command string.
#
# Exit codes:
#   0  command ran (or --dry-run allowed)
#   2  human required / denied — command not run
#   3  usage
#   4  gate infrastructure failure (fail closed)
#   *  otherwise: exit code of the underlying command
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="${SCRIPT_DIR}/claw-exec-gate.sh"

FORCE=0
DRY_RUN=0
SKIP_LLM=0

if [[ "${CLAW_RUN_FORCE:-0}" == "1" || "${CLAW_RUN_FORCE:-}" == "yes" ]]; then
  FORCE=1
fi
if [[ "${CLAW_RUN_SKIP_LLM:-0}" == "1" ]]; then
  SKIP_LLM=1
fi

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --dry-run|--gate-only)
      DRY_RUN=1
      shift
      ;;
    --skip-llm)
      SKIP_LLM=1
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "claw-run: unknown flag: $1" >&2
      usage >&2
      exit 3
      ;;
    *)
      break
      ;;
  esac
done

if [[ $# -eq 0 ]]; then
  echo "claw-run: missing command" >&2
  usage >&2
  exit 3
fi

ARGS=("$@")
# Classifier sees a single string; argv form is joined with spaces.
CMD_STR="${ARGS[*]}"

[[ -x "${GATE}" ]] || {
  echo "claw-run: missing executable ${GATE}" >&2
  exit 4
}

run_command() {
  if [[ ${#ARGS[@]} -eq 1 ]]; then
    # One argument: treat as shell string (supports pipes, redirects, &&).
    bash -c "${ARGS[0]}"
  else
    "${ARGS[@]}"
  fi
}

if [[ "${FORCE}" -eq 1 ]]; then
  echo "claw-run: FORCE — gate skipped (human-confirmed path)" >&2
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo '{"decision":"allow","layer":"force","label":"force","reason":"CLAW_RUN_FORCE/--force","human_required":false}'
    exit 0
  fi
  run_command
  exit $?
fi

gate_flags=()
if [[ "${SKIP_LLM}" -eq 1 ]]; then
  gate_flags+=(--skip-llm)
fi

set +e
gate_json="$("${GATE}" "${gate_flags[@]}" "${CMD_STR}" 2>/dev/null)"
gate_ec=$?
set -e

if [[ -z "${gate_json}" ]]; then
  gate_json='{"decision":"deny","layer":"gate","label":"danger","reason":"empty gate output","human_required":true}'
  gate_ec=4
fi

# Always surface the gate decision for the agent / logs.
printf '%s\n' "${gate_json}" >&2

decision="$(
  printf '%s' "${gate_json}" | python3 -c 'import json,sys
try:
  print(json.load(sys.stdin).get("decision","deny"))
except Exception:
  print("deny")' 2>/dev/null || echo deny
)"
human="$(
  printf '%s' "${gate_json}" | python3 -c 'import json,sys
try:
  print("1" if json.load(sys.stdin).get("human_required") else "0")
except Exception:
  print("1")' 2>/dev/null || echo 1
)"

if [[ "${gate_ec}" -eq 0 && "${decision}" == "allow" && "${human}" != "1" ]]; then
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    printf '%s\n' "${gate_json}"
    exit 0
  fi
  run_command
  exit $?
fi

# Denied, need human, or infra fail — never run.
printf '%s\n' "${gate_json}"
if [[ "${gate_ec}" -eq 4 || "${gate_ec}" -eq 3 ]]; then
  exit "${gate_ec}"
fi
exit 2
