#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_CONFIG_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
TMUX_CONF="$REPO_CONFIG_ROOT/tmux.conf"
REPO_ROOT="$REPO_CONFIG_ROOT"

if git -C "$REPO_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  COMMON_DIR="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [[ -z "$COMMON_DIR" ]]; then
    COMMON_DIR="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null || true)"
  fi
  if [[ -n "$COMMON_DIR" ]]; then
    if [[ "$COMMON_DIR" != /* ]]; then
      COMMON_DIR="$(
        cd "$REPO_ROOT"
        cd "$COMMON_DIR"
        pwd -P
      )"
    fi
    MAIN_ROOT="$(dirname "$COMMON_DIR")"
    if [[ -n "$MAIN_ROOT" && -d "$MAIN_ROOT" ]]; then
      REPO_ROOT="$MAIN_ROOT"
    fi
  fi
fi

tmux set-option -g @wezterm_runtime_root "$REPO_ROOT"
tmux source-file "$TMUX_CONF"
printf 'Applied tmux config: %s\n' "$TMUX_CONF"

# source-file does not reset append-style state. A `set -ga` / `set -as`
# without a preceding unset, or a lone `set-hook -ga`, stacks one copy per
# reload on a long-lived server. Report the depth after this source so the
# stack is visible without waiting for the hook to fire.
# shellcheck disable=SC1091
source "$REPO_CONFIG_ROOT/scripts/runtime/runtime-log-lib.sh"
WEZTERM_RUNTIME_LOG_SOURCE="${WEZTERM_RUNTIME_LOG_SOURCE:-reload-tmux.sh}"

warn_reload_stack() {
  local kind="$1" name="$2" depth="$3"
  printf 'tmux reload stacked %s %s depth=%s\n' "$kind" "$name" "$depth" >&2
  if declare -F runtime_log_warn >/dev/null 2>&1; then
    runtime_log_warn sync "tmux reload stacked append" \
      "kind=$kind" "name=$name" "depth=$depth" || true
  fi
}

option_token_count() {
  local value="$1" token="$2"
  printf '%s\n' "$value" | tr ' ,' '\n' | grep -Fxc -- "$token" || true
}

update_environment="$(tmux show-options -gv update-environment 2>/dev/null || true)"
pane_copies="$(option_token_count "$update_environment" "WEZTERM_PANE")"
if (( pane_copies > 1 )); then
  warn_reload_stack option update-environment "$pane_copies"
fi

terminal_features="$(tmux show-options -gv terminal-features 2>/dev/null || true)"
sync_copies="$(option_token_count "$terminal_features" "xterm*:sync")"
rgb_copies="$(option_token_count "$terminal_features" "xterm*:RGB")"
if (( sync_copies > 1 || rgb_copies > 1 )); then
  warn_reload_stack option terminal-features "$(( sync_copies > rgb_copies ? sync_copies : rgb_copies ))"
fi

# A hook that this conf both replaces (-g) and appends to (-ga) settles
# at 2. Anything deeper means a reload appended without replacing.
while IFS=$'\t' read -r hook_name depth; do
  [[ -n "$hook_name" && "$depth" =~ ^[0-9]+$ ]] || continue
  if (( depth > 2 )); then
    warn_reload_stack hook "$hook_name" "$depth"
  fi
done < <(
  tmux show-hooks -g 2>/dev/null \
    | awk -F'[][]' '/\[/ { c[$1]++ } END { for (k in c) printf "%s\t%d\n", k, c[k] }'
)
