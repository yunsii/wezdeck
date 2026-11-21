#!/usr/bin/env bash
# Install the OPPO 互联 link-quality producer as a systemd user service.
#
#   scripts/dev/install-oppo-remote-watch.sh             # install + enable + start
#   scripts/dev/install-oppo-remote-watch.sh --check     # unit state + current status.json
#   scripts/dev/install-oppo-remote-watch.sh --print     # show the unit, no writes
#   scripts/dev/install-oppo-remote-watch.sh --uninstall
#
# The service runs `oppo-remote-quality.sh daemon`: tails the newest
# desktop_agent log, republishes state/oppo-remote/status.json (2 s while a
# session is active, 30 s idle) for the WezTerm `Pad·` badge, and appends
# stall episodes with an office-vs-beyond blame to episodes.ndjson.
# Paths are resolved once here and baked into the unit, so the service never
# needs cmd.exe interop. Docs: docs/oppo-remote-host-input.md#pad-badge
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TOOL="$REPO_ROOT/scripts/dev/oppo-remote-quality.sh"
UNIT_DIR="${SYSTEMD_USER_UNIT_DIR:-$HOME/.config/systemd/user}"
UNIT="wezterm-oppo-remote.service"

MODE=install
case "${1:-}" in
  --check) MODE=check ;;
  --print) MODE=print ;;
  --uninstall) MODE=uninstall ;;
  -h|--help) sed -n '2,/^set -/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
  '') ;;
  *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
esac

# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/runtime/windows-runtime-paths-lib.sh"
windows_runtime_detect_paths || { echo "cannot resolve Windows paths" >&2; exit 1; }
LOG_DIR="${WEZTERM_OPPO_LOG_DIR:-$WINDOWS_USERPROFILE_WSL/AppData/Roaming/O+Connect/devicespace}"
STATUS_FILE="${WEZTERM_OPPO_STATUS_FILE:-$WINDOWS_RUNTIME_STATE_WSL/state/oppo-remote/status.json}"

unit_text() {
  cat <<EOF
[Unit]
Description=WezDeck: OPPO 互联 remote link quality → Pad· badge
Documentation=file://$REPO_ROOT/docs/oppo-remote-host-input.md
ConditionVirtualization=wsl

[Service]
Type=simple
Environment="WEZTERM_OPPO_LOG_DIR=$LOG_DIR"
Environment="WEZTERM_OPPO_STATUS_FILE=$STATUS_FILE"
ExecStart=$TOOL daemon
Restart=always
RestartSec=10
Nice=10

[Install]
WantedBy=default.target
EOF
}

case "$MODE" in
  print) unit_text; exit 0 ;;
  check)
    printf '%s installed=%s enabled=%s active=%s\n' "$UNIT" \
      "$([[ -f "$UNIT_DIR/$UNIT" ]] && echo yes || echo no)" \
      "$(systemctl --user is-enabled "$UNIT" 2>/dev/null || true)" \
      "$(systemctl --user is-active "$UNIT" 2>/dev/null || true)"
    printf 'status: %s\n' "$STATUS_FILE"
    cat "$STATUS_FILE" 2>/dev/null && echo || echo '(not published yet)'
    exit 0
    ;;
  uninstall)
    systemctl --user disable --now "$UNIT" 2>/dev/null || true
    rm -f "$UNIT_DIR/$UNIT"
    systemctl --user daemon-reload
    echo "removed $UNIT (status + episodes kept under $(dirname "$STATUS_FILE"))"
    exit 0
    ;;
esac

[[ -d "$LOG_DIR" ]] || echo "warning: $LOG_DIR missing (O+ Connect not installed?) — service will idle" >&2
mkdir -p "$UNIT_DIR"
unit_text > "$UNIT_DIR/$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"
systemctl --user restart "$UNIT"
echo "installed $UNIT → $STATUS_FILE"
