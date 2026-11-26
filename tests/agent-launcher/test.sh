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
FAKE_AGY="$FAKE_BIN/agy"
LOG="$TEST_ROOT/codex.args"
CLAUDE_LOG="$TEST_ROOT/claude.args"
AGY_LOG="$TEST_ROOT/agy.args"
mkdir -p "$FAKE_BIN" "$NVM_DIR/alias" "$TEST_ROOT/home" "$TEST_ROOT/codex-home"
mkdir -p "$TEST_ROOT/shell-env"
printf '22\n' > "$NVM_DIR/alias/default"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" > "${CODEX_TEST_LOG:?}"\n' > "$FAKE_CODEX"
chmod +x "$FAKE_CODEX"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" > "${CLAUDE_TEST_LOG:?}"\n' > "$FAKE_CLAUDE"
chmod +x "$FAKE_CLAUDE"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" > "${AGY_TEST_LOG:?}"\nprintf "managed=%%s\\n" "${WEZDECK_AGY_MANAGED:-}" >> "${AGY_TEST_LOG:?}"\n' > "$FAKE_AGY"
chmod +x "$FAKE_AGY"

# Tracked default in wezterm-x/local.example/shared.env is auto; local/shared.env
# (loaded by runtime_env_load_managed) should match on this machine.
grep -Eq "^MANAGED_AGENT_PERMISSION_PROFILE=['\"]?auto['\"]?$" \
  "$REPO_ROOT/wezterm-x/local.example/shared.env"
printf 'PASS tracked shared.env default permission profile is auto\n'

env -i \
  HOME="$TEST_ROOT/home" \
  NVM_DIR="$NVM_DIR" \
  CODEX_HOME="$TEST_ROOT/codex-home" \
  CODEX_TEST_LOG="$LOG" \
  PATH=/usr/bin:/bin \
  WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" codex

grep -Fxq -- '--no-daemon --profile auto resume --last' "$LOG"
test -f "$TEST_ROOT/codex-home/auto.config.toml"
test ! -L "$TEST_ROOT/codex-home/auto.config.toml"
grep -Eq '^approval_policy = "on-request"$' "$TEST_ROOT/codex-home/auto.config.toml"
printf 'PASS agent-launcher applies Auto overlay as a regular file by default\n'

# Host-owned Codex runtime keys must survive a subsequent apply.
printf '\nmodel = "gpt-test-keep"\n' >> "$TEST_ROOT/codex-home/auto.config.toml"

env -i \
  HOME="$TEST_ROOT/home" \
  NVM_DIR="$NVM_DIR" \
  CODEX_HOME="$TEST_ROOT/codex-home" \
  CODEX_TEST_LOG="$LOG" \
  PATH=/usr/bin:/bin \
  WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" codex

grep -Fxq -- '--no-daemon --profile auto resume --last' "$LOG"
grep -Eq '^model = "gpt-test-keep"$' "$TEST_ROOT/codex-home/auto.config.toml"
grep -Eq '^approval_policy = "on-request"$' "$TEST_ROOT/codex-home/auto.config.toml"
printf 'PASS agent-launcher re-applies Auto overlay and preserves host Codex keys\n'

# Leftover symlink into the checkout must be converted on launch.
ln -sfn "$REPO_ROOT/agent-profiles/v1/host-setup/auto.config.toml" \
  "$TEST_ROOT/codex-home/auto.config.toml"
env -i \
  HOME="$TEST_ROOT/home" \
  NVM_DIR="$NVM_DIR" \
  CODEX_HOME="$TEST_ROOT/codex-home" \
  CODEX_TEST_LOG="$LOG" \
  PATH=/usr/bin:/bin \
  WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" codex
test -f "$TEST_ROOT/codex-home/auto.config.toml"
test ! -L "$TEST_ROOT/codex-home/auto.config.toml"
printf 'PASS agent-launcher converts Codex overlay symlink to a regular file\n'

printf 'MANAGED_AGENT_PERMISSION_PROFILE=full-access\n' \
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

