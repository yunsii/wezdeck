#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

PROJECT_ROOT="$TEST_ROOT/twice-refresh-root"
mkdir -p "$PROJECT_ROOT"

SESSION_NAME="$(tmux_worktree_session_name_for_path work "$PROJECT_ROOT")"
OPEN_PROJECT_SESSION_SCRIPT="$SCRIPT_DIR/../../../scripts/runtime/open-project-session.sh"

cat > "$TEST_SHIM_DIR/tmux" <<EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == "attach-session" ]]; then
  exit 0
fi
exec "$TEST_REAL_TMUX" -L "$TEST_SOCKET" "\$@"
EOF
chmod +x "$TEST_SHIM_DIR/tmux"

NESTED_WRAPPER='
primary_script="$1"
fallback_script="$2"
shift 2
if [ -n "$primary_script" ] && [ -f "$primary_script" ]; then
  exec bash "$primary_script" "$@"
fi
if [ -n "$fallback_script" ] && [ -f "$fallback_script" ]; then
  exec bash "$fallback_script" "$@"
fi
printf "Managed workspace runtime script is unavailable: %s\n" "$primary_script" >&2
if [ -n "$fallback_script" ]; then
  printf "Fallback runtime script is unavailable: %s\n" "$fallback_script" >&2
fi
exit 1
'

NESTED_PRIMARY_SCRIPT="$PROJECT_ROOT/managed-runner.sh"
HEARTBEAT_DIR="$PROJECT_ROOT/heartbeats"
mkdir -p "$HEARTBEAT_DIR"
cat > "$NESTED_PRIMARY_SCRIPT" <<INNER
#!/usr/bin/env bash
stamp="$HEARTBEAT_DIR/\$(date +%s%N)-\$\$"
printf 'twice-refresh-agent running\n' > "\$stamp"
exec sleep 300
INNER
chmod +x "$NESTED_PRIMARY_SCRIPT"

NESTED_FALLBACK_SCRIPT="$PROJECT_ROOT/fallback-runner.sh"

bash "$OPEN_PROJECT_SESSION_SCRIPT" \
  work \
  "$PROJECT_ROOT" \
  /bin/sh \
  -lc \
  "$NESTED_WRAPPER" \
  sh \
  "$NESTED_PRIMARY_SCRIPT" \
  "$NESTED_FALLBACK_SCRIPT"

tmux has-session -t "$SESSION_NAME"

INITIAL_WINDOW_ID="$(tmux list-windows -t "$SESSION_NAME" -F '#{window_id}' | head -n 1)"
INITIAL_METADATA="$(tmux_worktree_window_metadata "$INITIAL_WINDOW_ID" @wezterm_window_primary_command)"
case "$INITIAL_METADATA" in
  *"managed-runner.sh"*)
    ;;
  *)
    printf 'setup: open-project-session should persist the managed primary command metadata\nactual: %s\n' "$INITIAL_METADATA" >&2
    exit 1
    ;;
esac

rm -f "$TEST_SHIM_DIR/tmux"
cat > "$TEST_SHIM_DIR/tmux" <<EOF
#!/usr/bin/env bash
exec "$TEST_REAL_TMUX" -L "$TEST_SOCKET" "\$@"
EOF
chmod +x "$TEST_SHIM_DIR/tmux"

tmux_test_attach_session "$SESSION_NAME"

resolve_primary_window_id() {
  tmux list-windows -t "$SESSION_NAME" -F '#{window_id}|#{pane_current_path}' \
    | awk -F'|' -v target_path="$PROJECT_ROOT" '$2 == target_path { print $1; exit }'
}

