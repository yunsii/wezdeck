#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d /tmp/wezdeck-tmux-binary.XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/home/.local/bin"
printf '#!/usr/bin/env bash\nprintf "local-tmux\\n" >> "$TMUX_PROBE_FILE"\nexit 1\n' \
  > "$TEST_ROOT/home/.local/bin/tmux"
chmod +x "$TEST_ROOT/home/.local/bin/tmux"
export HOME="$TEST_ROOT/home"
export XDG_STATE_HOME="$TEST_ROOT/state"
export WEZDECK_TMUX_SESSIONS_FILE="$TEST_ROOT/snapshot.json"
export WEZDECK_ATTENTION_STATE_PATH="$TEST_ROOT/attention.json"
export WEZTERM_RUNTIME_LOG_FILE="$TEST_ROOT/runtime.log"
export TMUX_PROBE_FILE="$TEST_ROOT/tmux-calls"
PATH=/usr/bin:/bin bash "$ROOT/scripts/runtime/tmux-session-persist.sh" save
grep -Fq 'local-tmux' "$TMUX_PROBE_FILE"
[[ ! -f "$WEZDECK_TMUX_SESSIONS_FILE" ]]
printf 'PASS tmux-persist-local-binary\n'
