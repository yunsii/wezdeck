#!/usr/bin/env bash
# Structural checks for session.fix-layout wiring.
set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/scripts/runtime/tmux-fix-layout.sh"
manifest="$repo_root/wezterm-x/commands/manifest.json"
chords="$repo_root/wezterm-x/tmux/chord-bindings.generated.conf"
keys_doc="$repo_root/docs/keybindings.md"

pass=0
fail=0

assert_yes() {
  local name="$1"
  local cond="$2"
  if [[ "$cond" == "yes" ]]; then
    pass=$((pass + 1))
    printf '  PASS  %s\n' "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL  %s\n' "$name"
  fi
}

[[ -x "$script" ]] && assert_yes "script executable" "yes" || assert_yes "script executable" "no"
bash -n "$script" && assert_yes "bash -n clean" "yes" || assert_yes "bash -n clean" "no"
grep -q 'refresh-client -S' "$script" && assert_yes "refresh-client -S" "yes" || assert_yes "refresh-client -S" "no"
lib="$(dirname "$script")/tmux-fix-layout-lib.sh"
[[ -f "$lib" ]] && assert_yes "fix-layout-lib present" "yes" || assert_yes "fix-layout-lib present" "no"
grep -q 'tmux-fix-layout-lib.sh' "$script" && assert_yes "fix-layout sources lib" "yes" || assert_yes "fix-layout sources lib" "no"
grep -q 'tmux_fix_layout_winch_attach_client\|kill -WINCH' "$lib" && assert_yes "SIGWINCH on PTY drift" "yes" || assert_yes "SIGWINCH on PTY drift" "no"
grep -q 'TIOCGWINSZ\|pty_winsize' "$lib" && assert_yes "PTY winsize probe" "yes" || assert_yes "PTY winsize probe" "no"
grep -q 'Layout heal' "$repo_root/docs/tmux-ui.md" && assert_yes "tmux-ui layout heal section" "yes" || assert_yes "tmux-ui layout heal section" "no"
grep -q 'layout-heal-fix-layout\|PTY.*client' "$repo_root/docs/diagnostics.md" && assert_yes "diagnostics triage pointer" "yes" || assert_yes "diagnostics triage pointer" "no"
grep -q 'even-horizontal' "$script" && assert_yes "even-horizontal rebalance" "yes" || assert_yes "even-horizontal rebalance" "no"
grep -q 'status_now' "$script" && assert_yes "status clamp" "yes" || assert_yes "status clamp" "no"
grep -q '"id": "session.fix-layout"' "$manifest" && assert_yes "manifest id" "yes" || assert_yes "manifest id" "no"
grep -qE 'Ctrl\+k.`r`|layout fix' "$keys_doc" && assert_yes "keybindings doc" "yes" || assert_yes "keybindings doc" "no"
grep -q 'command-chord r' "$chords" && assert_yes "generated chord leaf r" "yes" || assert_yes "generated chord leaf r" "no"
grep -q 'tmux-fix-layout.sh' "$chords" && assert_yes "chord runs fix-layout" "yes" || assert_yes "chord runs fix-layout" "no"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
(( fail == 0 ))
