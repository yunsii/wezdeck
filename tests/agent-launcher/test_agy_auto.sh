#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_root="$(mktemp -d /tmp/wezdeck-agy-auto.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT

fake_bin="$test_root/.nvm/versions/node/v22.21.1/bin"
mkdir -p "$fake_bin" "$test_root/.nvm/alias" "$test_root/home" "$test_root/shell-env"
printf '22\n' > "$test_root/.nvm/alias/default"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" > "${AGY_TEST_LOG:?}"\n' > "$fake_bin/agy"
chmod +x "$fake_bin/agy"
printf "MODEL='gemini-4-neon-medium'\n" > "$test_root/model"
mkdir -p "$test_root/home/.config/wezdeck/agent-models"
cp "$test_root/model" "$test_root/home/.config/wezdeck/agent-models/agy.env"

run_agy() {
  local profile="$1"
  env -i HOME="$test_root/home" NVM_DIR="$test_root/.nvm" \
    SHELL_ENV_DIR="$test_root/shell-env" MANAGED_AGENT_PERMISSION_PROFILE="$profile" \
    AGY_TEST_LOG="$test_root/argv" WEZDECK_RESUME_SESSION_ID=agy-session-001 \
    PATH=/usr/bin:/bin WEZTERM_NO_LOADING_BANNER=1 \
    bash "$repo_root/scripts/runtime/agent-launcher.sh" agy
}

run_agy auto
grep -Fxq -- '--mode auto --model gemini-4-neon-medium --conversation agy-session-001' "$test_root/argv"
run_agy ''
grep -Fxq -- '--model gemini-4-neon-medium --conversation agy-session-001' "$test_root/argv"
run_agy full-access
grep -Fxq -- '--dangerously-skip-permissions --model gemini-4-neon-medium --conversation agy-session-001' "$test_root/argv"
printf 'PASS Agy auto, base, and full-access launch arguments\n'
