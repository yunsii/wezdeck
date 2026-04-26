#!/usr/bin/env bash
# Diagnostic for "agent enters waiting / running but the right-status
# counter doesn't update for N seconds". Joins WSL-side hook log and
# Windows-side wezterm log on tick_ms and prints a per-event waterfall
# with all four timestamps:
#
#   entry_ts_ms  → captured at hook script's first line (CLAUDE fired the
#                  hook this many ms after the visible UI appeared, modulo
#                  user-perceptible reaction; baseline for everything else)
#   emit_ts_ms   → after jq + flock + git + DCS write (entry → emit gap is
#                  in-script work)
#   tick_ms      → the value WezTerm received via SetUserVar; equal to the
#                  hook's emit_ts_ms (sub-ms apart, see emit-agent-status.sh)
#   tick_recv    → wezterm.log `tick received` ts (subject to WSL/Windows
#                  clock skew; sub-100ms latency is noise, seconds is signal)
#
# Usage:
#   scripts/dev/attention-latency-probe.sh                 # last 20 events
#   scripts/dev/attention-latency-probe.sh --last 50
#   scripts/dev/attention-latency-probe.sh --status waiting
#   scripts/dev/attention-latency-probe.sh --pane %2
#
# Flags:
#   --last N         only show the last N matching emit events (default 20)
#   --status STATE   filter to one of running|waiting|done|resolved|cleared|pane-evict
#   --pane PANE      filter to one tmux pane id (e.g. %1, %2)
#   --runtime-log P  override WSL-side log path
#   --wezterm-log P  override wezterm-side log path
#
# Anomaly markers in the output:
#   ⚠ INSCRIPT > 200ms     in-script work was slow (jq/flock/git contention)
#   ⚠ TICK > 500ms         OSC delivery (hook → wezterm) was slow
#   ✗ NO TICK              no `tick received` matched this tick_ms — fast
#                          path lost (DCS passthrough drop, wezterm
#                          unfocused, tmux backpressure, etc.)
#   ✗ NO RENDER            tick received but no render_status followed —
#                          attention.collect produced empty list (entry
#                          aged out by TTL, or rendered same signature as
#                          previous tick so log_rendered_status dedupes)

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/wsl-runtime-paths-lib.sh"
# shellcheck disable=SC1091
. "$repo_root/scripts/runtime/windows-runtime-paths-lib.sh"
windows_runtime_detect_paths >/dev/null 2>&1 || true

last=20
status_filter=''
pane_filter=''
runtime_log="$WSL_RUNTIME_LOG_FILE"
wezterm_log="${WINDOWS_RUNTIME_STATE_WSL}/logs/wezterm.log"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --last) last="$2"; shift 2 ;;
    --status) status_filter="$2"; shift 2 ;;
    --pane) pane_filter="$2"; shift 2 ;;
    --runtime-log) runtime_log="$2"; shift 2 ;;
    --wezterm-log) wezterm_log="$2"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) printf 'unknown flag: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [[ ! -r "$runtime_log" ]]; then
  printf 'runtime log not readable: %s\n' "$runtime_log" >&2
  exit 1
fi
if [[ ! -r "$wezterm_log" ]]; then
  printf 'wezterm log not readable: %s\n' "$wezterm_log" >&2
  exit 1
fi

# Pull recent emit + ignored + noop events into one normalized stream:
#   entry_ts_ms|emit_ts_ms|tick_ms|elapsed_ms|status|pane|session_short|notification|kind
# We tail a generous window (10x last) so filters still have material.
window=$(( last * 10 ))
if [[ "$window" -lt 200 ]]; then window=200; fi

emit_lines="$(tail -n "$window" "$runtime_log" \
  | grep -aE 'category="attention"' \
  | grep -aE 'message="(hook emitted agent status|notification ignored|hook resolved no-op)"' \
  || true)"

if [[ -z "$emit_lines" ]]; then
  printf 'no attention emit lines in last %d log lines of %s\n' \
    "$window" "$runtime_log" >&2
  exit 0
