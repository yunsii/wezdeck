#!/usr/bin/env bash
# Check the Node runtime used by tmux and managed CLI launchers.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
advisory=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --advisory) advisory=1; shift ;;
    -h|--help)
      printf 'Usage: %s [--advisory]\n' "$(basename "$0")"
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

# shellcheck disable=SC1091
source "$repo_root/scripts/runtime/runtime-env-lib.sh"
runtime_env_load_managed
runtime_env_add_user_cli_paths

node_path="$(command -v node 2>/dev/null || true)"
node_version=""
if [[ -n "$node_path" ]]; then
  node_version="$(node -v 2>/dev/null || true)"
fi

fnm_default_node=""
while IFS= read -r fnm_root; do
  candidate="$fnm_root/aliases/default/bin/node"
  if [[ -x "$candidate" ]]; then
    fnm_default_node="$candidate"
    break
  fi
done < <(runtime_env_fnm_roots)

nvm_dir="${NVM_DIR:-$HOME/.nvm}"
nvm_installed=0
[[ -s "$nvm_dir/nvm.sh" ]] && nvm_installed=1

if [[ -z "$node_path" || -z "$node_version" ]]; then
  printf '[node-check] warning: Node is unavailable to the managed runtime.\n'
  printf '[node-check] fix: install fnm, run `fnm install --lts`, then `fnm default <version>`.\n'
  if (( advisory )); then
    exit 0
  fi
  exit 1
fi

resolved_node_path="$(readlink -f "$node_path" 2>/dev/null || printf '%s' "$node_path")"
case "$resolved_node_path" in
  */.nvm/*)
    printf '[node-check] warning: Node currently resolves through nvm: %s (%s)\n' \
      "$node_path" "$node_version"
    if [[ -n "$fnm_default_node" ]]; then
      printf '[node-check] migration: fnm default Node is ready at %s; restart tmux after switching PATH.\n' \
        "$fnm_default_node"
    else
      printf '[node-check] migration: run `fnm install --lts && fnm default <version>`, then verify the stable aliases/default/bin path.\n'
    fi
    (( advisory )) && exit 0
    exit 1
    ;;
esac

if [[ -n "$fnm_default_node" && "$node_path" == "$fnm_default_node"* ]]; then
  printf '[node-check] healthy: fnm default Node %s (%s)\n' "$node_path" "$node_version"
else
  printf '[node-check] healthy: Node %s (%s)\n' "$node_path" "$node_version"
  if (( nvm_installed )); then
    printf '[node-check] note: nvm is still installed at %s; remove it after dependent tools have moved to fnm.\n' "$nvm_dir"
  fi
fi
