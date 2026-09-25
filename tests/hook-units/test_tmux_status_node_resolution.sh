#!/usr/bin/env bash
# tmux status Node resolution: fnm migration and cache identity checks.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/scripts/runtime/tmux-status-line-main.sh"
test_root="$(mktemp -d /tmp/wezterm-status-node.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT

fnm_root="$test_root/fnm"
cache_file="$test_root/node-cache"
shell_env="$test_root/shell-env"
mkdir -p "$fnm_root/aliases/default/bin" "$shell_env"

cat > "$fnm_root/aliases/default/bin/node" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' 'v24.8.0'
EOF
chmod +x "$fnm_root/aliases/default/bin/node"

# FNM_DIR comes from the same managed env layer as a real machine-local setup.
printf 'FNM_DIR=%q\n' "$fnm_root" > "$shell_env/10-fnm.env"
# Reproduce the stale format/value that caused a migrated install to stay
# unavailable until the one-hour cache TTL expired.
printf '%s\n%s\n' "$(date +%s)" '__missing__' > "$cache_file"

output="$(env -i \
  HOME="$test_root/home" \
  SHELL_ENV_DIR="$shell_env" \
  PATH=/usr/bin:/bin \
  TMUX_STATUS_NODE_CACHE="$cache_file" \
  TMUX_STATUS_RENDER_REPO=0 \
  TMUX_STATUS_RENDER_BRANCH=0 \
  TMUX_STATUS_RENDER_GIT_CHANGES=0 \
  TMUX_STATUS_RENDER_NODE=1 \
  bash "$script" "$test_root")"

if [[ "$output" == *'v24.8.0'* ]]; then
  printf 'PASS tmux status resolves Node from managed fnm FNM_DIR\n'
else
  printf 'FAIL tmux status did not resolve managed fnm Node: %s\n' "$output" >&2
  exit 1
fi

cache_identity="$(sed -n '2p' "$cache_file")"
cache_version="$(sed -n '3p' "$cache_file")"
if [[ "$cache_identity" == "$fnm_root/aliases/default/bin/node" && "$cache_version" == 'v24.8.0' ]]; then
  printf 'PASS tmux status refreshes stale cache and records Node identity\n'
else
  printf 'FAIL unexpected Node cache identity=%s version=%s\n' \
    "$cache_identity" "$cache_version" >&2
  exit 1
fi