fi

extract_field() {
  # $1 = full log line, $2 = field name; prints field value or empty
  local line="$1" field="$2" rest
  rest="${line#*${field}=\"}"
  if [[ "$rest" == "$line" ]]; then printf ''; return; fi
  printf '%s' "${rest%%\"*}"
}

# Build the normalized stream into a temp file we can grep against.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

while IFS= read -r line; do
  # line is one ts="..." level="..." source="..." category="..." message="..." k=v ... record
  msg="$(extract_field "$line" 'message')"
  case "$msg" in
    'hook emitted agent status') kind=emit ;;
    'notification ignored')      kind=ignored ;;
    'hook resolved no-op')       kind=noop ;;
    *) continue ;;
  esac

  status="$(extract_field "$line" 'status')"
  pane="$(extract_field "$line" 'tmux_pane')"
  session="$(extract_field "$line" 'session_id')"
  tick="$(extract_field "$line" 'tick_ms')"
  entry="$(extract_field "$line" 'entry_ts_ms')"
  elapsed="$(extract_field "$line" 'elapsed_ms')"
  notif="$(extract_field "$line" 'notification_type')"
  ts_iso="$(extract_field "$line" 'ts')"

  # status filter
  if [[ -n "$status_filter" && "$status" != "$status_filter" ]]; then continue; fi
  # pane filter
  if [[ -n "$pane_filter" && "$pane" != "$pane_filter" ]]; then continue; fi

  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
    "${entry:--}" \
    "${tick:--}" \
    "${elapsed:--}" \
    "${status:--}" \
    "${pane:--}" \
    "${session:0:8}" \
    "${notif:--}" \
    "$kind" \
    "$ts_iso" \
    "$msg" \
    >> "$tmp"
done <<<"$emit_lines"

if [[ ! -s "$tmp" ]]; then
  printf 'no events match filter (status=%s pane=%s)\n' \
    "${status_filter:-*}" "${pane_filter:-*}" >&2
  exit 0
fi

# Trim to last $last entries
keep="$(tail -n "$last" "$tmp")"

# Pre-extract all tick received + render_status from wezterm.log into an
# associative array for O(1) lookup. We only need entries that mention
# the tick_ms values we'll be joining on, so grep narrows first.
tick_ms_list="$(printf '%s\n' "$keep" | awk -F'|' '$2 != "-" {print $2}' | sort -u)"

declare -A tick_recv_ts
declare -A tick_recv_pane
declare -A render_after

if [[ -n "$tick_ms_list" ]]; then
  # ERE alternation: literal `|`, not BRE-style `\|`.
  pattern="$(printf '%s|' $tick_ms_list)"
  pattern="${pattern%|}"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    msg="$(extract_field "$line" 'message')"
    ts_iso="$(extract_field "$line" 'ts')"
    case "$msg" in
      'tick received')
        value="$(extract_field "$line" 'value')"
        pane_id="$(extract_field "$line" 'pane_id')"
        latency="$(extract_field "$line" 'latency_ms')"
        if [[ -n "$value" ]]; then
          tick_recv_ts["$value"]="$ts_iso|$latency"
          tick_recv_pane["$value"]="$pane_id"
        fi
        ;;
      'render_status')
        # Mark "rendered close to ts_iso"; we use this later as the
        # rendered-after marker. Keyed by 1s bucket so any tick within
        # the same second can pair up.
        bucket="${ts_iso%%.*}"
        render_after["$bucket"]="$ts_iso"
        ;;
    esac
  done < <(grep -aE "tick received|render_status" "$wezterm_log" \
            | tail -n 5000 \
            | grep -aE "value=\"($pattern)\"|render_status")
fi

