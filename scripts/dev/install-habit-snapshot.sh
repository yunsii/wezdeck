#!/usr/bin/env bash
# Install the personal habit snapshot timer for this WSL user.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
unit_dir="${SYSTEMD_USER_UNIT_DIR:-$HOME/.config/systemd/user}"
service=wezdeck-habit-snapshot.service
timer=wezdeck-habit-snapshot.timer

if [[ "${1:-}" == --check ]]; then
  systemctl --user is-active "$timer"
  systemctl --user list-timers "$timer" --no-pager
  exit
fi
if [[ $# -gt 0 ]]; then
  printf 'Usage: %s [--check]\n' "$0" >&2
  exit 2
fi

mkdir -p "$unit_dir"
cat >"$unit_dir/$service" <<EOF
[Unit]
Description=Generate WezDeck development-habit snapshots
After=network-online.target

[Service]
Type=oneshot
Environment=WEZDECK_REPO=$repo_root
Environment=TZ=Asia/Singapore
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=$repo_root
ExecStart=/usr/bin/python3 $repo_root/scripts/dev/habit-snapshot.py
TimeoutStartSec=600
EOF

cat >"$unit_dir/$timer" <<EOF
[Unit]
Description=Refresh WezDeck development-habit snapshots three times daily

[Timer]
OnCalendar=*-*-* 09:00:00 Asia/Singapore
OnCalendar=*-*-* 12:30:00 Asia/Singapore
OnCalendar=*-*-* 18:30:00 Asia/Singapore
Persistent=true
Unit=$service

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$timer"
systemctl --user start "$service"
systemctl --user list-timers "$timer" --no-pager
