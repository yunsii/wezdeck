#!/usr/bin/env bash
# Claw-owned git worktrees — mirrors WezDeck lifecycle (dev/task/hotfix) but
# under reserved prefixes so human worktrees are never touched.
#
# WezDeck human:  dev-* | task-* | hotfix-*     branches dev/ | task/ | hotfix/
# OpenClaw claw:  claw-dev-* | claw-task-* | claw-hotfix-*
#                 branches    claw/dev/ | claw/task/ | claw/hotfix/
#
# Parent dir is the same: $HOME/work/.worktrees/<repo>/
set -euo pipefail

cmd="${1:-}"
shift || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WEZDECK_REPO="${WEZDECK_REPO:-${WEZTERM_CONFIG_REPO:-${REPO_ROOT}}}"
WT_BIN="${WEZDECK_REPO}/scripts/runtime/worktree/worktree-task"
DEFAULT_REPO="${OPENCLAW_CLAW_DEFAULT_REPO:-${HOME}/work/coco-forge}"

usage() {
  cat <<'EOF'
Usage:
  claw-worktree.sh assess  --title SUBJECT [--domain DOMAIN] [--scope HINT]
                           [--days N] [--cwd REPO]
      Print recommended lifecycle + slug + branch (no create).

  claw-worktree.sh create  --title SUBJECT --lifecycle task|dev|hotfix
                           [--domain DOMAIN] [--cwd REPO] [--slug SLUG]
                           [--base-ref REF]
      Create claw worktree. Lifecycle is required (or use assess first).

  claw-worktree.sh reclaim --slug claw-{task|dev|hotfix}-SLUG
                           [--cwd REPO] [--force] [--allow-long-lived]
  claw-worktree.sh list    [--cwd REPO]

Lifecycle (aligned with WezDeck, claw-owned only):

  kind     dir prefix        branch prefix     lifetime        reclaim
  -------  ----------------  ----------------  --------------  -----------------
  task     claw-task-        claw/task/        hours–days      default after done
  dev      claw-dev-         claw/dev/         weeks–months    needs --allow-long-lived
  hotfix   claw-hotfix-      claw/hotfix/      hours           default after done

Human WezDeck prefixes (never touch): dev-* task-* hotfix-* (without claw-)

Domain (optional): short area tag for slug, e.g. i18n, platform, userscript
  → claw-task-i18n-cache-search-field
EOF
}

die() { echo "error: $*" >&2; exit 1; }

require_wt() {
  [[ -x "${WT_BIN}" ]] || die "worktree-task not found at ${WT_BIN} (set WEZDECK_REPO)"
  export WEZDECK_REPO
}

slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
}

is_human_slug() {
  local s="$1"
  # human only if NOT claw-prefixed
  [[ "${s}" != claw-* ]] || return 1
  [[ "${s}" == dev-* || "${s}" == task-* || "${s}" == hotfix-* ]]
}

is_claw_slug() {
  local s="$1"
  [[ "${s}" == claw-task-* || "${s}" == claw-dev-* || "${s}" == claw-hotfix-* || "${s}" == claw-* ]]
}

# New preferred shapes
is_claw_lifecycle_slug() {
  local s="$1"
  [[ "${s}" == claw-task-* || "${s}" == claw-dev-* || "${s}" == claw-hotfix-* ]]
}

lifecycle_dir_prefix() {
  case "$1" in
    task) echo "claw-task-" ;;
    dev) echo "claw-dev-" ;;
    hotfix) echo "claw-hotfix-" ;;
    *) die "lifecycle must be task|dev|hotfix" ;;
  esac
}

lifecycle_branch_prefix() {
  case "$1" in
    task) echo "claw/task/" ;;
    dev) echo "claw/dev/" ;;
    hotfix) echo "claw/hotfix/" ;;
    *) die "lifecycle must be task|dev|hotfix" ;;
  esac
}

normalize_lifecycle() {
  local lc
  lc="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "${lc}" in
    task|dev|hotfix) printf '%s' "${lc}" ;;
    t) echo task ;;
    d) echo dev ;;
    h) echo hotfix ;;
    *) die "lifecycle must be task|dev|hotfix (got '${1:-}')" ;;
  esac
}

