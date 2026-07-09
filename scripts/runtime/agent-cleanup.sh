#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"

usage() {
  cat <<'EOF'
usage:
  agent-cleanup.sh [--dry-run|--kill] [--min-age <duration>] [--agent all|codex|claude]
                   [--signal TERM|HUP|INT|KILL] [--include-tty]

Cleans up stale managed-agent resume processes, especially detached
codex resume --last / claude --continue chains left behind after tmux or
WezTerm teardown.

Defaults:
  --dry-run
  --min-age 12h
  --agent all
  --signal TERM

Duration accepts plain seconds or a suffix: s, m, h, d.
By default only processes with TTY=? are candidates; use --include-tty only
for manual recovery when you explicitly want to include attached panes.
EOF
}

parse_duration_seconds() {
  local value="${1:-}"
  local number suffix

  if [[ "$value" =~ ^([0-9]+)([smhd]?)$ ]]; then
    number="${BASH_REMATCH[1]}"
    suffix="${BASH_REMATCH[2]}"
  else
    printf 'invalid duration: %s\n' "$value" >&2
    return 1
  fi

  case "$suffix" in
    ''|s) printf '%s\n' "$number" ;;
    m) printf '%s\n' "$((number * 60))" ;;
    h) printf '%s\n' "$((number * 60 * 60))" ;;
    d) printf '%s\n' "$((number * 24 * 60 * 60))" ;;
    *) return 1 ;;
  esac
}

format_duration() {
  local seconds="${1:-0}"
  local days hours minutes

  [[ "$seconds" =~ ^[0-9]+$ ]] || seconds=0
  days=$((seconds / 86400))
  hours=$(((seconds % 86400) / 3600))
  minutes=$(((seconds % 3600) / 60))

  if (( days > 0 )); then
    printf '%dd%02dh' "$days" "$hours"
  elif (( hours > 0 )); then
    printf '%dh%02dm' "$hours" "$minutes"
  else
    printf '%dm' "$minutes"
  fi
}

matches_agent_resume() {
  local selected_agent="$1"
  local args="$2"

  case "$selected_agent" in
    all)
      [[ "$args" == *"codex resume --last"* || "$args" == *"claude --continue"* ]]
      ;;
    codex)
      [[ "$args" == *"codex resume --last"* ]]
      ;;
    claude)
      [[ "$args" == *"claude --continue"* ]]
      ;;
    *)
      return 1
      ;;
  esac
}

mode="dry-run"
min_age_raw="${WEZTERM_AGENT_CLEANUP_MIN_AGE:-12h}"
agent="all"
signal_name="${WEZTERM_AGENT_CLEANUP_SIGNAL:-TERM}"
require_no_tty=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      mode="dry-run"
      shift
      ;;
    --kill)
      mode="kill"
      shift
      ;;
    --min-age)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      min_age_raw="$2"
      shift 2
      ;;
    --agent)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      agent="$2"
      shift 2
      ;;
    --signal)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      signal_name="$2"
      shift 2
      ;;
    --include-tty)
      require_no_tty=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'agent-cleanup: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$agent" in
  all|codex|claude) ;;
  *)
    printf 'agent-cleanup: invalid --agent value: %s\n' "$agent" >&2
    exit 2
    ;;
esac

case "$signal_name" in
  TERM|HUP|INT|KILL) ;;
  *)
    printf 'agent-cleanup: unsupported --signal value: %s\n' "$signal_name" >&2
    exit 2
    ;;
esac

min_age_seconds="$(parse_duration_seconds "$min_age_raw")"
own_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d '[:space:]')"

declare -A group_pids=()
declare -A group_age=()
declare -A group_cpu=()
declare -A group_tty=()
declare -A group_command=()
declare -a groups=()

