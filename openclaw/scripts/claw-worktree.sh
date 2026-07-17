#!/usr/bin/env bash
# Claw-owned git worktrees — WezDeck lifecycle (dev/task/hotfix) under claw- prefixes.
# - Same parent: $HOME/work/.worktrees/<repo>/
# - Prefer reusing an existing claw worktree in the same domain (+ compatible lifecycle)
# - Same domain can have multiple trees; new slugs get -2, -3… uniqueness
set -euo pipefail

cmd="${1:-}"
shift || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WEZDECK_REPO="${WEZDECK_REPO:-${WEZTERM_CONFIG_REPO:-${REPO_ROOT}}}"
WT_BIN="${WEZDECK_REPO}/scripts/runtime/worktree/worktree-task"
DEFAULT_REPO="${OPENCLAW_CLAW_DEFAULT_REPO:-${HOME}/work/team-repo}"

usage() {
  cat <<'EOF'
Usage:
  claw-worktree.sh assess  --title SUBJECT [--domain DOMAIN] [--scope HINT]
                           [--days N] [--cwd REPO] [--lifecycle task|dev|hotfix]
      JSON: lifecycle, slug, branch, action=reuse|create, reuse candidates.

  claw-worktree.sh create  --title SUBJECT --lifecycle task|dev|hotfix
                           [--domain DOMAIN] [--cwd REPO] [--slug SLUG]
                           [--base-ref REF] [--prefer-reuse] [--force-new]
      --prefer-reuse (default): if a suitable claw tree exists for domain+lifecycle,
      print its path and exit 0 without creating. --force-new always creates unique slug.

  claw-worktree.sh reclaim --slug SLUG [--cwd REPO] [--force] [--allow-long-lived]
  claw-worktree.sh list    [--cwd REPO]

Lifecycle:
  task     claw-task-*     claw/task/     short     reclaim default
  dev      claw-dev-*      claw/dev/      long      reclaim --allow-long-lived
  hotfix   claw-hotfix-*   claw/hotfix/   urgent    reclaim default

Same domain, multiple tasks:
  - Prefer reuse claw-dev-<domain>-* (long hub) when lifecycle=dev or assess upgrades to dev
  - Prefer reuse exact claw-task-<domain>-<subject> if exists
  - Else create claw-task-<domain>-<subject>[-N] unique among siblings
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
  [[ "${s}" != claw-* ]] || return 1
  [[ "${s}" == dev-* || "${s}" == task-* || "${s}" == hotfix-* ]]
}

