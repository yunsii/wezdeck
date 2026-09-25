#!/usr/bin/env bash
# Node runtime check: warn when the active runtime still resolves through nvm.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_root="$(mktemp -d /tmp/wezterm-node-check.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT

nvm_dir="$test_root/.nvm"
node_bin="$nvm_dir/versions/node/v22.21.1/bin"
shell_env="$test_root/shell-env"
mkdir -p "$node_bin" "$shell_env"
printf '# nvm test marker\n' > "$nvm_dir/nvm.sh"
cat > "$node_bin/node" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'v22.21.1'
EOF
chmod +x "$node_bin/node"

output="$(env -i \
  HOME="$test_root/home" \
  NVM_DIR="$nvm_dir" \
  SHELL_ENV_DIR="$shell_env" \
  PATH="$node_bin:/usr/bin:/bin" \
  bash "$repo_root/scripts/dev/check-node-runtime.sh" --advisory)"

grep -Fq 'warning: Node currently resolves through nvm' <<< "$output"
grep -Fq 'migration:' <<< "$output"
printf 'PASS node runtime check warns about active nvm\n'