# Heuristic assess (no side effects)
assess_lifecycle() {
  local title="$1" domain="$2" scope="$3" days="${4:-}"
  local lc="task" reasons=()

  # explicit days hint
  if [[ -n "${days}" ]]; then
    if [[ "${days}" -ge 14 ]]; then
      lc="dev"
      reasons+=("expected duration >=14d → dev (long-lived)")
    elif [[ "${days}" -le 2 ]]; then
      lc="task"
      reasons+=("expected duration <=2d → task")
    else
      lc="task"
      reasons+=("expected duration ${days}d → task (default mid-range)")
    fi
  fi

  local blob
  blob="$(printf '%s %s %s' "${title}" "${domain}" "${scope}" | tr '[:upper:]' '[:lower:]')"

  if echo "${blob}" | grep -qE 'hotfix|紧急|线上|prod|production|p0|阻断|回滚'; then
    lc="hotfix"
    reasons+=("keywords suggest production urgency → hotfix")
  elif echo "${blob}" | grep -qE 'epic|平台|platform|长期|workstation|重构大|multi-week|迭代'; then
    if [[ "${lc}" != "hotfix" ]]; then
      lc="dev"
      reasons+=("keywords suggest long-running area work → dev")
    fi
  elif echo "${blob}" | grep -qE 'fix|bug|小改|缓存|文案|样式|单测|chore|docs'; then
    if [[ "${lc}" == "task" ]]; then
      reasons+=("keywords suggest scoped delivery → task")
    fi
  fi

  if [[ ${#reasons[@]} -eq 0 ]]; then
    reasons+=("default → task (PR-scoped, reclaim after delivery)")
  fi

  local subject domain_slug slug dir_prefix branch_prefix
  subject="$(slugify "${title}")"
  subject="${subject#claw-task-}"; subject="${subject#claw-dev-}"; subject="${subject#claw-hotfix-}"
  subject="${subject#claw-}"
  # drop lifecycle words from subject to avoid claw-hotfix-…-hotfix-…
  subject="$(printf '%s' "${subject}" | sed -E 's/^(hotfix|task|dev)-//')"
  [[ -n "${subject}" ]] || subject="work"

  domain_slug=""
  if [[ -n "${domain}" ]]; then
    domain_slug="$(slugify "${domain}")"
    # avoid domain-domain-subject when title starts with domain
    subject="${subject#"${domain_slug}-"}"
  fi

  dir_prefix="$(lifecycle_dir_prefix "${lc}")"
  branch_prefix="$(lifecycle_branch_prefix "${lc}")"
  if [[ -n "${domain_slug}" ]]; then
    slug="${dir_prefix}${domain_slug}-${subject}"
  else
    slug="${dir_prefix}${subject}"
  fi
  # cap slug length roughly
  if [[ ${#slug} -gt 80 ]]; then
    slug="${slug:0:80}"
    slug="${slug%-}"
  fi

  local branch_tail="${slug#"${dir_prefix}"}"
  local branch="${branch_prefix}${branch_tail}"

  cat <<EOF
{
  "lifecycle": "${lc}",
  "dir_slug": "${slug}",
  "branch": "${branch}",
  "domain": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "${domain}"),
  "reasons": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "${reasons[@]}") ,
  "reclaim": $( [[ "${lc}" == "dev" ]] && echo '"needs --allow-long-lived after delivery checks"' || echo '"standard after merge/push"' ),
  "note": "Assessment only — confirm with user before create. Human worktrees (dev-/task-/hotfix- without claw-) are never used."
}
EOF
}

cmd_assess() {
  local title="" domain="" scope="" days="" cwd="${DEFAULT_REPO}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title) title="$2"; shift 2 ;;
      --domain) domain="$2"; shift 2 ;;
      --scope) scope="$2"; shift 2 ;;
      --days) days="$2"; shift 2 ;;
      --cwd) cwd="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown arg: $1" ;;
    esac
  done
  [[ -n "${title}" ]] || die "--title required"
  assess_lifecycle "${title}" "${domain}" "${scope}" "${days}"
}

