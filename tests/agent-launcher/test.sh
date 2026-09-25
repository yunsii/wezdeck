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
FAKE_CLAUDE="$FAKE_BIN/claude"
LOG="$TEST_ROOT/codex.args"
CLAUDE_LOG="$TEST_ROOT/claude.args"
mkdir -p "$FAKE_BIN" "$NVM_DIR/alias" "$TEST_ROOT/home" "$TEST_ROOT/codex-home"
mkdir -p "$TEST_ROOT/shell-env"
printf '22\n' > "$NVM_DIR/alias/default"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" > "${CODEX_TEST_LOG:?}"\n' > "$FAKE_CODEX"
chmod +x "$FAKE_CODEX"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" > "${CLAUDE_TEST_LOG:?}"\n' > "$FAKE_CLAUDE"
chmod +x "$FAKE_CLAUDE"

env -i \
  HOME="$TEST_ROOT/home" \
  NVM_DIR="$NVM_DIR" \
  CODEX_HOME="$TEST_ROOT/codex-home" \
  CODEX_TEST_LOG="$LOG" \
  PATH=/usr/bin:/bin \
  WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" codex

grep -Fxq -- '--profile full-access resume --last' "$LOG"
test -L "$TEST_ROOT/codex-home/full-access.config.toml"
printf 'PASS agent-launcher ensures and uses full-access overlay\n'

env -i \
  HOME="$TEST_ROOT/home" \
  NVM_DIR="$NVM_DIR" \
  CODEX_HOME="$TEST_ROOT/codex-home" \
  CODEX_TEST_LOG="$LOG" \
  PATH=/usr/bin:/bin \
  WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" codex

grep -Fxq -- '--profile full-access resume --last' "$LOG"
printf 'PASS agent-launcher reuses Codex profile overlay when present\n'

printf 'MANAGED_AGENT_PERMISSION_PROFILE=auto\n' \
  > "$TEST_ROOT/shell-env/99-test.env"

env -i \
  HOME="$TEST_ROOT/home" \
  NVM_DIR="$NVM_DIR" \
  CODEX_HOME="$TEST_ROOT/codex-home" \
  SHELL_ENV_DIR="$TEST_ROOT/shell-env" \
  CODEX_TEST_LOG="$LOG" \
  PATH=/usr/bin:/bin \
  WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" codex

grep -Fxq -- '--profile auto resume --last' "$LOG"
test -L "$TEST_ROOT/codex-home/auto.config.toml"
printf 'PASS agent-launcher ensures and uses Auto overlay\n'

env -i \
  HOME="$TEST_ROOT/home" \
  NVM_DIR="$NVM_DIR" \
  CODEX_HOME="$TEST_ROOT/codex-home" \
  CLAUDE_TEST_LOG="$CLAUDE_LOG" \
  PATH=/usr/bin:/bin \
  WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" claude

grep -Fxq -- '--permission-mode bypassPermissions --continue' "$CLAUDE_LOG"
printf 'PASS agent-launcher maps full-access to Claude permission mode\n'

grep -q -- '--always-approve' "$REPO_ROOT/scripts/runtime/agent-launcher.sh"
printf 'PASS agent-launcher contains Grok full-access adapter\n'
