#!/usr/bin/env bash
set -euo pipefail

# Reap expired uxc daemon MCP stdio sessions.
#
# Why this exists: uxc's own idle reaping is *lazy*. `MCP_IDLE_TTL_SECS`
# defaults to 600, but `cleanup_idle` only runs immediately before the daemon
# processes a request — there is no timer. Measured 2026-07-29: a
# chrome-devtools-mcp child sat at `idle_for_secs=820`, `expires_in_secs=0`
# and 701 Mi RSS for 750 s untouched; one unrelated endpoint call
# (`deepwiki-mcp-cli -h`) reaped it instantly. So a stretch with no uxc
# traffic at all leaves expired children resident indefinitely.
#
# That matters here because chrome-devtools-mcp leaks without bound —
# `PageCollector.storage[0]` has no size cap and is only trimmed on main-frame
# `framenavigated`, so an SPA / HMR page that never reloads grows the node heap
# to multiple GiB (5 instances reached 1.7–3.5 Gi on this host). uxc's idle
# reaping is the containment; this script supplies the missing trigger.
#
# Deliberately conservative: it only acts when *every* live session is already
# expired, and it stops the daemon rather than signalling children directly.
# `uxc daemon stop` is the documented path, tears the stdio children down with
# it, reclaims the daemon itself, and the next endpoint invocation auto-starts
# a fresh one. Signalling `child_pid` behind the daemon's back would leave its
# session registry describing a process that no longer exists.
#
# Sibling of agent-cleanup.sh: different target (uxc daemon sessions vs agent
# resume chains) and different verdict source (uxc's own `expires_in_secs` vs
# process age + TTY), so it stays a separate script, but both are cron-driven
# stale-resource reclaim and both log under the `agent_cleanup` category.
#
# Usage:
#   uxc-session-reaper.sh [--dry-run|--reap]
#
# Defaults to --dry-run, matching agent-cleanup.sh.
#
# Env:
#   UXC_BIN   override the uxc executable (default: PATH, then ~/.local/bin/uxc)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"

mode="dry-run"
while (($#)); do
  case "$1" in
    --dry-run) mode="dry-run" ;;
    --reap) mode="reap" ;;
    -h|--help)
      sed -n '/^# Usage:/,/^#   UXC_BIN/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

# Resolve uxc without assuming cron inherited an interactive PATH.
uxc_bin="${UXC_BIN:-}"
if [[ -z "$uxc_bin" ]]; then
  uxc_bin="$(command -v uxc 2>/dev/null || true)"
fi
if [[ -z "$uxc_bin" && -x "$HOME/.local/bin/uxc" ]]; then
  uxc_bin="$HOME/.local/bin/uxc"
fi
if [[ -z "$uxc_bin" ]]; then
  printf 'uxc not found; nothing to reap.\n'
  exit 0
fi

# cron does not set XDG_RUNTIME_DIR, and uxc does not fall back the way this
# script did: with the variable unset it resolves its socket to
# /tmp/uxc-unknown/daemon/uxc.sock — a different path from the one the
# interactive daemon listens on. Deriving the path here without exporting it
# made the two disagree: the socket check passed against
# /run/user/<uid>/uxc/uxc.sock while `uxc daemon sessions` failed to connect,
# every cron run silently reaped nothing. Export it so both agree.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# Never let this script be the thing that starts the daemon. Management
# subcommands appear not to auto-start it, but the socket check makes that
# independent of uxc's internals.
socket="$XDG_RUNTIME_DIR/uxc/uxc.sock"
if [[ ! -S "$socket" ]]; then
  printf 'uxc daemon not running (no socket at %s); nothing to reap.\n' "$socket"
  exit 0
fi

sessions_json="$("$uxc_bin" daemon sessions 2>/dev/null || true)"
if [[ -z "$sessions_json" ]]; then
  printf 'could not read uxc daemon sessions; skipping.\n'
  exit 0
fi

# Verdict is computed by uxc's own idle accounting, not by guessing an RSS
# threshold. `expires_in_secs == 0` means uxc already considers the session
# discardable; anything above 0 is inside its idle window and must not be
# disturbed mid-workflow.
#
# uxc's JSON can carry raw control characters in tool output, so strict=False.
verdict_line="$(printf '%s' "$sessions_json" | python3 -c '
import json, sys

try:
    payload = json.loads(sys.stdin.read(), strict=False)
except Exception:
    print("unreadable 0 0")
    raise SystemExit

# An error envelope has no "data", so treating it as an empty session list
# would silently report "nothing to reap" for a connection failure. Surface it.
if not payload.get("ok"):
    print("failed 0 0")
    raise SystemExit

sessions = payload.get("data") or []
if not sessions:
    print("empty 0 0")
    raise SystemExit

expired = [s for s in sessions if (s.get("expires_in_secs") or 0) == 0]
total = len(sessions)
pids = ",".join(str(s.get("child_pid")) for s in expired if s.get("child_pid"))
verdict = "reap" if len(expired) == total else "active"
print(f"{verdict} {total} {len(expired)} {pids}")
' 2>/dev/null || printf 'unreadable 0 0')"

read -r verdict total expired pids <<<"$verdict_line"
pids="${pids:-none}"

case "$verdict" in
  empty)
    printf 'no uxc daemon sessions; nothing to reap.\n'
    exit 0
    ;;
  unreadable)
    printf 'uxc daemon sessions output unparseable; skipping.\n'
    runtime_log_warn agent_cleanup "uxc session sweep skipped" "reason=unparseable"
    exit 0
    ;;
  failed)
    # `uxc daemon sessions` returned ok=false — usually a socket it cannot
    # reach. Never silently treat this as "no sessions"; that is exactly the
    # failure this branch exists to make visible.
    printf 'uxc daemon sessions returned an error (socket %s); skipping.\n' "$socket" >&2
    runtime_log_warn agent_cleanup "uxc session sweep skipped" \
      "reason=daemon_query_failed" "socket=$socket" "xdg_runtime_dir=$XDG_RUNTIME_DIR"
    exit 0
    ;;
  active)
    printf 'uxc sessions active (%s/%s expired); leaving daemon alone.\n' "$expired" "$total"
    exit 0
    ;;
esac

printf 'uxc-session-reaper mode=%s sessions=%s expired=%s child_pids=%s\n' \
  "$mode" "$total" "$expired" "$pids"

if [[ "$mode" == "dry-run" ]]; then
  printf 'dry-run only; rerun with --reap to stop the daemon.\n'
  exit 0
fi

if "$uxc_bin" daemon stop >/dev/null 2>&1; then
  printf 'stopped uxc daemon; reclaimed %s expired session(s).\n' "$expired"
  runtime_log_info agent_cleanup "reaped expired uxc daemon sessions" \
    "sessions=$total" "expired=$expired" "child_pids=$pids"
else
  printf 'failed to stop uxc daemon.\n' >&2
  runtime_log_error agent_cleanup "failed to stop uxc daemon" \
    "sessions=$total" "expired=$expired" "child_pids=$pids"
  exit 1
fi
