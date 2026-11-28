#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d /tmp/wezdeck-tmux-units.XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT
export WEZDECK_REPO="$TEST_ROOT/repo"
export SYSTEMD_USER_UNIT_DIR="$TEST_ROOT/units"
mkdir -p "$WEZDECK_REPO/scripts/runtime" "$TEST_ROOT/bin"
printf '#!/usr/bin/env bash\nexit 0\n' > "$WEZDECK_REPO/scripts/runtime/tmux-session-persist.sh"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s/systemctl.log"\n' "$TEST_ROOT" > "$TEST_ROOT/bin/systemctl"
chmod +x "$TEST_ROOT/bin/systemctl"
export PATH="$TEST_ROOT/bin:$PATH"

bash "$REPO_ROOT/scripts/dev/install-tmux-session-persist.sh"
systemd-analyze verify "$SYSTEMD_USER_UNIT_DIR"/*.service "$SYSTEMD_USER_UNIT_DIR"/*.timer
grep -Fq 'ExecStart=/usr/bin/bash '"$WEZDECK_REPO"'/scripts/runtime/tmux-session-persist.sh restore' \
  "$SYSTEMD_USER_UNIT_DIR/wezdeck-tmux-restore.service"
grep -Fq 'Before=wezdeck-relay.service' "$SYSTEMD_USER_UNIT_DIR/wezdeck-tmux-restore.service"
grep -Fq 'OnUnitActiveSec=1min' "$SYSTEMD_USER_UNIT_DIR/wezdeck-tmux-save.timer"
grep -Fq 'enable wezdeck-tmux-restore.service wezdeck-tmux-save.timer' "$TEST_ROOT/systemctl.log"
printf 'PASS tmux-session-persist-installer\n'
