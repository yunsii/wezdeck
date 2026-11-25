#!/usr/bin/env bash
# One sync-runtime at a time (sourced by sync-runtime.sh; tested by
# tests/sync-runtime/sync-lock-and-install-wait.sh).
#
# Two agents syncing at once each stopped, replaced and restarted the Windows
# runtime (2026-11-25: a second sync from another worktree stopped it mid-way
# and hung; the runtime stayed down 68 s). The lock is held for the whole run
# on fd 9 (background helpers that outlive the sync close it with 9>&-); a
# waiter says who holds it and gives up after WEZDECK_SYNC_LOCK_WAIT seconds
# (default 300) with exit 75 instead of barging in.

SYNC_LOCK_FILE="${WEZDECK_SYNC_LOCK_FILE:-${XDG_STATE_HOME:-$HOME/.local/state}/wezterm-runtime/sync-runtime.lock}"
acquire_sync_lock() {
  local repo="${1:-}" wait="${WEZDECK_SYNC_LOCK_WAIT:-300}" holder=""
  mkdir -p "$(dirname "$SYNC_LOCK_FILE")"
  exec 9>>"$SYNC_LOCK_FILE"
  if ! flock -n 9; then
    holder="$(cat "$SYNC_LOCK_FILE.holder" 2>/dev/null || true)"
    printf '[sync] another sync-runtime is running (%s); waiting up to %ss…\n' "${holder:-holder unknown}" "$wait" >&2
    runtime_log_warn sync "sync-runtime waiting for the sync lock" \
      "holder=${holder:-unknown}" "wait_s=$wait" "repo_root=$repo"
    if ! flock -w "$wait" 9; then
      printf '[sync] gave up after %ss: still held by %s. Nothing was changed.\n' "$wait" "${holder:-unknown}" >&2
      runtime_log_error sync "sync-runtime gave up waiting for the sync lock" \
        "holder=${holder:-unknown}" "wait_s=$wait" "repo_root=$repo"
      exit 75
    fi
  fi
  printf 'pid=%s repo=%s started=%s\n' "$$" "$repo" "$(date '+%H:%M:%S')" >"$SYNC_LOCK_FILE.holder"
}
