#!/usr/bin/env bash
# Cross-workspace tab-overflow picker. Bound to user-key User4 (Alt+x).
#
# Hot path: read precomputed <tab-stats>/overflow-base.tsv (maintained by
# tab-overflow-prefetch-build.sh on a WezTerm tick), stamp is_current +
# visible/warm/cold from live tmux sessions, sort, open Go picker.
# Cold path (missing cache): build once synchronously, then open.
#
# Selection routes through tab-overflow-dispatch.sh:
#   visible  → tab.activate_visible event
#   warm     → switch overflow pane + tab.activate_overflow
#   cold     → tab-overflow-cold-spawn.sh
#
# Empty-state handling:
#   - No base rows → toast "open a workspace first" / "no configured items".

set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$script_dir/menu-bench-lib.sh"
menu_bench_init
# shellcheck disable=SC1091
. "$script_dir/tab-stats-lib.sh"
# Paths/event only — avoid sourcing full worktree git stack on the hot path.
# shellcheck disable=SC1091
. "$script_dir/runtime-log-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/wezterm-event-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/picker-bin-lib.sh"
bench_mark sourced

menu_start_ts=$(( ${EPOCHREALTIME//./} / 1000 ))
start_ms=$menu_start_ts
trace_id="overflow-$EPOCHSECONDS-$$-$RANDOM"

session_name="${1:-}"
client_tty="${2:-}"

if [[ -z "$session_name" ]]; then
  session_name="$(tmux display-message -p '#{session_name}' 2>/dev/null || true)"
fi

current_workspace="$(tmux show-options -v -t "$session_name" @wezterm_workspace 2>/dev/null || true)"
if [[ -z "$current_workspace" ]]; then
  current_workspace="default"
fi

stats_dir="$(tab_stats_dir)"
base_tsv="$stats_dir/overflow-base.tsv"
build_script="$script_dir/tab-overflow-prefetch-build.sh"

# Ensure cache exists. Synchronous only on cold miss — the tick path
# should keep this warm. Force rebuild when WEZTERM_OVERFLOW_PREFETCH_FORCE=1.
if [[ ! -s "$base_tsv" || -n "${WEZTERM_OVERFLOW_PREFETCH_FORCE:-}" ]]; then
  bash "$build_script" 2>/dev/null || true
fi
bench_mark cache

if [[ ! -s "$base_tsv" ]]; then
  # Still empty after build: no items snapshots yet.
  shopt -s nullglob
  snaps=( "$stats_dir"/*-items.json )
  shopt -u nullglob
  if (( ${#snaps[@]} == 0 )); then
    tmux display-message -d 3000 \
      "Overflow picker: no workspace items snapshot yet (open a workspace under tab_visibility first)"
  else
    tmux display-message -d 2000 \
      "Overflow picker: no configured items across any workspace"
  fi
  exit 0
fi

existing_sessions="$(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)"
declare -A live_session_set=()
while IFS= read -r s; do
  [[ -n "$s" ]] && live_session_set["$s"]=1
done <<< "$existing_sessions"
bench_mark live_index

prefetch_file="$(mktemp -t wezterm-overflow-picker.XXXXXX)"
prefetch_aux="$(mktemp -t wezterm-overflow-picker-aux.XXXXXX)"
trap 'rm -f "$prefetch_file" "$prefetch_aux"' EXIT

# Base columns: workspace label cwd has_tab session snap_idx tier score events recent
# Stamp is_current + state, keep aux sort keys.
while IFS=$'\t' read -r ws label cwd has_tab sess snap_idx tier score events recent; do
  [[ -n "$ws" && -n "$cwd" ]] || continue
  is_current=0
  [[ "$ws" == "$current_workspace" ]] && is_current=1
  state='cold'
  if [[ "$has_tab" == "true" ]]; then
    state='visible'
  elif [[ -n "$sess" && -n "${live_session_set[$sess]:-}" ]]; then
    state='warm'
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$ws" "$label" "$cwd" "$state" "$has_tab" "$is_current" "$sess" \
    "$snap_idx" "$tier" "$score" "$events" "$recent"
done < "$base_tsv" > "$prefetch_aux"
bench_mark rows

if [[ -s "$prefetch_aux" ]]; then
  LC_ALL=C sort -t $'\t' \
    -k6,6nr -k9,9nr -k10,10gr -k11,11nr -k1,1 -k8,8n \
    "$prefetch_aux" \
    | awk -F '\t' 'BEGIN{OFS="\t"} {print $1,$2,$3,$4,$5,$6,$7}' \
    > "$prefetch_file"
fi
bench_mark sorted

if [[ ! -s "$prefetch_file" ]]; then
  tmux display-message -d 2000 \
    "Overflow picker: no configured items across any workspace"
  exit 0
fi

dispatch_script="$script_dir/tab-overflow-dispatch.sh"
picker_event_dir="$(wezterm_event_dir)"
mkdir -p "$picker_event_dir" 2>/dev/null || true

picker_binary=""
picker_rc=0
picker_binary="$(picker_bin_require "$script_dir" "Alt+x")" || picker_rc=$?
if (( picker_rc == 1 )); then
  exit 0
fi

if (( picker_rc == 2 )); then
  runtime_log_warn overflow "Go picker missing — WEZTERM_ALLOW_BASH_PICKER display-menu path" \
    "trace=$trace_id"
  declare -a menu_args
  item_count=0
  accelerator_chars='123456789abcdefghijklmnopqrstuvwxyz'
  while IFS=$'\t' read -r ws label cwd state has_tab is_current sess; do
    [[ "$is_current" == "1" ]] || continue
    local_marker='○'
    case "$state" in
      visible) local_marker='●' ;;
      warm)    local_marker='◐' ;;
    esac
    if (( item_count < ${#accelerator_chars} )); then
      accel="${accelerator_chars:$item_count:1}"
    else
      accel=""
    fi
    item_count=$(( item_count + 1 ))
    esc_cwd="${cwd//\"/\\\"}"
    esc_ws="${ws//\"/\\\"}"
    esc_has_tab="${has_tab//\"/\\\"}"
    menu_args+=("$local_marker $label" "$accel" \
      "run-shell -b \"bash $dispatch_script '$esc_ws' '$esc_cwd' '$esc_has_tab'\"")
  done < "$prefetch_file"
  if (( item_count == 0 )); then
    tmux display-message -d 2000 \
      "Overflow picker: workspace '$current_workspace' has no configured items"
    exit 0
  fi
  tmux display-menu -T "All sessions · $current_workspace · $item_count" \
    -x C -y C -- "${menu_args[@]}"
  # Refresh cache after popup so the next press is warm.
  ( bash "$build_script" >/dev/null 2>&1 & ) || true
  exit 0
fi

menu_done_ts=$(( ${EPOCHREALTIME//./} / 1000 ))
keypress_ts=0
bench_mark prep_done

item_count="$(wc -l < "$prefetch_file" | tr -d ' ')"
if menu_bench_active; then
  rm -f "$prefetch_file" "$prefetch_aux"
  menu_bench_dump_and_exit "picker_kind=go" "item_count=$item_count" "cache=1"
fi

picker_command="WEZTERM_RUNTIME_TRACE_ID=$(printf %q "$trace_id") WEZTERM_EVENT_FORCE_FILE=1 WEZBUS_EVENT_DIR=$(printf %q "$picker_event_dir") $(printf %q "$picker_binary") overflow $(printf %q "$prefetch_file") $(printf %q "$dispatch_script") $(printf %q "$keypress_ts") $(printf %q "$menu_start_ts") $(printf %q "$menu_done_ts")"

# Kick a background rebuild so the next press stays warm (has_tab /
# ranking refresh). Fire-and-forget; flock inside the builder.
( bash "$build_script" >/dev/null 2>&1 & ) || true

if bash "$script_dir/tmux-display-popup.sh" -x C -y C -w 80% -h 70% -T "Sessions across workspaces" -E "$picker_command"; then
  runtime_log_info overflow "popup completed" \
    "trace=$trace_id" "duration_ms=$(runtime_log_duration_ms "$start_ms")" \
    "item_count=$item_count" "path=cache"
  exit 0
fi

runtime_log_warn overflow "popup launch failed" "trace=$trace_id"
