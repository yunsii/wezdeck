#!/usr/bin/env bash
# Install the host-disk guard timer for this WSL distro.
#
# Two user units, both driving scripts/runtime/wsl-disk-guard.sh:
#
#   wezterm-disk-guard.service    oneshot — take one sample, publish the JSON
#                                 the WezTerm D· badge reads, and pop a tmux
#                                 reminder when the level escalates.
#   wezterm-disk-guard.timer      fires it 1 min after boot, then every 5 min.
#
# These are **user** units, unlike the OOM guard's system units: sampling needs
# no privilege, and a user unit keeps the install a single non-sudo command.
# The tradeoff is that they only run while the user's systemd session is up —
# which is exactly when a badge could be read anyway.
#
# Why a timer and not a long-running watcher: disk pressure builds over hours,
# and the badge is only visible when WezTerm is running. A 5 min oneshot costs
# nothing and cannot leak.
#
# Usage:
#   ./scripts/dev/install-wsl-disk-guard.sh            # install + enable + start
#   ./scripts/dev/install-wsl-disk-guard.sh --check    # no writes
#   ./scripts/dev/install-wsl-disk-guard.sh --print    # dump generated units
#   ./scripts/dev/install-wsl-disk-guard.sh --uninstall
#
# Docs: docs/diagnostics.md "Host disk space"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && cd .. && pwd)"
GUARD_SCRIPT="$REPO_ROOT/scripts/runtime/wsl-disk-guard.sh"
UNIT_DIR="${SYSTEMD_USER_UNIT_DIR:-$HOME/.config/systemd/user}"
SERVICE_UNIT="wezterm-disk-guard.service"
TIMER_UNIT="wezterm-disk-guard.timer"
INTERVAL="${WEZTERM_DISK_SAMPLE_INTERVAL:-5min}"

MODE=install

# Print the whole header block (line 2 through the line before `set -`) so the
# help text cannot drift out of sync when the header grows.
usage() {
  sed -n '2,/^set -/p' "$0" | sed '$d; s/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE=check ;;
    --print) MODE=print ;;
    --uninstall) MODE=uninstall ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

service_unit_text() {
  cat <<EOF
[Unit]
Description=WezDeck: sample host disk usage and publish the status badge
Documentation=file://$REPO_ROOT/docs/diagnostics.md
ConditionVirtualization=wsl

[Service]
Type=oneshot
ExecStart=$GUARD_SCRIPT sample
EOF
}

timer_unit_text() {
  cat <<EOF
[Unit]
Description=WezDeck: periodic host-disk sample
Documentation=file://$REPO_ROOT/docs/diagnostics.md

[Timer]
# Relative to the user manager starting, so a distro restart re-samples within
# a minute without needing Persistent= (which only applies to OnCalendar=).
OnStartupSec=1min
OnUnitActiveSec=$INTERVAL
Unit=$SERVICE_UNIT

[Install]
WantedBy=timers.target
EOF
}

[[ -x "$GUARD_SCRIPT" ]] || {
  printf 'guard script missing or not executable: %s\n' "$GUARD_SCRIPT" >&2
  exit 1
}

case "$MODE" in
  print)
    printf '===== %s/%s =====\n' "$UNIT_DIR" "$SERVICE_UNIT"; service_unit_text
    printf '\n===== %s/%s =====\n' "$UNIT_DIR" "$TIMER_UNIT"; timer_unit_text
    exit 0
    ;;
  check)
    "$GUARD_SCRIPT" status
    printf '\n'
    for unit in "$SERVICE_UNIT" "$TIMER_UNIT"; do
      # is-enabled exits non-zero for disabled/not-found but still prints the
      # state, so use its stdout and only substitute when it printed nothing.
      enabled_state="$(systemctl --user is-enabled "$unit" 2>/dev/null)"
      printf '%-30s installed=%s enabled=%s\n' "$unit" \
        "$([[ -f "$UNIT_DIR/$unit" ]] && printf yes || printf no)" \
        "${enabled_state:-unknown}"
    done
    systemctl --user list-timers "$TIMER_UNIT" --no-pager 2>/dev/null || true
    exit 0
    ;;
  uninstall)
    systemctl --user disable --now "$TIMER_UNIT" 2>/dev/null || true
    systemctl --user disable --now "$SERVICE_UNIT" 2>/dev/null || true
    rm -f "$UNIT_DIR/$TIMER_UNIT" "$UNIT_DIR/$SERVICE_UNIT"
    systemctl --user daemon-reload 2>/dev/null || true
    printf 'removed %s and %s (published status file kept)\n' "$SERVICE_UNIT" "$TIMER_UNIT"
    exit 0
    ;;
esac

mkdir -p "$UNIT_DIR"
service_unit_text >"$UNIT_DIR/$SERVICE_UNIT"
timer_unit_text >"$UNIT_DIR/$TIMER_UNIT"
chmod 0644 "$UNIT_DIR/$SERVICE_UNIT" "$UNIT_DIR/$TIMER_UNIT"

# Prime the vhdx path cache *before* enabling the timer, and do it from this
# shell rather than from the unit. A systemd user unit has no Windows interop
# at all — no /mnt/c on PATH, no WSL_INTEROP — so it can never do the
# authoritative registry lookup itself. It falls back to a glob, which works
# but is a guess; seeding the cache here means the timer inherits the
# authoritative answer from the very first tick.
"$GUARD_SCRIPT" sample >/dev/null 2>&1 || true

systemctl --user daemon-reload
systemctl --user enable --now "$TIMER_UNIT"

printf '\n'
"$GUARD_SCRIPT" status
