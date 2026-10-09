#!/usr/bin/env bash
# One-shot attention pipeline health check.
#
# Catches the 2026-10-09 failure mode: a sparse / orphan mux rewrites
# live-panes.json to sessions:{} while hooks still emit running/done,
# so badges look "stuck" or never light. Read-only; safe during sync.
#
# Usage:
#   scripts/dev/attention-health.sh           # human summary
#   scripts/dev/attention-health.sh --quiet   # exit status only (+ one line)
#   scripts/dev/attention-health.sh --json    # machine-readable envelope
#
# Exit:
#   0  healthy
#   1  warning (advisory — sync continues)
#   2  usage / missing deps
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd -P)"

# shellcheck disable=SC1091
source "$repo_root/scripts/runtime/windows-runtime-paths-lib.sh"
# shellcheck disable=SC1091
source "$repo_root/scripts/runtime/attention-state-lib.sh"

quiet=0
json=0

usage() {
  cat <<'EOF'
usage:
  scripts/dev/attention-health.sh [--quiet] [--json]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quiet) quiet=1; shift ;;
    --json) json=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'attention-health: unknown arg: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || {
  printf 'attention-health: jq is required\n' >&2
  exit 2
}

attention_path="$(attention_state_path)"
live_path="$(attention_live_panes_path)"
# attention.json lives under …/state/agent-attention/; pane-session is a
# sibling under …/state/.
pane_session_dir="$(cd "$(dirname "$attention_path")/.." && pwd)/pane-session"

warnings=()
info_bits=()

add_warn() { warnings+=("$1"); }
add_info() { info_bits+=("$1"); }

now_ms="$(
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    awk -v t="$EPOCHREALTIME" 'BEGIN { printf "%d", t * 1000 }'
  else
    date +%s%3N
  fi
)"

