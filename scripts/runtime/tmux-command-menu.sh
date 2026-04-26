#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/tmux-command-panel-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/windows-runtime-paths-lib.sh"

# Microbench short-circuit, mirrors tmux-attention-menu.sh. When
# WEZTERM_BENCH_NO_POPUP=1 is set, every `bench_mark <stage>` records
# µs-since-start via EPOCHREALTIME (zero-fork bash builtin) and the
# script dumps a `__BENCH__` line + exits before display-popup so the
# user's tmux is never disrupted. Drives scripts/dev/bench-menu-prep.sh
# with `--target command`.
if [[ -n "${WEZTERM_BENCH_NO_POPUP:-}" ]]; then
  bench_marks=()
  bench_t0="${EPOCHREALTIME//./}"
  bench_mark() { bench_marks+=("$1=$((${EPOCHREALTIME//./} - bench_t0))"); }
else
  bench_mark() { :; }
fi
bench_mark sourced

session_name="${1:-}"
current_window_id="${2:-}"
cwd="${3:-$PWD}"
trigger_source="${4:-unknown}"
client_tty="${5:-}"
runtime_mode="$(command_panel_runtime_mode)"
start_ms="$(runtime_log_now_ms)"
trace_id="$(runtime_log_current_trace_id)"

if [[ -z "$session_name" ]]; then
  runtime_log_error command_panel "command panel failed: missing tmux session" "current_window_id=$current_window_id" "cwd=$cwd"
  tmux display-message 'Command palette failed: missing tmux session'
  exit 1
fi

if ! tmux has-session -t "$session_name" 2>/dev/null; then
  runtime_log_error command_panel "command panel failed: missing tmux session target" "session_name=$session_name" "current_window_id=$current_window_id" "cwd=$cwd"
  tmux display-message "Command palette failed: missing session $session_name"
  exit 1
fi

# Toggle handshake: tmux's user-keys translation (`\e[20099~` → User0)
# is consumed at the client level when a popup is already up, so
# `bind-key -n User0` never re-fires for the second press. A picker-side
# toggle is impossible (popup pty receives nothing) AND a menu-side
# toggle is impossible (this script never re-runs). The fix lives on
# the wezterm side: the `command_palette.open` Lua handler always fires
# regardless of popup state, so it io.open()'s this flag file before
# forwarding. If it sees the file, it spawns `tmux display-popup -C`
# directly and skips the user-key forward. menu.sh's job here is just
# to keep the flag accurate around the popup lifecycle.
windows_runtime_detect_paths || true
toggle_flag_dir="${WINDOWS_RUNTIME_STATE_WSL:-$HOME/.local/state/wezterm-runtime}/state/command-panel"
toggle_flag_file="$toggle_flag_dir/popup-open.flag"

command_panel_load_items || {
  tmux display-message 'Command palette failed while loading items'
  exit 1
}
bench_mark loaded_items

