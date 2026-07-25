#!/usr/bin/env bash
# Install the guest-OOM hardening units for this WSL distro.
#
# Two units, both driving scripts/runtime/wsl-oom-guard.sh:
#
#   wezterm-oom-protect.service   oneshot at boot — exempts WSL's init (-1000)
#                                 and any tmux server (-800) from the kernel OOM
#                                 killer. Without it, a guest OOM can kill the
#                                 process WSL uses to decide the distro still has
#                                 sessions, which turns one memory spike into a
#                                 poweroff + restart loop.
#   wezterm-oom-record.service    long-running — records who was big before an
#                                 OOM kill, and re-applies the protection set
#                                 every tick because tmux starts long after boot.
#                                 Runs at OOMScoreAdjust=-900 so the recorder
#                                 outlives the pressure it records.
#
# /proc/<pid>/oom_score_adj resets on every distro start, which is why this is a
# unit and not a one-off echo.
#
# Usage:
#   sudo ./scripts/dev/install-wsl-oom-guard.sh            # install + enable + start
#   ./scripts/dev/install-wsl-oom-guard.sh --check         # no root, no writes
#   ./scripts/dev/install-wsl-oom-guard.sh --print         # dump generated units
#   sudo ./scripts/dev/install-wsl-oom-guard.sh --uninstall
#
# Docs: docs/diagnostics.md "Guest OOM hardening"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && cd .. && pwd)"
GUARD_SCRIPT="$REPO_ROOT/scripts/runtime/wsl-oom-guard.sh"
UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
GUARD_LOG="${WEZTERM_OOM_GUARD_LOG:-/var/log/wezterm-oom-guard.log}"
PROTECT_UNIT="wezterm-oom-protect.service"
RECORD_UNIT="wezterm-oom-record.service"

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

protect_unit_text() {
  cat <<EOF
[Unit]
Description=WezDeck: exempt WSL init from the kernel OOM killer
Documentation=file://$REPO_ROOT/docs/diagnostics.md
After=sysinit.target
ConditionVirtualization=wsl

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=WEZTERM_OOM_GUARD_LOG=$GUARD_LOG
ExecStart=$GUARD_SCRIPT protect

[Install]
WantedBy=multi-user.target
EOF
}

record_unit_text() {
  cat <<EOF
[Unit]
Description=WezDeck: record guest OOM / memory-pressure evidence
Documentation=file://$REPO_ROOT/docs/diagnostics.md
After=sysinit.target
ConditionVirtualization=wsl

[Service]
Type=simple
Environment=WEZTERM_OOM_GUARD_LOG=$GUARD_LOG
ExecStart=$GUARD_SCRIPT watch
Restart=always
RestartSec=5
# The recorder must survive the pressure it is recording.
OOMScoreAdjust=-900
Nice=-5

[Install]
WantedBy=multi-user.target
EOF
}

[[ -x "$GUARD_SCRIPT" ]] || {
  printf 'guard script missing or not executable: %s\n' "$GUARD_SCRIPT" >&2
  exit 1
}

case "$MODE" in
  print)
    printf '===== %s/%s =====\n' "$UNIT_DIR" "$PROTECT_UNIT"; protect_unit_text
    printf '\n===== %s/%s =====\n' "$UNIT_DIR" "$RECORD_UNIT"; record_unit_text
    exit 0
    ;;
  check)
    "$GUARD_SCRIPT" status
    for unit in "$PROTECT_UNIT" "$RECORD_UNIT"; do
      # is-enabled exits non-zero for disabled/not-found but still prints the
      # state, so use its stdout and only substitute when it printed nothing.
      enabled_state="$(systemctl is-enabled "$unit" 2>/dev/null)"
      printf '%-32s installed=%s enabled=%s\n' "$unit" \
        "$([[ -f "$UNIT_DIR/$unit" ]] && printf yes || printf no)" \
        "${enabled_state:-unknown}"
    done
    exit 0
    ;;
esac

[[ "$(id -u)" == 0 ]] || {
  printf 'this mode needs root: sudo %s %s\n' "$0" "--$MODE" >&2
  exit 1
}

if [[ "$MODE" == uninstall ]]; then
  for unit in "$RECORD_UNIT" "$PROTECT_UNIT"; do
    systemctl disable --now "$unit" 2>/dev/null || true
    rm -f "$UNIT_DIR/$unit"
  done
  systemctl daemon-reload
  printf 'removed %s and %s (guard log kept at %s)\n' "$PROTECT_UNIT" "$RECORD_UNIT" "$GUARD_LOG"
  exit 0
fi

protect_unit_text >"$UNIT_DIR/$PROTECT_UNIT"
record_unit_text >"$UNIT_DIR/$RECORD_UNIT"
chmod 0644 "$UNIT_DIR/$PROTECT_UNIT" "$UNIT_DIR/$RECORD_UNIT"
touch "$GUARD_LOG"
chmod 0644 "$GUARD_LOG"

systemctl daemon-reload
systemctl enable --now "$PROTECT_UNIT"
systemctl enable --now "$RECORD_UNIT"

printf '\n'
"$GUARD_SCRIPT" status