grep -Fxq -- '--no-daemon --profile full-access resume --last' "$LOG"
test -f "$TEST_ROOT/codex-home/full-access.config.toml"
test ! -L "$TEST_ROOT/codex-home/full-access.config.toml"
grep -Eq '^approval_policy = "never"$' "$TEST_ROOT/codex-home/full-access.config.toml"
printf 'PASS agent-launcher applies full-access overlay when requested\n'

env -i \
  HOME="$TEST_ROOT/home" \
  NVM_DIR="$NVM_DIR" \
  CODEX_HOME="$TEST_ROOT/codex-home" \
  SHELL_ENV_DIR="$TEST_ROOT/shell-env" \
  CLAUDE_TEST_LOG="$CLAUDE_LOG" \
  PATH=/usr/bin:/bin \
  WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" claude

grep -Fxq -- '--permission-mode bypassPermissions --continue' "$CLAUDE_LOG"
printf 'PASS agent-launcher maps full-access to Claude permission mode\n'

env -i \
  HOME="$TEST_ROOT/home" \
  NVM_DIR="$NVM_DIR" \
  CODEX_HOME="$TEST_ROOT/codex-home" \
  SHELL_ENV_DIR="$TEST_ROOT/shell-env" \
  CODEX_TEST_LOG="$LOG" \
  WEZDECK_RESUME_SESSION_ID="codex-sid-typed-001" \
  PATH=/usr/bin:/bin \
  WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" codex

grep -Fxq -- '--no-daemon --profile full-access resume codex-sid-typed-001' "$LOG"
printf 'PASS agent-launcher typed resume uses codex resume <session_id>\n'

# Claude typed resume refuses when the transcript jsonl is missing; plant one
# under the sandbox HOME so --resume is reachable (same encode as
# agent_session_claude_project_dir_name: / and . → -).
claude_cwd="$(pwd -P)"
claude_proj="${claude_cwd//\//-}"
claude_proj="${claude_proj//./-}"
mkdir -p "$TEST_ROOT/home/.claude/projects/$claude_proj"
printf '{}\n' >"$TEST_ROOT/home/.claude/projects/$claude_proj/claude-sid-typed-002.jsonl"

env -i \
  HOME="$TEST_ROOT/home" \
  NVM_DIR="$NVM_DIR" \
  CODEX_HOME="$TEST_ROOT/codex-home" \
  SHELL_ENV_DIR="$TEST_ROOT/shell-env" \
  CLAUDE_TEST_LOG="$CLAUDE_LOG" \
  WEZDECK_RESUME_SESSION_ID="claude-sid-typed-002" \
  PATH=/usr/bin:/bin \
  WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" claude

grep -Fxq -- '--permission-mode bypassPermissions --resume claude-sid-typed-002' "$CLAUDE_LOG"
printf 'PASS agent-launcher typed resume uses claude --resume <session_id>\n'

# FORCE_FRESH must skip typed id and cwd continue / resume --last.
: >"$LOG"
: >"$CLAUDE_LOG"
env -i \
  HOME="$TEST_ROOT/home" \
  NVM_DIR="$NVM_DIR" \
  CODEX_HOME="$TEST_ROOT/codex-home" \
  SHELL_ENV_DIR="$TEST_ROOT/shell-env" \
  CODEX_TEST_LOG="$LOG" \
  WEZDECK_RESUME_SESSION_ID="codex-sid-should-ignore" \
  WEZDECK_FORCE_FRESH_SESSION=1 \
  PATH=/usr/bin:/bin \
  WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" codex

grep -Fxq -- '--no-daemon --profile full-access' "$LOG"
! grep -Eq 'resume' "$LOG"
printf 'PASS agent-launcher FORCE_FRESH skips Codex resume\n'

env -i \
  HOME="$TEST_ROOT/home" \
  NVM_DIR="$NVM_DIR" \
  CODEX_HOME="$TEST_ROOT/codex-home" \
  SHELL_ENV_DIR="$TEST_ROOT/shell-env" \
  CLAUDE_TEST_LOG="$CLAUDE_LOG" \
  WEZDECK_RESUME_SESSION_ID="claude-sid-should-ignore" \
  WEZDECK_FORCE_FRESH_SESSION=1 \
  PATH=/usr/bin:/bin \
  WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" claude

