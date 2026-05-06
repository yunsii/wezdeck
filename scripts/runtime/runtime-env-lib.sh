#!/usr/bin/env bash
# runtime-env-lib.sh — unified env-loading for managed runtime scripts.
#
# Why a library instead of dotfile injection:
#   Several agent / status / hook entry points fork from tmux server via
#   plain `sh -c '<cmd>'` and never traverse the user's interactive zsh,
#   so anything injected by ~/.zshrc (CNB_TOKEN from ~/.config/cnb/env,
#   PATH increments, etc.) is invisible to them. Rather than coerce every
#   path through zsh, runtime scripts call the loaders below explicitly.
#   Side benefit: the same lib serves status-bar scripts, agent launchers,
#   and Claude hooks, replacing five ad-hoc copies of the same parser.
#
# Two genres of files, two primitives:
#   runtime_env_load_shell <file>
#     `set -a`-then-`source` a shell-clean KEY=VALUE file (e.g.
#     wezterm-x/local/shared.env, ~/.config/cnb/env). Existing env is NOT
#     auto-preserved — assignments in the file overwrite, matching the
#     plain `source` semantics callers expect. Idempotent.
#
#   runtime_env_read_key <file> <KEY>
#     Stdout the value of KEY using a literal grep+strip parser. Use for
#     files whose values may contain shell metachars (e.g.
#     config/worktree-task.env carries `codex -c 'tui.theme="github"'`),
#     which would be re-interpreted as commands under set -a + source.
#
# High-level helper:
#   runtime_env_load_managed
#     Source standard managed-runtime env in order:
#       1. <repo>/wezterm-x/local/shared.env   (tracked-template + private)
#       2. ${SHELL_ENV_DIR:-~/.config/shell-env.d}/*.env in lex order
#          (the canonical location for user-level secrets; mirror the same
#          dir from ~/.zshrc / ~/.zshenv so interactive shells and runtime
#          scripts share one source of truth — adding a new secret means
#          dropping a file there, no loader changes needed)
#     Each step is optional; missing files / dirs are silently skipped.
#
# shellcheck shell=bash

if [[ -n "${__RUNTIME_ENV_LIB_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
__RUNTIME_ENV_LIB_LOADED=1

runtime_env_repo_root() {
  if [[ -n "${WEZTERM_REPO_ROOT:-}" ]]; then
    printf '%s' "$WEZTERM_REPO_ROOT"
    return 0
  fi
  local self_dir
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  ( cd "$self_dir/../.." && pwd -P )
}

runtime_env_load_shell() {
  local file="${1:?runtime_env_load_shell: missing file}"
  [[ -r "$file" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  . "$file"
  set +a
}

runtime_env_read_key() {
  local file="${1:?runtime_env_read_key: missing file}"
  local key="${2:?runtime_env_read_key: missing key}"
  [[ -f "$file" ]] || return 1
  local line raw
  line="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1)"
  [[ -n "$line" ]] || return 1
  raw="${line#${key}=}"
  if [[ "${raw:0:1}" == "'" && "${raw: -1}" == "'" ]] \
     || [[ "${raw:0:1}" == '"' && "${raw: -1}" == '"' ]]; then
    raw="${raw:1:${#raw}-2}"
  fi
  printf '%s' "$raw"
}

runtime_env_load_dir() {
  local dir="${1:?runtime_env_load_dir: missing dir}"
  [[ -d "$dir" ]] || return 0
  local f
  # Use a stable lex order so files like 00-base.env / 50-cnb.env layer
  # predictably. `nullglob`-equivalent: skip when no match instead of
  # erroring on the literal `*.env` pattern.
  shopt -s nullglob 2>/dev/null || true
  for f in "$dir"/*.env; do
    [[ -r "$f" ]] && runtime_env_load_shell "$f"
  done
  shopt -u nullglob 2>/dev/null || true
}

runtime_env_load_managed() {
  local repo_root
  repo_root="$(runtime_env_repo_root)"
  runtime_env_load_shell "$repo_root/wezterm-x/local/shared.env"
  runtime_env_load_dir "${SHELL_ENV_DIR:-$HOME/.config/shell-env.d}"
}
