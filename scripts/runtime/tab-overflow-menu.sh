#!/usr/bin/env bash
# Alt+x overflow picker entry (tmux User4).
#
# Design for perceived latency:
#   1. Almost no work before display-popup — open the overlay first.
#   2. Body script stamps is_current / warm-cold from a WSL-ext4 cache
#      (overflow-base.tsv) and execs the Go picker.
#   3. Continuous maintenance (items has_tab + cache rebuild) lives on
#      the WezTerm update-status tick + background builder, not here.
#
# Cache path is WSL-native (see wsl-runtime-paths-lib.sh) because the
# press path is pure WSL bash; /mnt/c reads were ~5× slower in bench.

set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
menu_start_ts=$(( ${EPOCHREALTIME//./} / 1000 ))
trace_id="overflow-$EPOCHSECONDS-$$-$RANDOM"

session_name="${1:-}"
client_tty="${2:-}"
[[ -n "$session_name" ]] || session_name="$(tmux display-message -p '#{session_name}' 2>/dev/null || true)"

# shellcheck disable=SC1091
. "$script_dir/wsl-runtime-paths-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/picker-bin-lib.sh"

base_tsv="$WSL_OVERFLOW_BASE_TSV"
build_script="$script_dir/tab-overflow-prefetch-build.sh"
dispatch_script="$script_dir/tab-overflow-dispatch.sh"
body_script="$script_dir/tab-overflow-popup-body.sh"
mkdir -p "$WSL_RUNTIME_STATE_DIR" 2>/dev/null || true

# Cold miss only: sync build once so first press after reboot still works.
# Warm path never waits on the builder.
if [[ ! -s "$base_tsv" ]]; then
  bash "$build_script" 2>/dev/null || true
fi

if [[ ! -s "$base_tsv" ]]; then
  tmux display-message -d 3000 \
    "Overflow picker: no workspace items yet (open a managed workspace first)"
  exit 0
fi

picker_binary=""
picker_rc=0
picker_binary="$(picker_bin_require "$script_dir" "Alt+x")" || picker_rc=$?
if (( picker_rc == 1 )); then
  exit 0
fi

# Kick background rebuild without blocking the popup.
( bash "$build_script" >/dev/null 2>&1 & ) || true

if (( picker_rc == 2 )); then
  tmux display-message -d 4000 \
    "Overflow picker binary missing. Re-run wezterm-runtime-sync (WEZTERM_ALLOW_BASH_PICKER no longer covers Alt+x)."
  exit 0
fi

# OPEN OVERLAY FIRST — prep continues inside the popup body.
exec bash "$script_dir/tmux-display-popup.sh" \
  -x C -y C -w 80% -h 70% -T "Sessions across workspaces" \
  -E "bash $(printf %q "$body_script") \
    $(printf %q "$session_name") \
    $(printf %q "$base_tsv") \
    $(printf %q "$dispatch_script") \
    $(printf %q "$picker_binary") \
    $(printf %q "$trace_id") \
    $(printf %q "$menu_start_ts") \
    $(printf %q "${client_tty:-}")"
