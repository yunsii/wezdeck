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
#   ./scripts/dev/install-remote-relay.sh --devices     # phones that asked to write / are approved
#   ./scripts/dev/install-remote-relay.sh --approve <id>  # let that phone write (send / keys / reply)
#   ./scripts/dev/install-remote-relay.sh --revoke <id>
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
  --devices) MODE=devices ;;
  --approve) MODE=approve; DEVICE_ID="${2:-}" ;;
  --revoke) MODE=revoke; DEVICE_ID="${2:-}" ;;
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
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
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
    # @paulmillr/qr (web devDependency, zero deps, no npx round trip): its
    # "ascii" output is half blocks with light modules as blocks, so it scans
    # as-is on a dark terminal (~45 cols).
    if ! (cd "$REPO_ROOT/web" && node --input-type=module -e \
      'import qr from "@paulmillr/qr"; console.log(qr(process.argv[1], "ascii"))' "$url" 2>/dev/null); then
      printf '(QR unavailable: run corepack pnpm install in web/; open the link above instead)\n'
    fi
    ;;
  devices|approve|revoke)
    # Device keys live in ~/.config/wezdeck/remote-devices.json (written by
    # `wezdeck-wsl relay` when a phone taps 启用写入; see remote_session.go).
    DEVICE_ID="${DEVICE_ID:-}" MODE="$MODE" python3 - <<'PY'
import fcntl, json, os, sys, unicodedata
path = os.path.expanduser(os.environ.get("WEZDECK_REMOTE_DEVICES", "~/.config/wezdeck/remote-devices.json"))
os.makedirs(os.path.dirname(path), exist_ok=True)
# same lock as the relay (remote_session.go lockDevices): no lost update
# between a phone registering and an approve / revoke here
lock = open(path + ".lock", "a")
fcntl.flock(lock, fcntl.LOCK_EX)
def safe(text):
    # device names come from the phone: never print control characters
    return "".join(c for c in str(text) if unicodedata.category(c)[0] != "C")
try:
    store = json.load(open(path))
except FileNotFoundError:
    store = {"approved": [], "pending": []}
mode, wanted = os.environ["MODE"], os.environ["DEVICE_ID"]
def show():
    for state in ("pending", "approved"):
        for d in store.get(state) or []:
            print(f"{state:9} {safe(d['id'])}  {safe(d.get('name') or '?'):20} {safe(d.get('at', ''))}")
    if not (store.get("pending") or store.get("approved")):
        print("no devices yet: on the phone open 我的 › 手机写入 › 启用")
if mode == "devices":
    show(); sys.exit(0)
if not wanted:
    sys.exit("usage: --approve|--revoke <device id> (see --devices)")
if mode == "approve":
    hit = [d for d in store.get("pending") or [] if d["id"] == wanted]
    if not hit:
        sys.exit(f"no pending device {wanted}")
    store["pending"] = [d for d in store.get("pending") or [] if d["id"] != wanted]
    store["approved"] = (store.get("approved") or []) + [hit[0]]
else:
    store["approved"] = [d for d in store.get("approved") or [] if d["id"] != wanted]
os.makedirs(os.path.dirname(path), exist_ok=True)
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(store, f, indent=2)
os.chmod(tmp, 0o600)
os.replace(tmp, path)
show()
PY
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
