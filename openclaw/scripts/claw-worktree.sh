#!/usr/bin/env bash
# Claw-owned git worktrees for OpenClaw development tasks.
# Layout mirrors WezDeck worktree-task, but uses a reserved slug/branch prefix
# so human-created dev-*/task-*/hotfix-* worktrees are never touched.
#
# Directory:  $HOME/work/.worktrees/<repo>/claw-<slug>/
# Branch:     claw/<slug>
#
# Requires: worktree-task from wezterm-config (WEZDECK_REPO / this repo).
set -euo pipefail

cmd="${1:-}"
shift || true

# Resolve wezdeck / worktree-task without hard-coding a username.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WEZDECK_REPO="${WEZDECK_REPO:-${WEZTERM_CONFIG_REPO:-${REPO_ROOT}}}"
WT_BIN="${WEZDECK_REPO}/scripts/runtime/worktree/worktree-task"

CLAW_DIR_PREFIX="${OPENCLAW_CLAW_WORKTREE_PREFIX:-claw-}"
CLAW_BRANCH_PREFIX="${OPENCLAW_CLAW_BRANCH_PREFIX:-claw/}"

# Default primary repo for development (portable; override with --cwd).
DEFAULT_REPO="${OPENCLAW_CLAW_DEFAULT_REPO:-${HOME}/work/coco-forge}"

usage() {
  cat <<EOF
Usage:
  claw-worktree.sh create --title SUBJECT [--cwd REPO] [--slug SLUG] [--base-ref REF]
  claw-worktree.sh reclaim --slug claw-SLUG | --worktree-root PATH [--cwd REPO] [--force]
  claw-worktree.sh list [--cwd REPO]

Reserved layout (do not use for human WezDeck worktrees):
  dir:    .worktrees/<repo>/${CLAW_DIR_PREFIX}<slug>
  branch: ${CLAW_BRANCH_PREFIX}<slug>

Human-owned prefixes (never create/reclaim via this script):
  dev-*  task-*  hotfix-*

Env:
  WEZDECK_REPO / WEZTERM_CONFIG_REPO  worktree-task home (default: this monorepo)
  OPENCLAW_CLAW_DEFAULT_REPO          default --cwd (default: \$HOME/work/coco-forge)
  OPENCLAW_CLAW_WORKTREE_PREFIX       default claw-
  OPENCLAW_CLAW_BRANCH_PREFIX         default claw/
EOF
}

die() { echo "error: $*" >&2; exit 1; }

require_wt() {
  [[ -x "${WT_BIN}" ]] || die "worktree-task not found at ${WT_BIN} (set WEZDECK_REPO)"
  export WEZDECK_REPO
}

slugify() {
  # lowercase, non-alnum -> -, trim
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
}

is_claw_slug() {
  local s="$1"
  [[ "${s}" == ${CLAW_DIR_PREFIX}* ]]
}

is_human_slug() {
  local s="$1"
  [[ "${s}" == dev-* || "${s}" == task-* || "${s}" == hotfix-* ]]
}

assert_not_human_path() {
  local p base
  p="$(basename "${1%/}")"
  if is_human_slug "${p}"; then
    die "refusing to touch human WezDeck worktree '${p}' (dev-/task-/hotfix- are user-owned)"
  fi
  if [[ "${p}" != ${CLAW_DIR_PREFIX}* && "${cmd}" == "reclaim" ]]; then
    die "reclaim only allowed for '${CLAW_DIR_PREFIX}*' worktrees, got '${p}'"
  fi
}