while read -r pid ppid pgid tty etimes pcpu stat args; do
  [[ -n "${pid:-}" && -n "${pgid:-}" && -n "${args:-}" ]] || continue
  [[ "$pid" =~ ^[0-9]+$ && "$pgid" =~ ^[0-9]+$ && "$etimes" =~ ^[0-9]+$ ]] || continue
  [[ "$pgid" != "$own_pgid" ]] || continue
  [[ "$args" != *"agent-cleanup.sh"* && "$args" != *"scripts/runtime/cli/agent-cleanup"* ]] || continue
  (( etimes >= min_age_seconds )) || continue
  if (( require_no_tty == 1 )) && [[ "$tty" != "?" ]]; then
    continue
  fi
  matches_agent_resume "$agent" "$args" || continue

  if [[ -z "${group_pids[$pgid]:-}" ]]; then
    groups+=("$pgid")
    group_pids[$pgid]="$pid"
    group_age[$pgid]="$etimes"
    group_cpu[$pgid]="$pcpu"
    group_tty[$pgid]="$tty"
    group_command[$pgid]="$args"
  else
    group_pids[$pgid]="${group_pids[$pgid]},$pid"
    if (( etimes > group_age[$pgid] )); then
      group_age[$pgid]="$etimes"
    fi
    awk -v a="$pcpu" -v b="${group_cpu[$pgid]}" 'BEGIN { exit !(a > b) }' && group_cpu[$pgid]="$pcpu"
  fi
done < <(ps -eo pid=,ppid=,pgid=,tty=,etimes=,pcpu=,stat=,args=)

printf 'agent-cleanup mode=%s agent=%s min_age=%s signal=%s require_no_tty=%s\n' \
  "$mode" "$agent" "$min_age_raw" "$signal_name" "$require_no_tty"

if (( ${#groups[@]} == 0 )); then
  printf 'no stale managed-agent resume process groups found.\n'
  runtime_log_info agent_cleanup "scan completed" \
    "mode=$mode" "agent=$agent" "min_age_seconds=$min_age_seconds" \
    "require_no_tty=$require_no_tty" "groups=0"
  exit 0
fi

printf '%-8s %-22s %-8s %-7s %-5s %s\n' "PGID" "PIDS" "AGE" "CPU%" "TTY" "COMMAND"

failed=0
killed=0
for pgid in "${groups[@]}"; do
  command="${group_command[$pgid]}"
  if (( ${#command} > 120 )); then
    command="${command:0:117}..."
  fi

  printf '%-8s %-22s %-8s %-7s %-5s %s\n' \
    "$pgid" "${group_pids[$pgid]}" "$(format_duration "${group_age[$pgid]}")" \
    "${group_cpu[$pgid]}" "${group_tty[$pgid]}" "$command"

  if [[ "$mode" == "kill" ]]; then
    if kill "-$signal_name" -- "-$pgid" 2>/dev/null; then
      killed=$((killed + 1))
      runtime_log_warn agent_cleanup "terminated stale agent process group" \
        "pgid=$pgid" "pids=${group_pids[$pgid]}" "age_seconds=${group_age[$pgid]}" \
        "max_cpu=${group_cpu[$pgid]}" "tty=${group_tty[$pgid]}" "signal=$signal_name" \
        "command=${group_command[$pgid]}"
    else
      failed=$((failed + 1))
      runtime_log_error agent_cleanup "failed to terminate stale agent process group" \
        "pgid=$pgid" "pids=${group_pids[$pgid]}" "signal=$signal_name"
    fi
  fi
done

runtime_log_info agent_cleanup "scan completed" \
  "mode=$mode" "agent=$agent" "min_age_seconds=$min_age_seconds" \
  "require_no_tty=$require_no_tty" "groups=${#groups[@]}" "killed=$killed" "failed=$failed"

if [[ "$mode" == "dry-run" ]]; then
  printf 'dry-run only; rerun with --kill to terminate these process groups.\n'
elif (( failed > 0 )); then
  printf 'terminated=%d failed=%d\n' "$killed" "$failed" >&2
  exit 1
else
  printf 'terminated=%d\n' "$killed"
fi