is_claw_slug() {
  local s="$1"
  [[ "${s}" == claw-task-* || "${s}" == claw-dev-* || "${s}" == claw-hotfix-* || "${s}" == claw-* ]]
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

worktree_root_for_repo() {
  local cwd="$1"
  local repo_name
  repo_name="$(basename "$(realpath "${cwd}")")"
  printf '%s' "${HOME}/work/.worktrees/${repo_name}"
}

# List claw worktrees as lines: lifecycle|domain|slug|path
# domain may be empty; parsed from slug after lifecycle prefix (first segment if multi)
list_claw_entries() {
  local cwd="$1"
  local wt_root name rest domain lc
  wt_root="$(worktree_root_for_repo "${cwd}")"
  [[ -d "${wt_root}" ]] || return 0
  ls -1 "${wt_root}" 2>/dev/null | while read -r name; do
    [[ -z "${name}" || "${name}" == .* ]] && continue
    [[ -d "${wt_root}/${name}" ]] || continue
    lc=""
    rest=""
    if [[ "${name}" == claw-task-* ]]; then
      lc="task"; rest="${name#claw-task-}"
    elif [[ "${name}" == claw-dev-* ]]; then
      lc="dev"; rest="${name#claw-dev-}"
    elif [[ "${name}" == claw-hotfix-* ]]; then
      lc="hotfix"; rest="${name#claw-hotfix-}"
    elif [[ "${name}" == claw-* ]]; then
      lc="legacy"; rest="${name#claw-}"
    else
      continue
    fi
    domain=""
    # domain = first hyphen segment only when there is more than one segment
    if [[ "${rest}" == *-* ]]; then
      domain="${rest%%-*}"
    fi
    printf '%s|%s|%s|%s\n' "${lc}" "${domain}" "${name}" "${wt_root}/${name}"
  done
}

# Unique slug under worktree root
unique_slug() {
  local cwd="$1" base_slug="$2"
  local wt_root="${HOME}/work/.worktrees/$(basename "$(realpath "${cwd}")")"
  local candidate="${base_slug}" n=2
  while [[ -e "${wt_root}/${candidate}" ]]; do
    candidate="${base_slug}-${n}"
    n=$((n + 1))
    [[ ${n} -lt 100 ]] || die "could not allocate unique slug from ${base_slug}"
  done
  printf '%s' "${candidate}"
}

pick_reuse() {
  # stdin: entries lifecycle|domain|slug|path
  # args: want_lc want_domain want_subject_slug
  # Prefer: 1) exact slug match  2) claw-dev-<domain>-* if want task/dev  3) claw-<lc>-<domain>-*
  local want_lc="$1" want_domain="$2" want_subject="$3"
  local best="" best_rank=99
  local lc domain slug path rank
  while IFS='|' read -r lc domain slug path; do
    [[ -n "${slug}" ]] || continue
    rank=99
    # exact subject under same lifecycle+domain
    if [[ -n "${want_domain}" && "${domain}" == "${want_domain}" ]]; then
      if [[ "${slug}" == "claw-${want_lc}-${want_domain}-${want_subject}" ]]; then
        rank=1
      elif [[ "${slug}" == claw-${want_lc}-${want_domain}-${want_subject}-* ]]; then
        rank=2
      elif [[ "${lc}" == "dev" && "${want_lc}" != "hotfix" ]]; then
        # long-lived domain hub
        rank=3
      elif [[ "${lc}" == "${want_lc}" ]]; then
        rank=4
      fi
    elif [[ -z "${want_domain}" && "${lc}" == "${want_lc}" ]]; then
      if [[ "${slug}" == *"${want_subject}"* ]]; then
        rank=5
      fi
    fi
    # hotfix never reuses non-hotfix
    if [[ "${want_lc}" == "hotfix" && "${lc}" != "hotfix" ]]; then
      continue
    fi
    if [[ "${rank}" -lt "${best_rank}" ]]; then
      best_rank="${rank}"
      best="${lc}|${domain}|${slug}|${path}|${rank}"
    fi
  done
  if [[ -n "${best}" && "${best_rank}" -le 4 ]]; then
    printf '%s' "${best}"
  fi
}

build_subject() {
  local title="$1" domain="$2"
  local subject
  subject="$(slugify "${title}")"
  subject="${subject#claw-task-}"; subject="${subject#claw-dev-}"; subject="${subject#claw-hotfix-}"
  subject="${subject#claw-}"
  subject="$(printf '%s' "${subject}" | sed -E 's/^(hotfix|task|dev)-//')"
  if [[ -n "${domain}" ]]; then
    local ds
    ds="$(slugify "${domain}")"
    subject="${subject#"${ds}-"}"
  fi
  [[ -n "${subject}" ]] || subject="work"
  printf '%s' "${subject}"
}

infer_lifecycle() {
  local title="$1" domain="$2" scope="$3" days="${4:-}" forced="${5:-}"
  if [[ -n "${forced}" ]]; then
    normalize_lifecycle "${forced}"
    return
  fi
  local lc="task"
  if [[ -n "${days}" ]]; then
    if [[ "${days}" -ge 14 ]]; then lc="dev"
    elif [[ "${days}" -le 2 ]]; then lc="task"
    else lc="task"
    fi
  fi
  local blob
  blob="$(printf '%s %s %s' "${title}" "${domain}" "${scope}" | tr '[:upper:]' '[:lower:]')"
  if echo "${blob}" | grep -qE 'hotfix|紧急|线上|prod|production|p0|阻断|回滚'; then
    lc="hotfix"
  elif echo "${blob}" | grep -qE 'epic|平台|platform|长期|workstation|重构大|multi-week|迭代'; then
    [[ "${lc}" != "hotfix" ]] && lc="dev"
  fi
  printf '%s' "${lc}"
}

cmd_assess() {
  local title="" domain="" scope="" days="" cwd="${DEFAULT_REPO}" lifecycle=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title) title="$2"; shift 2 ;;
      --domain) domain="$2"; shift 2 ;;
      --scope) scope="$2"; shift 2 ;;
      --days) days="$2"; shift 2 ;;
      --cwd) cwd="$2"; shift 2 ;;
      --lifecycle|--kind) lifecycle="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown arg: $1" ;;
    esac
  done
  [[ -n "${title}" ]] || die "--title required"
  [[ -d "${cwd}" ]] || die "repo not found: ${cwd}"

  local lc subject domain_slug dir_prefix branch_prefix base_slug unique reasons_json
  lc="$(infer_lifecycle "${title}" "${domain}" "${scope}" "${days}" "${lifecycle}")"
  subject="$(build_subject "${title}" "${domain}")"
  domain_slug=""
  [[ -n "${domain}" ]] && domain_slug="$(slugify "${domain}")"
  dir_prefix="$(lifecycle_dir_prefix "${lc}")"
  branch_prefix="$(lifecycle_branch_prefix "${lc}")"
  if [[ -n "${domain_slug}" ]]; then
    base_slug="${dir_prefix}${domain_slug}-${subject}"
  else
    base_slug="${dir_prefix}${subject}"
  fi
  if [[ ${#base_slug} -gt 80 ]]; then
    base_slug="${base_slug:0:80}"; base_slug="${base_slug%-}"
  fi
  unique="$(unique_slug "${cwd}" "${base_slug}")"

  # Always initialize reuse_* — assess heredoc expands them under set -u even when
  # action=create (no reuse match). Unset vars previously crashed assess.
  local entries reuse="" reuse_lc="" reuse_domain="" reuse_slug="" reuse_path="" reuse_rank=""
  entries="$(list_claw_entries "${cwd}" || true)"
  reuse="$(printf '%s\n' "${entries}" | pick_reuse "${lc}" "${domain_slug}" "${subject}" || true)"

  local action="create" reasons=()
  reasons+=("lifecycle=${lc}")
  if [[ -n "${domain_slug}" ]]; then
    reasons+=("domain=${domain_slug}")
  fi
  if [[ -n "${reuse}" ]]; then
    IFS='|' read -r reuse_lc reuse_domain reuse_slug reuse_path reuse_rank <<<"${reuse}"
    action="reuse"
    reasons+=("prefer existing ${reuse_slug} (rank=${reuse_rank})")
    if [[ "${reuse_lc}" == "dev" && "${lc}" == "task" ]]; then
      reasons+=("same domain long-lived claw-dev hub can host multiple task-sized changes")
    fi
    if [[ "${unique}" != "${base_slug}" ]]; then
      reasons+=("if force-new, unique slug would be ${unique}")
    fi
  else
    reasons+=("no suitable claw worktree to reuse")
    if [[ "${unique}" != "${base_slug}" ]]; then
      reasons+=("slug collision → use ${unique}")
    fi
  fi

  # candidates list for same domain
  local candidates
  candidates="$(printf '%s\n' "${entries}" | python3 -c '
import sys, json
want_d=sys.argv[1]
want_lc=sys.argv[2]
out=[]
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    parts=line.split("|")
    if len(parts)<4: continue
    lc,dom,slug,path=parts[0],parts[1],parts[2],parts[3]
    if want_d and dom!=want_d: continue
    if want_lc=="hotfix" and lc!="hotfix": continue
    out.append({"lifecycle":lc,"domain":dom,"slug":slug,"path":path})
print(json.dumps(out,ensure_ascii=False))
' "${domain_slug}" "${lc}")"

  python3 - <<PY
import json
reasons = $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "${reasons[@]}")
out = {
  "action": "${action}",
  "lifecycle": "${lc}",
  "domain": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "${domain}"),
  "subject": "${subject}",
  "dir_slug": "${unique}" if "${action}" == "create" else "${reuse_slug:-${unique}}",
  "branch": "${branch_prefix}${unique#${dir_prefix}}" if "${action}" == "create" else "",
  "create_slug_if_new": "${unique}",
  "create_branch_if_new": "${branch_prefix}${unique#"${dir_prefix}"}",
  "reuse": None,
  "same_domain_candidates": json.loads('''${candidates}'''),
  "reasons": reasons,
  "reclaim": "needs --allow-long-lived" if "${lc}" == "dev" else "standard after delivery",
  "note": "Confirm with user. Prefer reuse when action=reuse unless they request force-new. Human worktrees never used.",
}
if "${action}" == "reuse":
    out["reuse"] = {
        "lifecycle": "${reuse_lc}",
        "domain": "${reuse_domain}",
        "slug": "${reuse_slug}",
        "path": "${reuse_path}",
        "rank": int("${reuse_rank:-99}"),
    }
    out["dir_slug"] = "${reuse_slug}"
    # branch unknown cheaply; agent can git -C path rev-parse
    out["branch"] = None
    out["path"] = "${reuse_path}"
else:
    out["path"] = None
print(json.dumps(out, ensure_ascii=False, indent=2))
PY
}

