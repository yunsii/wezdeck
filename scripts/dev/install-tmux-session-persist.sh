#!/usr/bin/env bash
# Install user units for cold WSL tmux restoration and periodic snapshots.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${WEZDECK_REPO:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
PERSIST="$REPO_ROOT/scripts/runtime/tmux-session-persist.sh"
UNIT_DIR="${SYSTEMD_USER_UNIT_DIR:-$HOME/.config/systemd/user}"
MODE="${1:-install}"
RESTORE_UNIT=wezdeck-tmux-restore.service
SAVE_UNIT=wezdeck-tmux-save.service
TIMER_UNIT=wezdeck-tmux-save.timer

restore_unit() {
  cat <<EOF
[Unit]
Description=WezDeck: restore managed tmux sessions after WSL startup
Documentation=file://$REPO_ROOT/docs/workspaces.md
ConditionVirtualization=wsl
Before=wezdeck-relay.service

[Service]
Type=oneshot
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/bash $PERSIST restore
TimeoutStartSec=3min

[Install]
WantedBy=default.target
EOF
}

save_unit() {
  cat <<EOF
[Unit]
Description=WezDeck: snapshot managed tmux sessions
Documentation=file://$REPO_ROOT/docs/workspaces.md
ConditionVirtualization=wsl

[Service]
Type=oneshot
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/bash $PERSIST save
EOF
}

timer_unit() {
  cat <<EOF
[Unit]
Description=WezDeck: keep managed tmux session snapshot current

[Timer]
OnStartupSec=30s
OnUnitActiveSec=1min
Unit=$SAVE_UNIT

[Install]
WantedBy=timers.target
EOF
}

case "$MODE" in
  --print)
    restore_unit
    save_unit
    timer_unit
    exit 0
    ;;
  --check)
    for unit in "$RESTORE_UNIT" "$SAVE_UNIT" "$TIMER_UNIT"; do
      enabled="$(systemctl --user is-enabled "$unit" 2>/dev/null || true)"
      printf '%-34s installed=%s enabled=%s\n' "$unit" \
        "$([[ -f "$UNIT_DIR/$unit" ]] && printf yes || printf no)" "${enabled:-unknown}"
    done
    bash "$PERSIST" status
    exit 0
    ;;
  --uninstall)
    systemctl --user disable --now "$TIMER_UNIT" "$RESTORE_UNIT" 2>/dev/null || true
    rm -f "$UNIT_DIR/$RESTORE_UNIT" "$UNIT_DIR/$SAVE_UNIT" "$UNIT_DIR/$TIMER_UNIT"
    systemctl --user daemon-reload
    exit 0
    ;;
  install) ;;
  *) printf 'usage: %s [--print|--check|--uninstall]\n' "$0" >&2; exit 2 ;;
esac

[[ -f "$PERSIST" ]] || { printf 'missing persistence script: %s\n' "$PERSIST" >&2; exit 1; }
mkdir -p "$UNIT_DIR"
restore_unit > "$UNIT_DIR/$RESTORE_UNIT"
save_unit > "$UNIT_DIR/$SAVE_UNIT"
timer_unit > "$UNIT_DIR/$TIMER_UNIT"
chmod 0644 "$UNIT_DIR/$RESTORE_UNIT" "$UNIT_DIR/$SAVE_UNIT" "$UNIT_DIR/$TIMER_UNIT"
systemctl --user daemon-reload
bash "$PERSIST" save
systemctl --user enable "$RESTORE_UNIT" "$TIMER_UNIT"
systemctl --user start "$TIMER_UNIT"
printf 'tmux session persistence installed; next WSL user-manager start restores the snapshot\n'
