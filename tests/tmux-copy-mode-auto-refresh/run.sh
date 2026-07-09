#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REFRESH_SCRIPT="$REPO_ROOT/scripts/runtime/tmux-copy-mode-auto-refresh.sh"

command -v tmux >/dev/null 2>&1 || {
  printf 'missing required command: tmux\n' >&2
  exit 1
}

run_fake_refresh_case() {
  local name="$1" scroll_position="$2" history_size="$3" prefetch_screens="$4" expected_refresh="$5"
  local tmp fake_bin calls status

  tmp="$(mktemp -d)"
  fake_bin="$tmp/bin"
  calls="$tmp/refresh.calls"
  mkdir -p "$fake_bin"

  cat >"$fake_bin/tmux" <<EOF
#!/usr/bin/env bash
set -euo pipefail

args=( "\$@" )
cmd_index=0
if [[ "\${args[0]:-}" == "-S" ]]; then
  cmd_index=2
fi
cmd="\${args[\$cmd_index]:-}"
case "\$cmd" in
  show-options)
    opt="\${args[-1]}"
    case "\$opt" in
      @copy_mode_auto_refresh) printf '1\n' ;;
      @copy_mode_auto_refresh_prefetch_screens) printf '${prefetch_screens}\n' ;;
      @copy_mode_auto_refresh_history_guard_lines) printf '10\n' ;;
      @copy_mode_auto_refresh_interval_ms) printf '100\n' ;;
    esac
    ;;
  display-message)
    fmt="\${args[-1]}"
    case "\$fmt" in
      '#{pane_in_mode} #{pane_mode}') printf '1 copy-mode\n' ;;
      '#{selection_present}') printf '0\n' ;;
      '#{scroll_position} #{history_size} #{history_limit} #{pane_height}') printf '${scroll_position} ${history_size} 100 20\n' ;;
    esac
    ;;
  send-keys)
    printf 'refresh\n' >>'$calls'
    ;;
esac
EOF
  chmod +x "$fake_bin/tmux"

  set +e
  PATH="$fake_bin:/usr/bin:/bin" timeout 0.35s bash "$REFRESH_SCRIPT" fake.sock '%1' 100 >/dev/null 2>&1
  status=$?
  set -e

  case "$expected_refresh:$status" in
    yes:124|no:124) ;;
    *)
      printf '%s: expected timeout exit 124 while fake copy-mode stays active, got %s\n' "$name" "$status" >&2
      rm -rf "$tmp"
      exit 1
      ;;
  esac

  case "$expected_refresh" in
    yes)
      [[ -s "$calls" ]] || {
        printf '%s: expected auto-refresh call away from history limit\n' "$name" >&2
        rm -rf "$tmp"
        exit 1
      }
      ;;
    no)
      [[ ! -e "$calls" ]] || {
        printf '%s: auto-refresh should pause for this copy-mode state\n' "$name" >&2
        rm -rf "$tmp"
        exit 1
      }
      ;;
  esac
  rm -rf "$tmp"
}

run_fake_refresh_case live-bottom 0 95 3 yes
run_fake_refresh_case inside-prefetch-window 42 50 3 yes
run_fake_refresh_case outside-prefetch-window 80 50 3 no
run_fake_refresh_case inside-prefetch-window-near-limit 42 95 3 no
run_fake_refresh_case prefetch-disabled 1 50 0 no

socket_path="/tmp/wezterm-copy-mode-auto-refresh.$$.$RANDOM.sock"
refresh_pid=""

cleanup() {
  if [[ -n "$refresh_pid" ]]; then
    kill "$refresh_pid" >/dev/null 2>&1 || true
    wait "$refresh_pid" >/dev/null 2>&1 || true
  fi
  tmux -S "$socket_path" kill-server >/dev/null 2>&1 || true
  rm -f "$socket_path"
}
trap cleanup EXIT

tmux -S "$socket_path" new-session -d -s s 'bash -lc '"'"'i=1; while [ "$i" -le 80 ]; do printf "line-%03d abcdefghijklmnopqrstuvwxyz\n" "$i"; i=$((i + 1)); sleep 0.02; done; sleep 30'"'"''
sleep 0.2

pane_id="$(tmux -S "$socket_path" display-message -p -t s:0.0 '#{pane_id}')"
tmux -S "$socket_path" set-option -gq @copy_mode_auto_refresh 1
tmux -S "$socket_path" copy-mode -t "$pane_id"
tmux -S "$socket_path" send-keys -t "$pane_id" -X start-of-line
tmux -S "$socket_path" send-keys -t "$pane_id" -X begin-selection
tmux -S "$socket_path" send-keys -t "$pane_id" -X cursor-right
tmux -S "$socket_path" send-keys -t "$pane_id" -X cursor-right
tmux -S "$socket_path" send-keys -t "$pane_id" -X cursor-right
tmux -S "$socket_path" send-keys -t "$pane_id" -X stop-selection

before="$(tmux -S "$socket_path" display-message -p -t "$pane_id" '#{selection_present}')"
if [[ "$before" != "1" ]]; then
  printf 'test setup failed: expected selection_present=1, got %s\n' "$before" >&2
  exit 1
fi

bash "$REFRESH_SCRIPT" "$socket_path" "$pane_id" 100 &
refresh_pid="$!"
sleep 0.35

after="$(tmux -S "$socket_path" display-message -p -t "$pane_id" '#{selection_present}')"
if [[ "$after" != "1" ]]; then
  printf 'auto-refresh should not clear active selection; got selection_present=%s\n' "$after" >&2
  exit 1
fi

if ! kill -0 "$refresh_pid" >/dev/null 2>&1; then
  printf 'auto-refresh loop exited while copy-mode was active\n' >&2
  exit 1
fi

tmux -S "$socket_path" send-keys -t "$pane_id" -X cancel
for _ in $(seq 1 30); do
  if ! kill -0 "$refresh_pid" >/dev/null 2>&1; then
    refresh_pid=""
    printf 'PASS tmux-copy-mode-auto-refresh\n'
    exit 0
  fi
  sleep 0.05
done

printf 'auto-refresh loop did not exit after copy-mode was cancelled\n' >&2
exit 1
