#!/usr/bin/env bash
# Remote access to collab tickets from a phone / tablet (docs/remote-access.md).
#
# One user unit keeps `wezdeck-wsl relay` connected to the HostRelay Durable
# Object on wezdeck.yuns.love (outbound WebSocket; WebRTC signaling rides on
# it). Tokens live in ~/.config/shell-env.d/wezdeck-remote.env (0600):
#   WEZDECK_RELAY_HOST_TOKEN    host → Worker (Bearer)
#   WEZDECK_RELAY_CLIENT_TOKEN  browser → Worker (paired via #pair=…)
#
# Usage:
#   ./scripts/dev/install-remote-relay.sh               # tokens (if missing) + install + start
#   ./scripts/dev/install-remote-relay.sh --push-secrets  # wrangler secret put both tokens
#   ./scripts/dev/install-remote-relay.sh --pair        # print the phone pairing link + QR
#   ./scripts/dev/install-remote-relay.sh --check       # unit + presence, no writes
#   ./scripts/dev/install-remote-relay.sh --uninstall
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BIN="$REPO_ROOT/native/wezdeck-wsl/bin/wezdeck-wsl"
ENV_FILE="$HOME/.config/shell-env.d/wezdeck-remote.env"
UNIT_DIR="${SYSTEMD_USER_UNIT_DIR:-$HOME/.config/systemd/user}"
UNIT="wezdeck-relay.service"
ORIGIN="${WEZDECK_REMOTE_ORIGIN:-https://wezdeck.yuns.love}"

MODE=install
case "${1:-}" in
  '') ;;
  --push-secrets) MODE=push ;;
  --pair) MODE=pair ;;
  --check) MODE=check ;;
  --uninstall) MODE=uninstall ;;
  -h|--help) sed -n '2,/^set -/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
  *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
esac

ensure_tokens() {
  [[ -f "$ENV_FILE" ]] && return 0
  mkdir -p "$(dirname "$ENV_FILE")"
  umask 077
  {
    printf '# wezdeck remote access (docs/remote-access.md); rotate: delete, rerun install + --push-secrets\n'
    printf 'WEZDECK_RELAY_HOST_TOKEN=%s\n' "$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
    printf 'WEZDECK_RELAY_CLIENT_TOKEN=%s\n' "$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  printf 'wrote %s\n' "$ENV_FILE"
}

load_tokens() {
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
}

unit_text() {
  cat <<EOF
[Unit]
Description=WezDeck: keep the remote-access relay connected (wezdeck-wsl relay)
Documentation=file://$REPO_ROOT/docs/remote-access.md
After=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
# ticket api resolves the repo and python3 from these (no login shell here).
Environment=WEZDECK_REPO=$REPO_ROOT
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin
ExecStart=$BIN relay
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
}

case "$MODE" in
  install)
    ensure_tokens
    "$REPO_ROOT/native/wezdeck-wsl/build.sh"
    mkdir -p "$UNIT_DIR"
    unit_text > "$UNIT_DIR/$UNIT"
    systemctl --user daemon-reload
    systemctl --user enable "$UNIT" >/dev/null
    systemctl --user restart "$UNIT"
    printf 'installed %s; logs: journalctl --user -u %s, relay.log next to wsl-bridge.log\n' "$UNIT" "$UNIT"
    ;;
  push)
    load_tokens
    cd "$REPO_ROOT/web"
    printf '%s' "$WEZDECK_RELAY_HOST_TOKEN" | corepack pnpm exec wrangler secret put RELAY_HOST_TOKEN
    printf '%s' "$WEZDECK_RELAY_CLIENT_TOKEN" | corepack pnpm exec wrangler secret put RELAY_CLIENT_TOKEN
    ;;
  pair)
    load_tokens
    url="$ORIGIN/console/collab#pair=$WEZDECK_RELAY_CLIENT_TOKEN"
    printf 'Open on the phone / tablet (stores the token in that browser):\n%s\n\n' "$url"
    npx --yes qrcode@1.5.4 -t utf8 "$url" 2>/dev/null || printf '(QR unavailable: npx qrcode failed)\n'
    ;;
  check)
    systemctl --user is-active "$UNIT" || true
    curl -fsS -m 5 "$ORIGIN/relay/health" && printf '\n'
    ;;
  uninstall)
    systemctl --user disable --now "$UNIT" 2>/dev/null || true
    rm -f "$UNIT_DIR/$UNIT"
    systemctl --user daemon-reload
    printf 'removed %s (tokens kept in %s)\n' "$UNIT" "$ENV_FILE"
    ;;
esac