assert_refresh_iteration() {
  local iteration="${1:?missing iteration label}"
  local window_id
  local client_tty
  local actual
  local refreshed_window
  local primary_pane_start_command
  local metadata_primary_command

  window_id="$(resolve_primary_window_id)"
  if [[ -z "$window_id" ]]; then
    printf '%s: primary window should be resolvable before refresh\n' "$iteration" >&2
    exit 1
  fi
  client_tty="$(tmux_test_client_ttys_for_session "$SESSION_NAME" | head -n 1)"
  if [[ -z "$client_tty" ]]; then
    printf '%s: attached client tty should be resolvable before refresh\n' "$iteration" >&2
    exit 1
  fi

  actual="$(tmux_test_run_reset refresh-current-session \
    --session-name "$SESSION_NAME" \
    --window-id "$window_id" \
    --cwd "$PROJECT_ROOT" \
    --client-tty "$client_tty")"
  tmux_test_assert_eq "refreshed_session" "$actual" "$iteration: refresh-current-session should succeed"

  tmux has-session -t "$SESSION_NAME"
  tmux_test_wait_for_session_attached "$SESSION_NAME" 1

  refreshed_window="$(resolve_primary_window_id)"
  if [[ -z "$refreshed_window" ]]; then
    printf '%s: primary window should be resolvable after refresh\n' "$iteration" >&2
    exit 1
  fi

  metadata_primary_command="$(tmux_worktree_window_metadata "$refreshed_window" @wezterm_window_primary_command)"
  case "$metadata_primary_command" in
    *"managed-runner.sh"*)
      ;;
    *)
      printf '%s: refreshed window should preserve managed primary command metadata\nexpected substring: managed-runner.sh\nactual: %s\n' \
        "$iteration" "$metadata_primary_command" >&2
      exit 1
      ;;
  esac

  primary_pane_start_command="$(tmux display-message -p -t "${refreshed_window}.0" '#{pane_start_command}')"
  case "$primary_pane_start_command" in
    *"managed-runner.sh"*)
      ;;
    *)
      printf '%s: refresh should restore the primary managed command\nexpected substring: managed-runner.sh\nactual: %s\n' \
        "$iteration" "$primary_pane_start_command" >&2
      exit 1
      ;;
  esac

  local expected_heartbeats="$2"
  local waited=0
  local actual_heartbeats
  while (( waited < 200 )); do
    actual_heartbeats="$(ls "$HEARTBEAT_DIR" 2>/dev/null | wc -l | tr -d ' ')"
    if (( actual_heartbeats >= expected_heartbeats )); then
      break
    fi
    sleep 0.05
    waited=$((waited + 1))
  done
  local pane_current_command
  pane_current_command="$(tmux display-message -p -t "${refreshed_window}.0" '#{pane_current_command}' 2>/dev/null || true)"
  local pane_contents
  pane_contents="$(tmux capture-pane -pt "${refreshed_window}.0" -S -200 2>/dev/null || true)"

  if (( actual_heartbeats < expected_heartbeats )); then
    printf '%s: refreshed pane should run managed-runner.sh (expected %d heartbeats, saw %d)\npane_current_command: %s\ncaptured pane output:\n%s\n' \
      "$iteration" "$expected_heartbeats" "$actual_heartbeats" "$pane_current_command" "$pane_contents" >&2
    exit 1
  fi

  case "$pane_contents" in
    *"Managed workspace runtime script is unavailable"*)
      printf '%s: refreshed pane emitted wrapper fallback error\npane contents:\n%s\n' \
        "$iteration" "$pane_contents" >&2
      exit 1
      ;;
  esac
}

INITIAL_HEARTBEATS=0
for attempt in $(seq 1 200); do
  INITIAL_HEARTBEATS="$(ls "$HEARTBEAT_DIR" 2>/dev/null | wc -l | tr -d ' ')"
  if (( INITIAL_HEARTBEATS >= 1 )); then
    break
  fi
  sleep 0.05
done
if (( INITIAL_HEARTBEATS < 1 )); then
  printf 'setup: initial launch should produce at least one managed-runner heartbeat\n' >&2
  exit 1
fi

assert_refresh_iteration "first"  $((INITIAL_HEARTBEATS + 1))
assert_refresh_iteration "second" $((INITIAL_HEARTBEATS + 2))

printf 'PASS refresh-current-session-twice\n'