cmd_create() {
  local title="" cwd="${DEFAULT_REPO}" slug="" base_ref=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title) title="$2"; shift 2 ;;
      --cwd) cwd="$2"; shift 2 ;;
      --slug) slug="$2"; shift 2 ;;
      --base-ref) base_ref="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown arg: $1" ;;
    esac
  done
  [[ -n "${title}" ]] || die "--title required"
  [[ -d "${cwd}" ]] || die "repo not found: ${cwd}"
  require_wt

  local subject branch dir_slug branch_tail
  subject="$(slugify "${title}")"
  [[ -n "${subject}" ]] || subject="task"
  # avoid claw-claw-* if title already contains reserved prefix
  subject="${subject#${CLAW_DIR_PREFIX}}"
  subject="${subject#claw-}"

  if [[ -n "${slug}" ]]; then
    dir_slug="$(slugify "${slug}")"
    dir_slug="${dir_slug#${CLAW_DIR_PREFIX}}"
    dir_slug="${dir_slug#claw-}"
    dir_slug="${CLAW_DIR_PREFIX}${dir_slug}"
  else
    dir_slug="${CLAW_DIR_PREFIX}${subject}"
  fi

  if is_human_slug "${dir_slug}"; then
    die "slug collides with human lifecycle prefix: ${dir_slug}"
  fi

  branch_tail="${dir_slug#"${CLAW_DIR_PREFIX}"}"
  branch="${CLAW_BRANCH_PREFIX}${branch_tail}"

  # Headless: no tmux attach — OpenClaw runs outside WezDeck panes by default
  local args=(
    launch
    --cwd "${cwd}"
    --title "${title}"
    --task-slug "${dir_slug}"
    --branch "${branch}"
    --provider none
    --provider-mode off
    --no-attach
  )
  if [[ -n "${base_ref}" ]]; then
    args+=(--base-ref "${base_ref}")
  fi

  echo "creating claw worktree slug=${dir_slug} branch=${branch} cwd=${cwd}" >&2
  "${WT_BIN}" "${args[@]}"

  # Print machine-readable path for agents
  local wt_parent repo_name wt_path
  repo_name="$(basename "$(realpath "${cwd}")")"
  # worktree-task uses parent of repo: .worktrees/{repo}/slug
  wt_parent="$(realpath "${cwd}/..")/.worktrees/${repo_name}"
  # if policy is under repo parent - check both layouts
  if [[ ! -d "${wt_parent}/${dir_slug}" ]]; then
    wt_parent="$(realpath "${cwd}")/../.worktrees/${repo_name}"
    wt_parent="$(realpath -m "${wt_parent}")"
  fi
  wt_path="$(realpath -m "${HOME}/work/.worktrees/${repo_name}/${dir_slug}")"
  if [[ -d "${wt_path}" ]]; then
    printf '%s\n' "${wt_path}"
  else
    # fallback: ask git
    git -C "${cwd}" worktree list --porcelain 2>/dev/null | awk -v s="/${dir_slug}" '
      $1=="worktree" {p=$2}
      p!="" && index(p,s) {print p; exit}
    ' || true
  fi
}

cmd_reclaim() {
  local slug="" root="" cwd="${DEFAULT_REPO}" force=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --slug) slug="$2"; shift 2 ;;
      --worktree-root) root="$2"; shift 2 ;;
      --cwd) cwd="$2"; shift 2 ;;
      --force) force=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown arg: $1" ;;
    esac
  done
  require_wt
  [[ -n "${slug}" || -n "${root}" ]] || die "need --slug or --worktree-root"

  if [[ -n "${slug}" ]]; then
    if ! is_claw_slug "${slug}"; then
      die "reclaim slug must start with '${CLAW_DIR_PREFIX}' (got '${slug}')"
    fi
    if is_human_slug "${slug}"; then
      die "refusing human worktree slug '${slug}'"
    fi
  fi
  if [[ -n "${root}" ]]; then
    assert_not_human_path "${root}"
    local base
    base="$(basename "${root%/}")"
    is_claw_slug "${base}" || die "worktree-root basename must start with '${CLAW_DIR_PREFIX}'"
  fi

  local args=(reclaim --cwd "${cwd}" --provider none --provider-mode off)
  if [[ -n "${slug}" ]]; then
    args+=(--task-slug "${slug}")
  else
    args+=(--worktree-root "${root}")
  fi
  if [[ "${force}" -eq 1 ]]; then
    args+=(--force)
  fi

  echo "reclaiming claw worktree..." >&2
  "${WT_BIN}" "${args[@]}"
}

cmd_list() {
  local cwd="${DEFAULT_REPO}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cwd) cwd="$2"; shift 2 ;;
      *) die "unknown arg: $1" ;;
    esac
  done
  [[ -d "${cwd}" ]] || die "repo not found: ${cwd}"
  local repo_name wt_root
  repo_name="$(basename "$(realpath "${cwd}")")"
  wt_root="${HOME}/work/.worktrees/${repo_name}"
  if [[ ! -d "${wt_root}" ]]; then
    echo "no worktrees dir: ${wt_root}" >&2
    exit 0
  fi
  # shellcheck disable=SC2012
  ls -1 "${wt_root}" 2>/dev/null | while read -r name; do
    [[ -z "${name}" || "${name}" == .* ]] && continue
    if is_claw_slug "${name}"; then
      printf 'claw|%s|%s\n' "${name}" "${wt_root}/${name}"
    elif is_human_slug "${name}"; then
      printf 'human|%s|%s\n' "${name}" "${wt_root}/${name}"
    else
      printf 'other|%s|%s\n' "${name}" "${wt_root}/${name}"
    fi
  done
}

case "${cmd}" in
  create) cmd_create "$@" ;;
  reclaim) cmd_reclaim "$@" ;;
  list) cmd_list "$@" ;;
  ""|-h|--help) usage ;;
  *) die "unknown command: ${cmd}" ;;
esac