entry_count=0
running_n=0
waiting_n=0
done_n=0
if [[ -f "$attention_path" ]]; then
  read -r entry_count running_n waiting_n done_n < <(
    jq -r '
      (.entries // {}) as $e
      | [
          ($e | length),
          ([ $e[] | select(.status=="running") ] | length),
          ([ $e[] | select(.status=="waiting") ] | length),
          ([ $e[] | select(.status=="done") ] | length)
        ]
      | @tsv
    ' "$attention_path"
  )
  add_info "attention_entries=${entry_count} running=${running_n} waiting=${waiting_n} done=${done_n}"
else
  add_warn "attention.json missing at ${attention_path}"
fi

sessions_n=0
panes_n=0
live_age_ms=-1
live_ts=0
if [[ -f "$live_path" ]]; then
  read -r sessions_n panes_n live_ts < <(
    jq -r '
      [
        ((.sessions // {}) | length),
        ((.panes // {}) | length),
        (.ts // 0)
      ] | @tsv
    ' "$live_path"
  )
  if [[ "$live_ts" =~ ^[0-9]+$ ]] && (( live_ts > 0 )); then
    live_age_ms=$(( now_ms - live_ts ))
    # Guard clock skew / string overflow
    if (( live_age_ms < 0 )); then live_age_ms=0; fi
  fi
  add_info "live_panes sessions=${sessions_n} panes=${panes_n} age_ms=${live_age_ms}"
else
  add_warn "live-panes.json missing at ${live_path}"
fi

pane_session_n=0
if [[ -d "$pane_session_dir" ]]; then
  pane_session_n="$(find "$pane_session_dir" -maxdepth 1 -type f -name '*.txt' 2>/dev/null | wc -l | tr -d ' ')"
  add_info "pane_session_files=${pane_session_n}"
fi

# --- failure-mode signals (2026-10-09) ---------------------------------
live_entries=$(( running_n + waiting_n + done_n ))

if (( sessions_n == 0 )) && (( live_entries > 0 )); then
  add_warn "live-panes sessions={} while attention has ${live_entries} live entr(y/ies) — orphan/sparse mux likely; badges may vanish within ~1s under old sweep"
fi

if (( sessions_n == 0 )) && (( pane_session_n >= 3 )) && (( panes_n <= 1 )); then
  add_warn "live-panes looks sparse (panes=${panes_n} sessions=0) but pane-session has ${pane_session_n} files — primary mux not publishing"
fi

if (( live_age_ms >= 0 )) && (( live_age_ms > 15000 )) && (( pane_session_n >= 1 )); then
  add_warn "live-panes.json stale age_ms=${live_age_ms} (>15s) — snapshot writer may be on a dead/idle GUI"
fi

# Optional: wezterm CLI pane count (best-effort; may attach to wrong mux).
wezterm_bin=""
for cand in \
  "/mnt/e/Program Files/WezTerm/wezterm.exe" \
  "/mnt/c/Program Files/WezTerm/wezterm.exe" \
  "$(command -v wezterm.exe 2>/dev/null || true)" \
  "$(command -v wezterm 2>/dev/null || true)"; do
  if [[ -n "$cand" && -x "$cand" ]]; then
    wezterm_bin="$cand"
    break
  fi
done

cli_panes=-1
if [[ -n "$wezterm_bin" ]]; then
  cli_out="$("$wezterm_bin" cli list 2>/dev/null || true)"
  if [[ -n "$cli_out" ]]; then
    # Header + rows; count non-header lines
    cli_panes="$(printf '%s\n' "$cli_out" | awk 'NR>1 && NF {c++} END{print c+0}')"
    add_info "wezterm_cli_panes=${cli_panes}"
    if (( cli_panes <= 1 )) && (( pane_session_n >= 3 )); then
      add_warn "wezterm cli list sees ${cli_panes} pane(s) while pane-session has ${pane_session_n} files — CLI attached to sparse/orphan mux; close idle default WezTerm window"
    fi
  fi
fi

# Recent archive burst: many forgets in wezterm.log today is a smell,
# but reading the full Windows log is optional/slow — skip by default.

status="healthy"
rc=0
if (( ${#warnings[@]} > 0 )); then
  status="warning"
  rc=1
fi

if [[ "$json" == "1" ]]; then
  jq -n \
    --arg status "$status" \
    --arg attention_path "$attention_path" \
    --arg live_path "$live_path" \
    --argjson entry_count "$entry_count" \
    --argjson running_n "$running_n" \
    --argjson waiting_n "$waiting_n" \
    --argjson done_n "$done_n" \
    --argjson sessions_n "$sessions_n" \
    --argjson panes_n "$panes_n" \
    --argjson live_age_ms "$live_age_ms" \
    --argjson pane_session_n "$pane_session_n" \
    --argjson cli_panes "$cli_panes" \
    --argjson warnings "$(printf '%s\n' "${warnings[@]+"${warnings[@]}"}" | jq -R . | jq -s .)" \
    --argjson info "$(printf '%s\n' "${info_bits[@]+"${info_bits[@]}"}" | jq -R . | jq -s .)" \
    '{
      status:$status,
      attention_path:$attention_path,
      live_path:$live_path,
      entries:{total:$entry_count, running:$running_n, waiting:$waiting_n, done:$done_n},
      live_panes:{sessions:$sessions_n, panes:$panes_n, age_ms:$live_age_ms},
      pane_session_files:$pane_session_n,
      wezterm_cli_panes:$cli_panes,
      warnings:$warnings,
      info:$info
    }'
  exit "$rc"
fi

if [[ "$quiet" == "1" ]]; then
  if (( rc == 0 )); then
    printf 'attention-health status=healthy entries=%s sessions=%s\n' \
      "$entry_count" "$sessions_n"
  else
    printf 'attention-health status=warning count=%s\n' "${#warnings[@]}"
    printf '  %s\n' "${warnings[@]}"
  fi
  exit "$rc"
fi

printf 'attention-health status=%s\n' "$status"
printf '  attention: %s\n' "$attention_path"
printf '  live-panes: %s\n' "$live_path"
for line in "${info_bits[@]+"${info_bits[@]}"}"; do
  printf '  %s\n' "$line"
done
if (( ${#warnings[@]} > 0 )); then
  printf 'warnings:\n'
  for w in "${warnings[@]}"; do
    printf '  - %s\n' "$w"
  done
  printf 'triage: docs/diagnostics.md (attention stuck / live-panes orphan mux)\n'
  printf 'logs: grep -aE \"sweep skipped|refuse to clobber|forget entry\" \\\n'
  printf '        \"%%LOCALAPPDATA%%/wezterm-runtime/logs/wezterm.log\"\n'
fi

exit "$rc"