print_row() {
  local entry="$1" tick="$2" elapsed="$3" status="$4" pane="$5" session="$6" \
        notif="$7" kind="$8" ts_iso="$9"

  local recv_pair recv_ts recv_lat recv_pane
  recv_pair="${tick_recv_ts[$tick]:-}"
  if [[ -n "$recv_pair" ]]; then
    recv_ts="${recv_pair%%|*}"
    recv_lat="${recv_pair#*|}"
    recv_pane="${tick_recv_pane[$tick]:-}"
  else
    recv_ts=''
    recv_lat=''
    recv_pane=''
  fi

  local notes=()
  if [[ "$kind" == "emit" ]]; then
    if [[ -n "$elapsed" && "$elapsed" != "-" && "$elapsed" -gt 200 ]]; then
      notes+=("⚠INSCRIPT>${elapsed}ms")
    fi
    if [[ -z "$recv_ts" ]]; then
      notes+=("✗NO_TICK")
    elif [[ -n "$recv_lat" && "$recv_lat" != "-" && "$recv_lat" -gt 500 ]]; then
      notes+=("⚠TICK>${recv_lat}ms")
    fi
  fi

  # Pretty short ts (drop date)
  local short_ts="${ts_iso##* }"
  local short_recv="${recv_ts##* }"

  printf '%-12s  %-8s  %-9s  %-3s  %-9s  %-7s  %5s ms  %5s ms  recv@%-12s  pane=%-2s  notes=%s\n' \
    "$short_ts" \
    "$kind" \
    "$status" \
    "$pane" \
    "$session" \
    "${notif:-—}" \
    "${elapsed:-—}" \
    "${recv_lat:-—}" \
    "${short_recv:-MISSING}" \
    "${recv_pane:-—}" \
    "${notes[*]:-ok}"
}

# Header
printf '\n# attention latency waterfall (runtime.log ⨝ wezterm.log on tick_ms)\n'
printf '# runtime: %s\n' "$runtime_log"
printf '# wezterm: %s\n' "$wezterm_log"
printf '# rows : last %d emit/ignored/noop events (status=%s pane=%s)\n\n' \
  "$last" "${status_filter:-*}" "${pane_filter:-*}"

printf '%-12s  %-8s  %-9s  %-3s  %-9s  %-7s  %8s  %8s  %-19s  %-7s  %s\n' \
  'hook_ts' 'kind' 'status' 'tp' 'session' 'notif' 'inscript' 'cross' 'tick_recv' 'render_p' 'notes'
printf '%-12s  %-8s  %-9s  %-3s  %-9s  %-7s  %8s  %8s  %-19s  %-7s  %s\n' \
  '------------' '--------' '---------' '---' '---------' '-------' '--------' '--------' '-------------------' '-------' '-----'

while IFS='|' read -r entry tick elapsed status pane session notif kind ts_iso _msg; do
  print_row "$entry" "$tick" "$elapsed" "$status" "$pane" "$session" "$notif" "$kind" "$ts_iso"
done <<<"$keep"

cat <<'EOF'

# How to read this:
#   inscript = entry_ts_ms → emit_ts_ms gap (in-script work). Healthy
#              < 200 ms; > 500 ms means jq / flock / git is slow.
#   cross    = hook emit → wezterm `tick received` gap. WSL/Windows clock
#              drift is noise (sub-100 ms). Spikes into seconds = OSC
#              delivery problem (DCS passthrough drop, tmux backpressure,
#              wezterm event-loop stalled).
#   ✗NO_TICK = wezterm never logged a `tick received` for this emit's
#              tick_ms — the OSC was lost. Fall back to the periodic
#              250 ms `update-status` tick (which still re-renders, just
#              not within a frame).
#
# Repro for the parallel-waiting issue:
#   1. Open two tmux panes both with claude running in this repo
#   2. In pane A: ask claude to run a bash command needing permission
#   3. While the prompt is up, in pane B: do the same
#   4. Note wallclock when each visual prompt appears
#   5. Note wallclock when the `⚠ N waiting` counter updates to 1, then 2
#   6. Run this script — compare entry_ts of each `waiting` row to your
#      noted UI wallclock. If entry_ts lags the UI by seconds, the
#      latency is upstream in claude (hook fired late). If entry_ts
#      matches but `cross` spikes, the OSC pipeline is the problem.
EOF
