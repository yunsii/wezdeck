#!/usr/bin/env bash
# Verify managed CLI lookup without sourcing an interactive shell.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_ROOT="$(mktemp -d /tmp/wezterm-agent-launcher.XXXXXX)"
trap 'rm -rf "$TEST_ROOT"' EXIT

NVM_DIR="$TEST_ROOT/.nvm"
FAKE_BIN="$NVM_DIR/versions/node/v22.21.1/bin"
FAKE_CODEX="$FAKE_BIN/codex"
LOG="$TEST_ROOT/codex.args"
mkdir -p "$FAKE_BIN" "$NVM_DIR/alias" "$TEST_ROOT/home" "$TEST_ROOT/codex-home"
printf '22\n' > "$NVM_DIR/alias/default"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" > "${CODEX_TEST_LOG:?}"\n' > "$FAKE_CODEX"
chmod +x "$FAKE_CODEX"

env -i \
  HOME="$TEST_ROOT/home" \
  NVM_DIR="$NVM_DIR" \
  CODEX_HOME="$TEST_ROOT/codex-home" \
  CODEX_TEST_LOG="$LOG" \
  PATH=/usr/bin:/bin \
  WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" codex

grep -Fxq 'resume --last' "$LOG"
printf 'PASS agent-launcher resolves nvm CLI without interactive shell\n'
