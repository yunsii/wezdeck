#!/usr/bin/env bash
# Post-recycle project initialization (skill layer).
# shellcheck shell=bash

wr_init_is_wezdeck() {
  local root="${1:?}"
  [[ -f "$root/wezterm.lua" && -d "$root/wezterm-x" ]]
}

wr_init_run_hook() {
  local label="${1:?}"
  local hook="${2:?}"
  shift 2
  printf 'init: running %s: %s\n' "$label" "$hook"
  # shellcheck disable=SC2086
  if [[ -x "$hook" ]]; then
    "$hook" "$@"
  else
    bash -lc "$hook" "$@"
  fi
}

wr_init_builtin_wezdeck() {
  local root="${1:?}"
  local head=""
  local brief="$root/${WT_RECYCLE_BRIEF_FILE:-.task-brief.md}"

  head="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo '?')"
  printf 'init recipe: wezdeck\n'
  printf '  HEAD: %s\n' "$head"
  printf '  sync-runtime: skip (pure git recycle does not change Windows runtime staging)\n'
  printf '  agent: resume profile keeps prior transcript; /clear if you passed --fresh-agent\n'
  if [[ -f "$brief" ]]; then
    printf '  next-task brief: %s\n' "$brief"
    printf '  ---- brief ----\n'
    sed -n '1,40p' "$brief"
    printf '  --------------\n'
  else
    printf '  next-task brief: (none)\n'
  fi
  printf '  ready: workstation is on origin default tip; start the next round here\n'
}

wr_init_builtin_generic() {
  local root="${1:?}"
  local head=""
  local brief="$root/${WT_RECYCLE_BRIEF_FILE:-.task-brief.md}"
  local suggestions=()

  head="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo '?')"
  printf 'init recipe: generic\n'
  printf '  HEAD: %s\n' "$head"

  if [[ -f "$root/pnpm-lock.yaml" ]]; then
    if [[ ! -d "$root/node_modules" ]]; then
      suggestions+=("pnpm install")
    fi
  elif [[ -f "$root/package-lock.json" || -f "$root/npm-shrinkwrap.json" ]]; then
    if [[ ! -d "$root/node_modules" ]]; then
      suggestions+=("npm ci")
    fi
  elif [[ -f "$root/yarn.lock" ]]; then
    if [[ ! -d "$root/node_modules" ]]; then
      suggestions+=("yarn install --frozen-lockfile")
    fi
  fi

  if [[ -f "$root/Cargo.toml" && ! -d "$root/target" ]]; then
    suggestions+=("cargo fetch  # optional")
  fi
  if [[ -f "$root/go.mod" ]]; then
    suggestions+=("go mod download  # optional")
  fi
  if [[ -f "$root/Makefile" ]] && grep -qE '^bootstrap:|^setup:' "$root/Makefile" 2>/dev/null; then
    suggestions+=("make bootstrap|setup  # if present")
  fi

  if ((${#suggestions[@]})); then
    printf '  suggested bootstrap (hints for the agent — skill does not auto-run):\n'
    local s
    for s in "${suggestions[@]}"; do
      printf '    - %s\n' "$s"
    done
  else
    printf '  suggested bootstrap: (none detected — agent should still inspect the tree)\n'
  fi

  if [[ -f "$brief" ]]; then
    printf '  next-task brief: %s\n' "$brief"
    printf '  ---- brief ----\n'
    sed -n '1,40p' "$brief"
    printf '  --------------\n'
  else
    printf '  next-task brief: (none)\n'
  fi
  printf '  ready: git reset done; agent re-inits this project for its own stack\n'
}

wr_init_run() {
  local cwd="${1:-$PWD}"
  local worktree_root=""
  local hook=""
  local ran_hook=0

  worktree_root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -n "$worktree_root" ]] || { printf 'init: not a git worktree: %s\n' "$cwd" >&2; return 2; }

  hook="$worktree_root/.worktree-recycle/post-recycle.sh"
  if [[ -x "$hook" ]]; then
    wr_init_run_hook "worktree-hook" "$hook" "$worktree_root" || return $?
    ran_hook=1
  elif [[ -n "${WT_RECYCLE_POST_HOOK:-}" ]]; then
    wr_init_run_hook "env-hook" "$WT_RECYCLE_POST_HOOK" "$worktree_root" || return $?
    ran_hook=1
  fi

  if wr_init_is_wezdeck "$worktree_root"; then
    wr_init_builtin_wezdeck "$worktree_root"
  else
    wr_init_builtin_generic "$worktree_root"
  fi

  if [[ "$ran_hook" == "1" ]]; then
    printf 'init: hook + builtin recipe done\n'
  else
    printf 'init: builtin recipe only (no project hook)\n'
  fi
  return 0
}