grep -Fxq -- '--permission-mode bypassPermissions' "$CLAUDE_LOG"
! grep -Eq -- '--continue|--resume' "$CLAUDE_LOG"
printf 'PASS agent-launcher FORCE_FRESH skips Claude continue/resume\n'

mkdir -p "$TEST_ROOT/home/.config/wezdeck/agent-models"
printf "MODEL='gpt-6.2-sol'\n" > "$TEST_ROOT/home/.config/wezdeck/agent-models/codex.env"
printf "MODEL='sonnet'\n" > "$TEST_ROOT/home/.config/wezdeck/agent-models/claude.env"
env -i HOME="$TEST_ROOT/home" NVM_DIR="$NVM_DIR" CODEX_HOME="$TEST_ROOT/codex-home" \
  CODEX_TEST_LOG="$LOG" PATH=/usr/bin:/bin WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" codex
grep -Fxq -- '--no-daemon --profile auto --model gpt-6.2-sol resume --last' "$LOG"
env -i HOME="$TEST_ROOT/home" NVM_DIR="$NVM_DIR" CLAUDE_TEST_LOG="$CLAUDE_LOG" \
  PATH=/usr/bin:/bin WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" claude
grep -Fxq -- '--model sonnet --continue' "$CLAUDE_LOG"
printf 'PASS managed model overrides reach Codex and Claude resume commands\n'

printf "MODEL='gemini-4-neon-medium'\n" > "$TEST_ROOT/home/.config/wezdeck/agent-models/agy.env"
env -i HOME="$TEST_ROOT/home" NVM_DIR="$NVM_DIR" SHELL_ENV_DIR="$TEST_ROOT/shell-env" \
  AGY_TEST_LOG="$AGY_LOG" WEZDECK_RESUME_SESSION_ID=agy-session-001 \
  PATH=/usr/bin:/bin WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" agy
grep -Fxq -- '--dangerously-skip-permissions --model gemini-4-neon-medium --conversation agy-session-001' "$AGY_LOG"
grep -Fxq -- 'managed=1' "$AGY_LOG"
printf 'PASS managed Agy profile resumes with model and permission intent\n'

grep -q -- '--always-approve' "$REPO_ROOT/scripts/runtime/agent-launcher.sh"
printf 'PASS agent-launcher contains Grok full-access adapter\n'

# Managed launches pre-trust the launch worktree for Claude, Codex, and Agy
# without clobbering existing host settings, and remain idempotent.
TRUST_DIR="$TEST_ROOT/worktree-trust-dir"
mkdir -p "$TRUST_DIR" "$TEST_ROOT/trust-home/.gemini/antigravity-cli" "$TEST_ROOT/trust-codex"
printf '{"theme":"dark","projects":{"/existing":{"hasTrustDialogAccepted":true}}}\n' \
  > "$TEST_ROOT/trust-home/.claude.json"
printf '# keep comment\nmodel = "gpt-5.4"\n' \
  > "$TEST_ROOT/trust-codex/config.toml"
printf '{"model":"gemini-4-neon","trustedWorkspaces":["/existing"]}\n' \
  > "$TEST_ROOT/trust-home/.gemini/antigravity-cli/settings.json"

