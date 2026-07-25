#!/usr/bin/env bash
# Turn-idle detector: empty ❯ without spinner; human prompt still wins as waiting.
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

# Real Claude empty prompt is often ❯ + NBSP (U+00A0), not ASCII space.
idle_nbsp_prompt=$'❯ '
idle_ui=$(cat <<EOF
● 校验：x-ink 144 测试通过，eslint 0。

✻ Brewed for 8m 51s

────────────────────────────────────────
${idle_nbsp_prompt}
────────────────────────────────────────
  Opus 5  ctx:28%
  ⏵⏵ auto mode on
EOF
)

idle_ascii_ui=$(cat <<'EOF'
✻ Brewed for 1m 2s

────────────────────────────────────────
❯
────────────────────────────────────────
EOF
)

running_ui=$(cat <<'EOF'
● 还在查 normalizeEOL。

  Bash(cd /tmp && parse() { python3 -c "…")
  ⎿  (10s · timeout 5m)
     (ctrl+b ctrl+b (twice) to run in background)

✢ Waddling… (5m 10s · ↓ 14.8k tokens)

────────────────────────────────────────
❯
────────────────────────────────────────
  Opus 5  ctx:27%
EOF
)

running_interrupt_ui=$(cat <<'EOF'
● Working on patch…

esc to interrupt

────────────────────────────────────────
❯
────────────────────────────────────────
EOF
)

choice_ui=$(cat <<'EOF'
❯ 1. 直达 master(推荐)
  2. 先进 prerelease

Enter to select · ↑/↓ to navigate · Esc to cancel
EOF
)

chat_only=$(cat <<'EOF'
I will update the script and open a PR.
Let me know if you want to continue.
EOF
)

assert_ok "idle empty prompt (NBSP) → turn idle" sb_watch_turn_idle_visible "$idle_ui"
assert_ok "idle empty prompt (ASCII) → turn idle" sb_watch_turn_idle_visible "$idle_ascii_ui"
assert_fail "running spinner → not idle" sb_watch_turn_idle_visible "$running_ui"
assert_fail "esc interrupt → not idle" sb_watch_turn_idle_visible "$running_interrupt_ui"
assert_fail "choice row ❯ 1. → not idle" sb_watch_turn_idle_visible "$choice_ui"
assert_fail "plain chat → not idle" sb_watch_turn_idle_visible "$chat_only"

# waiting still wins for status policy (human prompt)
assert_ok "choice → human" sb_watch_human_prompt_visible "$choice_ui"
assert_fail "idle → not human" sb_watch_human_prompt_visible "$idle_ui"

echo "PASS: watch turn idle"