mapfile -t visible_indexes < <(command_panel_visible_indexes "$runtime_mode")
if (( ${#visible_indexes[@]} == 0 )); then
  runtime_log_warn command_panel "command panel has no visible items" "runtime_mode=$runtime_mode" "session_name=$session_name"
  tmux display-message "No command palette items are available for $runtime_mode"
  exit 0
fi
bench_mark visible_indexes

runtime_log_info command_panel "opening tmux command panel" "runtime_mode=$runtime_mode" "session_name=$session_name" "item_count=${#visible_indexes[@]}" "trigger_source=$trigger_source"

# Prefer the static Go picker binary when present. Cold start is ~2-5ms
# vs ~30-80ms for the bash picker; the picker also avoids re-running
# `command_panel_load_items` inside the popup pty (~50ms) by consuming
# the prefetched TSV we build here. When the binary is missing, fall
# back to the bash picker, which still expects positional args via
# tmux-command-picker.sh.
repo_root="$(cd "$script_dir/../.." && pwd)"
picker_binary="$repo_root/native/picker/bin/picker"
prefetch_file=""
picker_kind='bash'

if [[ -x "$picker_binary" ]]; then
  # tmux-command-picker.sh (bash fallback) reads @wezterm_last_command_id
  # itself; only the Go path needs this menu-side read.
  last_command_id="$(tmux show-option -gv @wezterm_last_command_id 2>/dev/null || true)"
  prefetch_file="$(mktemp -t wezterm-command-picker.XXXXXX)"
  # Build the whole TSV with one redirect: each field gets stripped of
  # tab/newline/CR via parameter expansion only (no subshell, no `tr`
  # fork) so the loop stays in-process. Six fields, 29-ish items —
  # previous `$(... | tr ...)` per field cost ~260ms on WSL2.
  {
    for index in "${visible_indexes[@]}"; do
      f_id="${COMMAND_PANEL_IDS[$index]}";              f_id="${f_id//$'\t'/ }";    f_id="${f_id//$'\n'/ }";    f_id="${f_id//$'\r'/ }"
      f_label="${COMMAND_PANEL_LABELS[$index]}";        f_label="${f_label//$'\t'/ }"; f_label="${f_label//$'\n'/ }"; f_label="${f_label//$'\r'/ }"
      f_desc="${COMMAND_PANEL_DESCRIPTIONS[$index]}";   f_desc="${f_desc//$'\t'/ }"; f_desc="${f_desc//$'\n'/ }"; f_desc="${f_desc//$'\r'/ }"
      f_accel="${COMMAND_PANEL_ACCELERATORS[$index]:-}"; f_accel="${f_accel//$'\t'/ }"; f_accel="${f_accel//$'\n'/ }"; f_accel="${f_accel//$'\r'/ }"
      f_hotkey="${COMMAND_PANEL_HOTKEYS[$index]:-}";    f_hotkey="${f_hotkey//$'\t'/ }"; f_hotkey="${f_hotkey//$'\n'/ }"; f_hotkey="${f_hotkey//$'\r'/ }"
      f_confirm="${COMMAND_PANEL_CONFIRM_MESSAGES[$index]:-}"; f_confirm="${f_confirm//$'\t'/ }"; f_confirm="${f_confirm//$'\n'/ }"; f_confirm="${f_confirm//$'\r'/ }"
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$f_id" "$f_label" "$f_desc" "$f_accel" "$f_hotkey" "$f_confirm"
    done
  } > "$prefetch_file"
  picker_kind='go'
  # Command palette has no upstream Lua keypress timestamp like Alt+/, so
  # pass start_ms as both keypress_ts and menu_start_ts. Footer renders
  # "total = menu+picker" with lua=0.
  menu_done_ts="$(date +%s%3N)"
  picker_command=$(printf 'WEZTERM_RUNTIME_TRACE_ID=%q %q command %q %q %q %q %q %q %q %q %q %q %q' \
    "$trace_id" "$picker_binary" \
    "$prefetch_file" "$script_dir/tmux-command-run.sh" "$runtime_mode" \
    "$session_name" "$current_window_id" "$cwd" "$client_tty" \
    "$last_command_id" "$start_ms" "$start_ms" "$menu_done_ts")
else
  picker_command=$(printf 'WEZTERM_RUNTIME_TRACE_ID=%q bash %q %q %q %q %q' \
    "$trace_id" "$script_dir/tmux-command-picker.sh" \
    "$session_name" "$current_window_id" "$cwd" "$client_tty")
fi
bench_mark prep_done

if [[ -n "${WEZTERM_BENCH_NO_POPUP:-}" ]]; then
  printf '__BENCH__ picker_kind=%s item_count=%d %s\n' "$picker_kind" "${#visible_indexes[@]}" "${bench_marks[*]}"
  rm -f "$prefetch_file"
  exit 0
fi

# Mark the popup as open before launching, clear on any exit. The
# wezterm `command_palette.open` handler reads this file via io.open
# and routes a second press to `tmux display-popup -C` instead of
# forwarding the User0 user-key (which would be silently dropped while
# the popup is up). Touching beats writing "1" — `io.open` returning
# non-nil is enough signal.
mkdir -p "$toggle_flag_dir" 2>/dev/null || true
: > "$toggle_flag_file" 2>/dev/null || true
trap 'rm -f "'"$toggle_flag_file"'" "'"$prefetch_file"'"' EXIT

popup_status=0
tmux display-popup -x C -y C -w 70% -h 75% -T "Command Palette" -E "$picker_command" || popup_status=$?

# tmux 3.6+ is a hard requirement (see CLAUDE.md / fe4491e), so
# display-popup itself always exists. A non-zero exit here either means
# the picker process exited non-zero, or — more importantly for the
# toggle handshake — the wezterm-side handler killed the popup via
# `tmux display-popup -C` for the close-on-second-press path. Either
# way, do not pop a `display-menu` fallback: that would surface as
# "another picker appearing" right after the user pressed the toggle.
runtime_log_info command_panel "tmux command panel popup completed" "runtime_mode=$runtime_mode" "session_name=$session_name" "trigger_source=$trigger_source" "picker_kind=$picker_kind" "popup_status=$popup_status" "duration_ms=$(runtime_log_duration_ms "$start_ms")"
exit 0
