#!/usr/bin/env bash
# tmux-status-refresh.sh option parsing + forced recompute.
#
# Regression cover for the 2026-08-05 stale-status bug: the tmux hooks passed
# `--window #{q:hook_window}` / `--pane #{q:hook_pane}`, but tmux leaves those
# variables empty for session- / window-scoped notifications, so the refresher
# received a bare `--window` whose value slot swallowed the following
# `--force`. The hook then resolved no context, recomputed nothing, and window
# / pane switches only caught up on the 30s poll.
set -u

guard_sandbox_paths() {
  local p="$1"
  if [[ -z "$p" || "$p" == /mnt/c/* ]]; then
    echo "SAFETY ABORT: sandbox path resolves to live state ($p)" >&2
    exit 99
  fi
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/scripts/runtime/tmux-status-refresh.sh"

pass=0
fail=0
ok() { pass=$((pass+1)); printf '  \xe2\x9c\x93 %s\n' "$1"; }
no() { fail=$((fail+1)); printf '  \xe2\x9c\x97 %s\n' "$1"; }

sandbox="$(mktemp -d -t wezterm-status-refresh-XXXXXX)"
guard_sandbox_paths "$sandbox"
trap 'rm -rf "$sandbox"' EXIT

workdir="$sandbox/repo"
git init -q -b feature/status-probe "$workdir"
git -C "$workdir" config user.email test@example.com
git -C "$workdir" config user.name Test
printf 'one\n' > "$workdir/file.txt"
git -C "$workdir" add file.txt
git -C "$workdir" commit -q -m initial

session="probe-session"
state="$sandbox/state"
mkdir -p "$state" "$sandbox/bin"

# Minimal tmux stub: records every mutation, resolves context only for targets
# it knows (an unknown target fails, exactly like `display-message -t --force`).
cat > "$sandbox/bin/tmux" <<STUB
#!/usr/bin/env bash
state="$state"
session="$session"
cwd="$workdir"
STUB
cat >> "$sandbox/bin/tmux" <<'STUB'
log() { printf '%s\n' "$*" >> "$state/calls.log"; }

target=""
sub="${1:-}"

case "$sub" in
  show)
    shift
    while (( $# > 0 )); do
      case "$1" in
        -gv|-g|-v|-qv|-q) shift ;;
        *) break ;;
      esac
    done
    case "$1" in
      status) printf '3\n' ;;
      *) printf '' ;;
    esac
    ;;
  show-options)
    shift
    while (( $# > 0 )); do
      case "$1" in
        -t) target="$2"; shift 2 ;;
        -*) shift ;;
        *) break ;;
      esac
    done
    if [[ "$target" != "$session" && -n "$target" ]]; then
      exit 1
    fi
    case "$1" in
      status) printf '3\n' ;;
      *)
        if [[ -f "$state/opt.$1" ]]; then
          cat "$state/opt.$1"
        fi
        ;;
    esac
    ;;
  set-option)
    shift
    while (( $# > 0 )); do
      case "$1" in
        -t) target="$2"; shift 2 ;;
        -*) shift ;;
        *) break ;;
      esac
    done
    log "set-option target=${target} name=${1} value=${2:-}"
    printf '%s' "${2:-}" > "$state/opt.${1}"
    ;;
  display-message)
    shift
    while (( $# > 0 )); do
      case "$1" in
        -c|-t) target="$2"; shift 2 ;;
        -*) shift ;;
        *) break ;;
      esac
    done
    case "$target" in
      ''|"$session"|@1|%1|/dev/pts/9)
        printf '%s\t@1\t%s\n' "$session" "$cwd"
        ;;
      *)
        printf "can't find target: %s\n" "$target" >&2
        exit 1
        ;;
    esac
    ;;
  list-clients)
    printf '/dev/pts/9\n'
    ;;
  refresh-client)
    log "refresh-client $*"
    ;;
  *)
    log "unhandled $*"
    ;;
esac
exit 0
STUB
chmod +x "$sandbox/bin/tmux"

reset_state() {
  rm -f "$state"/opt.* "$state/calls.log"
  touch "$state/calls.log"
  printf '%s' "$1" > "$state/opt.@tmux_status_last_refresh"
  printf '%s' "${2:-}" > "$state/opt.@tmux_status_last_cwd"
  printf '%s' "stale-line" > "$state/opt.@tmux_status_line_0"
}

run_refresh() {
  env \
    PATH="$sandbox/bin:$PATH" \
    TMUX_STATUS_RENDER_WORKTREE=0 \
    TMUX_STATUS_RENDER_WAKATIME=0 \
    TMUX_STATUS_RENDER_NODE=0 \
    TMUX_STATUS_NODE_CACHE="$state/node-cache" \
    bash "$script" "$@"
}

line0() {
  cat "$state/opt.@tmux_status_line_0" 2>/dev/null || true
}

printf '\xe2\x96\xb8 %s\n' 'tmux status refresh: option parsing'

# 1. Empty hook variable: `--window #{q:hook_window}` collapses to a bare
#    `--window`, so `--force` must survive as a flag and the refresh must run
#    even though the debounce window (2s) has not elapsed for another cwd.
reset_state "$(date +%s)" "$sandbox/other-repo"
run_refresh --window --force --refresh-client >/dev/null 2>&1
if [[ "$(line0)" == *feature/status-probe* ]]; then
  ok 'bare --window keeps --force and recomputes the line'
else
  no "bare --window swallowed --force (line0=$(line0))"
fi

# 2. The value slot must not eat a following flag even when more options
#    trail it, and the trailing options must still be parsed.
reset_state "$(date +%s)" "$sandbox/other-repo"
run_refresh --pane --force --refresh-client >/dev/null 2>&1
if grep -q 'refresh-client' "$state/calls.log"; then
  ok 'bare --pane still parses --refresh-client'
else
  no 'bare --pane dropped --refresh-client'
fi

# 3. The shape the hooks now use: explicit session / window / cwd.
reset_state "$(date +%s)" "$sandbox/other-repo"
run_refresh --session "$session" --window @1 --cwd "$workdir" --force --refresh-client >/dev/null 2>&1
if [[ "$(line0)" == *feature/status-probe* ]]; then
  ok 'explicit --session/--window/--cwd recomputes on a cwd change'
else
  no "explicit context did not recompute (line0=$(line0))"
fi

# 4. Same cwd inside the debounce window is still collapsed (the force path
#    must stay debounced for repeated prompt-hook / focus events).
reset_state "$(date +%s)" "$workdir"
run_refresh --session "$session" --window @1 --cwd "$workdir" --force >/dev/null 2>&1
if [[ "$(line0)" == "stale-line" ]]; then
  ok 'force refresh stays debounced for an unchanged cwd'
else
  no "debounce window ignored (line0=$(line0))"
fi

# 5. Non-force poll path honours @tmux_status_poll_interval.
reset_state "$(date +%s)" "$workdir"
run_refresh --session "$session" --window @1 --cwd "$workdir" --print-line 0 >/dev/null 2>&1
if [[ "$(line0)" == "stale-line" ]]; then
  ok 'print path does not recompute inside the poll interval'
else
  no "poll interval ignored (line0=$(line0))"
fi

reset_state "$(( $(date +%s) - 120 ))" "$workdir"
run_refresh --session "$session" --window @1 --cwd "$workdir" --print-line 0 >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [[ "$(line0)" == *feature/status-probe* ]] && break
  sleep 0.2
done
if [[ "$(line0)" == *feature/status-probe* ]]; then
  ok 'print path recomputes past the poll interval'
else
  no "stale line survived the poll interval (line0=$(line0))"
fi

# 6. An unknown option is still a usage error.
reset_state "$(date +%s)" "$workdir"
if run_refresh --nope >/dev/null 2>&1; then
  no 'unknown option did not fail'
else
  ok 'unknown option still exits non-zero'
fi

printf '  %s passed, %s failed\n' "$pass" "$fail"
(( fail == 0 ))