cmd_create() {
  local title="" cwd="${DEFAULT_REPO}" slug="" base_ref="" lifecycle="" domain=""
  local prefer_reuse=1 force_new=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --title) title="$2"; shift 2 ;;
      --cwd) cwd="$2"; shift 2 ;;
      --slug) slug="$2"; shift 2 ;;
      --base-ref) base_ref="$2"; shift 2 ;;
      --lifecycle|--kind) lifecycle="$2"; shift 2 ;;
      --domain) domain="$2"; shift 2 ;;
      --prefer-reuse) prefer_reuse=1; shift ;;
      --force-new) force_new=1; prefer_reuse=0; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown arg: $1" ;;
    esac
  done
  [[ -n "${title}" ]] || die "--title required"
  [[ -d "${cwd}" ]] || die "repo not found: ${cwd}"
  require_wt

  if [[ -z "${lifecycle}" && -z "${slug}" ]]; then
    die "pass --lifecycle task|dev|hotfix (or full --slug claw-task-…); run assess first"
  fi

  local subject domain_slug dir_slug branch dir_prefix branch_prefix branch_tail

  if [[ -n "${slug}" ]]; then
    dir_slug="$(slugify "${slug}")"
    if [[ "${dir_slug}" == claw-dev-* ]]; then lifecycle="dev"
    elif [[ "${dir_slug}" == claw-hotfix-* ]]; then lifecycle="hotfix"
    elif [[ "${dir_slug}" == claw-task-* ]]; then lifecycle="task"
    else
      lifecycle="$(normalize_lifecycle "${lifecycle:-task}")"
      dir_prefix="$(lifecycle_dir_prefix "${lifecycle}")"
      dir_slug="${dir_slug#claw-}"
      dir_slug="${dir_prefix}${dir_slug}"
    fi
  else
    lifecycle="$(normalize_lifecycle "${lifecycle}")"
    subject="$(build_subject "${title}" "${domain}")"
    domain_slug=""
    [[ -n "${domain}" ]] && domain_slug="$(slugify "${domain}")"
    dir_prefix="$(lifecycle_dir_prefix "${lifecycle}")"
    if [[ -n "${domain_slug}" ]]; then
      dir_slug="${dir_prefix}${domain_slug}-${subject}"
    else
      dir_slug="${dir_prefix}${subject}"
    fi
  fi

  lifecycle="$(normalize_lifecycle "${lifecycle}")"
  is_human_slug "${dir_slug}" && die "slug collides with human prefix: ${dir_slug}"

  # Prefer reuse unless force-new or explicit unique slug request
  if [[ "${force_new}" -eq 0 && "${prefer_reuse}" -eq 1 ]]; then
    subject="$(build_subject "${title}" "${domain}")"
    domain_slug=""
    [[ -n "${domain}" ]] && domain_slug="$(slugify "${domain}")"
    local entries reuse
    entries="$(list_claw_entries "${cwd}" || true)"
    reuse="$(printf '%s\n' "${entries}" | pick_reuse "${lifecycle}" "${domain_slug}" "${subject}" || true)"
    if [[ -n "${reuse}" ]]; then
      local r_lc r_dom r_slug r_path r_rank
      IFS='|' read -r r_lc r_dom r_slug r_path r_rank <<<"${reuse}"
      echo "reuse existing worktree slug=${r_slug} (rank=${r_rank}); pass --force-new to create another" >&2
      printf '%s\n' "${r_path}"
      exit 0
    fi
  fi

  # ensure unique if collision
  dir_slug="$(unique_slug "${cwd}" "${dir_slug}")"

  dir_prefix="$(lifecycle_dir_prefix "${lifecycle}")"
  branch_prefix="$(lifecycle_branch_prefix "${lifecycle}")"
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
    launch --cwd "${cwd}" --title "${title}"
    --task-slug "${dir_slug}" --branch "${branch}"
    --provider none --provider-mode off --no-attach
  )
  [[ -n "${base_ref}" ]] && args+=(--base-ref "${base_ref}")

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
  if [[ -n "${slug}" ]]; then name="${slug}"
  else name="$(basename "${root%/}")"
  fi

  is_human_slug "${name}" && die "refusing human WezDeck worktree '${name}'"
  is_claw_slug "${name}" || die "reclaim only claw-* worktrees (got '${name}')"
  if [[ "${name}" == claw-dev-* && "${long}" -ne 1 ]]; then
    die "claw-dev-* is long-lived; pass --allow-long-lived after delivery checks"
  fi

  local args=(reclaim --cwd "${cwd}" --provider none --provider-mode off)
  if [[ -n "${slug}" ]]; then args+=(--task-slug "${slug}")
  else args+=(--worktree-root "${root}")
  fi
  [[ "${force}" -eq 1 ]] && args+=(--force)
  [[ "${long}" -eq 1 ]] && args+=(--allow-long-lived)

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
  local wt_root name
  wt_root="$(worktree_root_for_repo "${cwd}")"
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
