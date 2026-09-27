#!/usr/bin/env bash
# runtime-env-lib.sh — unified env-loading for managed runtime scripts.
#
# Why a library instead of dotfile injection:
#   Several agent / status / hook entry points fork from tmux server via
#   plain `sh -c '<cmd>'` and never traverse the user's interactive zsh,
#   so anything injected by ~/.zshrc (secrets under
#   ~/.config/shell-env.d/*.env, PATH increments, etc.) is invisible to
#   them. Rather than coerce every path through zsh, runtime scripts call
#   the loaders below explicitly. Side benefit: the same lib serves
#   status-bar scripts, agent launchers, and Claude hooks, replacing
#   five ad-hoc copies of the same parser.
#
# Two genres of files, two primitives:
#   runtime_env_load_shell <file>
#     `set -a`-then-`source` a shell-clean KEY=VALUE file (e.g.
#     wezterm-x/local/shared.env, ~/.config/shell-env.d/cnb.env).
#     Existing env is NOT auto-preserved — assignments in the file
#     overwrite, matching the plain `source` semantics callers expect.
#     Idempotent.
#
#   runtime_env_read_key <file> <KEY>
#     Stdout the value of KEY using a literal grep+strip parser. Use for
#     files whose values may contain shell metachars or multi-word commands
#     (e.g. config/worktree-task.env), which would be re-interpreted as
#     commands under set -a + source.
#
# High-level helper:
#   runtime_env_load_managed
#     Source standard managed-runtime env in order:
#       1. <repo>/wezterm-x/local/shared.env   (tracked-template + private)
#       2. ${SHELL_ENV_DIR:-~/.config/shell-env.d}/*.env in lex order
#          (the canonical location for user-level secrets; mirror the same
#          dir from ~/.zshrc / ~/.zshenv — one-time snippet
#          wezterm-x/local.example/zshrc-shell-env.zsh, see
#          docs/setup.md#interactive-zsh-shell-envd — so interactive
#          shells and runtime scripts share one source of truth.
#          Adding a new secret means dropping a file there, no loader
#          changes needed)
#     Each step is optional; missing files / dirs are silently skipped.
#
# shellcheck shell=bash

if [[ -n "${__RUNTIME_ENV_LIB_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
__RUNTIME_ENV_LIB_LOADED=1

runtime_env_repo_root() {
  if [[ -n "${WEZDECK_REPO_ROOT:-}" ]]; then
    printf '%s' "$WEZDECK_REPO_ROOT"
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

# Retired shell-env names. Detected, warned, and not sourced — the old
# file must not keep setting WEZDECK_REPO or PATH. Removal follow-up:
# delete this case once no machine still has the old filenames.
runtime_env_retired_shell_file() {
  case "$(basename "$1")" in
    wezterm-env.env|wezterm-fn.env) return 0 ;;
    *) return 1 ;;
  esac
}

runtime_env_warn_retired() {
  local file="$1"
  local base replacement
  base="$(basename "$file")"
  replacement="wezdeck-${base#wezterm-}"
  printf 'runtime-env: skip retired %s; mv %s %s\n' \
    "$base" "$file" "$(dirname "$file")/$replacement" >&2
  if [[ -z "${__RUNTIME_ENV_LOG_LOADED:-}" ]]; then
    local log_lib
    log_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime-log-lib.sh"
    if [[ -r "$log_lib" ]]; then
      # shellcheck disable=SC1090
      . "$log_lib"
      __RUNTIME_ENV_LOG_LOADED=1
    fi
  fi
  if declare -F runtime_log_warn >/dev/null 2>&1; then
    runtime_log_init
    runtime_log_warn env "retired shell-env file skipped" \
      "file=$file" "replacement=$replacement"
  fi
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
    if runtime_env_retired_shell_file "$f"; then
      runtime_env_warn_retired "$f"
      continue
    fi
    [[ -r "$f" ]] && runtime_env_load_shell "$f"
  done
  shopt -u nullglob 2>/dev/null || true
}

# Print stable fnm data roots in priority order. The first root is the
# explicit machine/user override; the remaining roots cover fnm's defaults.
runtime_env_fnm_roots() {
  local fnm_dir="${FNM_DIR:-}"
  local xdg_data_home="${XDG_DATA_HOME:-$HOME/.local/share}"

  [[ -n "$fnm_dir" ]] && printf '%s\n' "$fnm_dir"
  printf '%s\n' "$xdg_data_home/fnm"
  [[ "$HOME/.local/share/fnm" == "$xdg_data_home/fnm" ]] || \
    printf '%s\n' "$HOME/.local/share/fnm"
  printf '%s\n' "$HOME/.fnm"
}

# Add user-installed CLI directories without sourcing an interactive shell.
# tmux servers often start with a minimal PATH, while tools such as Codex are
# installed under nvm/fnm-managed Node versions. Keep this deterministic and
# side-effect free: only prepend existing directories and never run a shell rc.
runtime_env_add_user_cli_paths() {
  local dir=""
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  local default_alias=""
  local nvm_default_bin=""
  local -a candidates=()
  local -a nvm_bins=()

  while IFS= read -r dir; do
    candidates+=("$dir/aliases/default/bin")
  done < <(runtime_env_fnm_roots)
  candidates+=("$HOME/.volta/bin" "$HOME/.bun/bin" "$HOME/.local/bin")

  if [[ -r "$nvm_dir/alias/default" ]]; then
    default_alias="$(tr -d '[:space:]' < "$nvm_dir/alias/default")"
  fi
  shopt -s nullglob 2>/dev/null || true
  if [[ "$default_alias" =~ ^v?[0-9]+$ ]]; then
    nvm_bins=("$nvm_dir/versions/node/v${default_alias#v}"*/bin)
  else
    nvm_bins=("$nvm_dir/versions/node"/*/bin)
  fi
  shopt -u nullglob 2>/dev/null || true
  if (( ${#nvm_bins[@]} > 0 )); then
    nvm_default_bin="$(printf '%s\n' "${nvm_bins[@]}" | sort -V | tail -n 1)"
  fi

  for dir in "$nvm_default_bin" "${candidates[@]}"; do
    [[ -d "$dir" ]] || continue
    case ":$PATH:" in
      *":$dir:"*) ;;
      *) PATH="$dir:$PATH" ;;
    esac
  done
  export PATH
}

runtime_env_load_managed() {
  local repo_root
  repo_root="$(runtime_env_repo_root)"
  runtime_env_load_shell "$repo_root/wezterm-x/local/shared.env"
  runtime_env_load_dir "${SHELL_ENV_DIR:-$HOME/.config/shell-env.d}"
}