(
  cd "$TRUST_DIR"
  env -i HOME="$TEST_ROOT/trust-home" NVM_DIR="$NVM_DIR" CLAUDE_TEST_LOG="$CLAUDE_LOG" \
    PATH=/usr/bin:/bin WEZTERM_NO_LOADING_BANNER=1 \
    bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" claude
  env -i HOME="$TEST_ROOT/trust-home" NVM_DIR="$NVM_DIR" CODEX_HOME="$TEST_ROOT/trust-codex" \
    CODEX_TEST_LOG="$LOG" PATH=/usr/bin:/bin WEZTERM_NO_LOADING_BANNER=1 \
    bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" codex
  env -i HOME="$TEST_ROOT/trust-home" NVM_DIR="$NVM_DIR" AGY_TEST_LOG="$AGY_LOG" \
    PATH=/usr/bin:/bin WEZTERM_NO_LOADING_BANNER=1 \
    bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" agy
  # Re-run to verify idempotency (no duplicate entries).
  env -i HOME="$TEST_ROOT/trust-home" NVM_DIR="$NVM_DIR" AGY_TEST_LOG="$AGY_LOG" \
    PATH=/usr/bin:/bin WEZTERM_NO_LOADING_BANNER=1 \
    bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" agy
)

python3 - "$TEST_ROOT/trust-home" "$TEST_ROOT/trust-codex/config.toml" "$TRUST_DIR" <<'PY'
import json, os, sys, tomllib

home, codex_cfg, cwd = sys.argv[1], sys.argv[2], os.path.realpath(sys.argv[3])

with open(os.path.join(home, ".claude.json"), encoding="utf-8") as f:
    claude = json.load(f)
assert claude["theme"] == "dark"
assert claude["projects"]["/existing"]["hasTrustDialogAccepted"] is True
assert claude["projects"][cwd]["hasTrustDialogAccepted"] is True

with open(codex_cfg, encoding="utf-8") as f:
    raw_toml = f.read()
assert "# keep comment" in raw_toml
codex = tomllib.loads(raw_toml)
assert codex["model"] == "gpt-5.4"
assert codex["projects"][cwd]["trust_level"] == "trusted"

with open(os.path.join(home, ".gemini", "antigravity-cli", "settings.json"), encoding="utf-8") as f:
    agy = json.load(f)
assert agy["model"] == "gemini-4-neon"
assert "/existing" in agy["trustedWorkspaces"]
assert agy["trustedWorkspaces"].count(cwd) == 1
PY
printf 'PASS agent-launcher pre-trusts managed worktrees for Claude, Codex, and Agy\n'

if command -v zsh >/dev/null; then
  for tmux_context in '/tmp/test-tmux,1,0' ''; do
    env -i PATH="$FAKE_BIN:/usr/bin:/bin" WEZDECK_REPO="$REPO_ROOT" \
      CODEX_TEST_LOG="$LOG" TMUX="$tmux_context" zsh -fic '
        source "$WEZDECK_REPO/wezterm-x/local.example/shell-env.d/wezdeck-codex.env"
        codex resume session-id'
    if [[ -n "$tmux_context" ]]; then
      grep -Fxq -- '--no-daemon resume session-id' "$LOG"
    else
      grep -Fxq -- 'resume session-id' "$LOG"
    fi
  done
  env PATH="$FAKE_BIN:/usr/bin:/bin" CODEX_TEST_LOG="$LOG" \
    bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" codex --interactive \
      --remote ws://localhost:1234
  grep -Fxq -- '--remote ws://localhost:1234' "$LOG"
  printf 'PASS interactive Codex uses --no-daemon in tmux and preserves explicit remote\n'
fi

mkdir -p "$TEST_ROOT/home/.config/wezdeck/agent-profiles"
printf '{"disabled":true,"note":"currently unavailable"}\n' \
  > "$TEST_ROOT/home/.config/wezdeck/agent-profiles/claude.json"
rm -f "$CLAUDE_LOG"
if env -i HOME="$TEST_ROOT/home" NVM_DIR="$NVM_DIR" CLAUDE_TEST_LOG="$CLAUDE_LOG" \
  PATH=/usr/bin:/bin WEZTERM_NO_LOADING_BANNER=1 \
  bash "$REPO_ROOT/scripts/runtime/agent-launcher.sh" claude \
  >"$TEST_ROOT/disabled.out" 2>&1; then
  echo 'FAIL disabled Claude launched' >&2
  exit 1
fi
grep -q 'profile claude is disabled' "$TEST_ROOT/disabled.out"
test ! -e "$CLAUDE_LOG"
printf 'PASS disabled managed profile cannot start a new CLI process\n'
