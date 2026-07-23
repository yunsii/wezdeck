#!/usr/bin/env bash
# Watch needs-human detector covers permission + Claude choice UI; approve stays narrow.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/lib.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/host-snapshot.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/session-bridge/host-write.sh"

assert_ok() {
  local label="$1"; shift
  if ! "$@"; then
    printf 'FAIL: %s\n' "$label" >&2
    exit 1
  fi
}
assert_fail() {
  local label="$1"; shift
  if "$@"; then
    printf 'FAIL: %s (expected no)\n' "$label" >&2
    exit 1
  fi
}

choice_ui=$(cat <<'EOF'
❯ 1. 直达 master(推荐)
  2. 先进 prerelease
  3. 常规提测走 test
  4. Type something.
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
EOF
)

perm_ui=$(cat <<'EOF'
Do you want to proceed?
❯ 1. Yes
  2. No

Esc to cancel
EOF
)

chat_only=$(cat <<'EOF'
I will update the script and open a PR.
Let me know if you want to continue with the ship path.
EOF
)

assert_ok "choice → watch human" sb_watch_human_prompt_visible "$choice_ui"
assert_ok "perm → watch human" sb_watch_human_prompt_visible "$perm_ui"
assert_fail "chat → not watch human" sb_watch_human_prompt_visible "$chat_only"

# approve-visible must stay narrow: choice UI without y/N must NOT auto-approve
assert_fail "choice → not approve-visible" sb_prompt_visible "$choice_ui"
assert_ok "perm → approve-visible" sb_prompt_visible "$perm_ui"

echo "PASS: watch human prompt anchors"