cmd_create() {
  local title="" cwd="${DEFAULT_REPO}" slug="" base_ref="" lifecycle="" domain=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title) title="$2"; shift 2 ;;
      --cwd) cwd="$2"; shift 2 ;;
      --slug) slug="$2"; shift 2 ;;
      --base-ref) base_ref="$2"; shift 2 ;;
      --lifecycle|--kind) lifecycle="$2"; shift 2 ;;
      --domain) domain="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown arg: $1" ;;
    esac
  done
  [[ -n "${title}" ]] || die "--title required"
  [[ -d "${cwd}" ]] || die "repo not found: ${cwd}"
  require_wt

  if [[ -z "${lifecycle}" && -z "${slug}" ]]; then
    die "pass --lifecycle task|dev|hotfix (or full --slug claw-task-…); run 'assess' first"
  fi

  local dir_slug branch dir_prefix branch_prefix subject branch_tail

  if [[ -n "${slug}" ]]; then
    dir_slug="$(slugify "${slug}")"
    # ensure claw- lifecycle prefix
    if ! is_claw_lifecycle_slug "${dir_slug}"; then
      # legacy claw-foo → treat as claw-task-foo
      dir_slug="${dir_slug#claw-}"
      lifecycle="$(normalize_lifecycle "${lifecycle:-task}")"
      dir_prefix="$(lifecycle_dir_prefix "${lifecycle}")"
      dir_slug="${dir_prefix}${dir_slug}"
    else
      if [[ "${dir_slug}" == claw-dev-* ]]; then lifecycle="dev"
      elif [[ "${dir_slug}" == claw-hotfix-* ]]; then lifecycle="hotfix"
      else lifecycle="task"
      fi
    fi
  else
    lifecycle="$(normalize_lifecycle "${lifecycle}")"
    dir_prefix="$(lifecycle_dir_prefix "${lifecycle}")"
    subject="$(slugify "${title}")"
    subject="${subject#claw-task-}"; subject="${subject#claw-dev-}"; subject="${subject#claw-hotfix-}"
    subject="${subject#claw-}"
    [[ -n "${subject}" ]] || subject="work"
    if [[ -n "${domain}" ]]; then
      dir_slug="${dir_prefix}$(slugify "${domain}")-${subject}"
    else
      dir_slug="${dir_prefix}${subject}"
    fi
  fi

  is_human_slug "${dir_slug}" && die "slug collides with human prefix: ${dir_slug}"
  is_claw_slug "${dir_slug}" || die "internal: not a claw slug: ${dir_slug}"

  lifecycle="$(normalize_lifecycle "${lifecycle}")"
  dir_prefix="$(lifecycle_dir_prefix "${lifecycle}")"
  branch_prefix="$(lifecycle_branch_prefix "${lifecycle}")"
  # re-sync prefix if slug has full form
  if [[ "${dir_slug}" == claw-dev-* ]]; then
    branch_tail="${dir_slug#claw-dev-}"
    branch_prefix="$(lifecycle_branch_prefix dev)"
  elif [[ "${dir_slug}" == claw-hotfix-* ]]; then
    branch_tail="${dir_slug#claw-hotfix-}"
    branch_prefix="$(lifecycle_branch_prefix hotfix)"
  elif [[ "${dir_slug}" == claw-task-* ]]; then
    branch_tail="${dir_slug#claw-task-}"
    branch_prefix="$(lifecycle_branch_prefix task)"
  else
    branch_tail="${dir_slug#claw-}"
  fi
  branch="${branch_prefix}${branch_tail}"

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

  echo "creating lifecycle=${lifecycle} slug=${dir_slug} branch=${branch}" >&2
  "${WT_BIN}" "${args[@]}"

  local repo_name wt_path
  repo_name="$(basename "$(realpath "${cwd}")")"
  wt_path="$(realpath -m "${HOME}/work/.worktrees/${repo_name}/${dir_slug}")"
  if [[ -d "${wt_path}" ]]; then
    printf '%s\n' "${wt_path}"
  else
    git -C "${cwd}" worktree list --porcelain 2>/dev/null | awk -v s="/${dir_slug}" '
      $1=="worktree" {p=$2}
      p!="" && index(p,s) {print p; exit}
    ' || true
  fi
}

cmd_reclaim() {
  local slug="" root="" cwd="${DEFAULT_REPO}" force=0 long=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --slug) slug="$2"; shift 2 ;;
      --worktree-root) root="$2"; shift 2 ;;
      --cwd) cwd="$2"; shift 2 ;;
      --force) force=1; shift ;;
      --allow-long-lived) long=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown arg: $1" ;;
    esac
  done
  require_wt
  [[ -n "${slug}" || -n "${root}" ]] || die "need --slug or --worktree-root"

  local name=""
  if [[ -n "${slug}" ]]; then
    name="${slug}"
  else
    name="$(basename "${root%/}")"
  fi

  if is_human_slug "${name}"; then
    die "refusing human WezDeck worktree '${name}'"
  fi
  if ! is_claw_slug "${name}"; then
    die "reclaim only claw-* worktrees (got '${name}')"
  fi
  # claw-dev-* requires allow-long-lived (mirror WezDeck dev-*)
  if [[ "${name}" == claw-dev-* && "${long}" -ne 1 ]]; then
    die "claw-dev-* is long-lived; pass --allow-long-lived after delivery checks (mirrors WezDeck dev-*)"
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
  if [[ "${long}" -eq 1 ]]; then
    args+=(--allow-long-lived)
  fi

  echo "reclaiming ${name}..." >&2
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
  ls -1 "${wt_root}" 2>/dev/null | while read -r name; do
    [[ -z "${name}" || "${name}" == .* ]] && continue
    if [[ "${name}" == claw-dev-* ]]; then
      printf 'claw-dev|%s|%s\n' "${name}" "${wt_root}/${name}"
    elif [[ "${name}" == claw-task-* ]]; then
      printf 'claw-task|%s|%s\n' "${name}" "${wt_root}/${name}"
    elif [[ "${name}" == claw-hotfix-* ]]; then
      printf 'claw-hotfix|%s|%s\n' "${name}" "${wt_root}/${name}"
    elif [[ "${name}" == claw-* ]]; then
      printf 'claw-legacy|%s|%s\n' "${name}" "${wt_root}/${name}"
    elif is_human_slug "${name}"; then
      printf 'human|%s|%s\n' "${name}" "${wt_root}/${name}"
    else
      printf 'other|%s|%s\n' "${name}" "${wt_root}/${name}"
    fi
  done
}

case "${cmd}" in
  assess) cmd_assess "$@" ;;
  create) cmd_create "$@" ;;
  reclaim) cmd_reclaim "$@" ;;
  list) cmd_list "$@" ;;
  ""|-h|--help) usage ;;
  *) die "unknown command: ${cmd}" ;;
esac
