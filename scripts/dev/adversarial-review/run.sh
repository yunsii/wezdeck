#!/usr/bin/env bash
# Usage:
#   run.sh <BASE_REF> [options]
#   run.sh selfcheck [claude|codex|grok ...]
#   run.sh dogfood [--mode MODE] [options]   # review this tool's own uncommitted+HEAD diff
#
# Cross-agent adversarial review over BASE_REF..HEAD, in three gates:
#   1 Find        <reviewer> finds defects (guilty-until-proven)
#   2 Refute      <refuter> tries to refute each finding
#   3 Empirical   <reviewer> writes a minimal repro; orchestrator RUNS it in a sandbox
#
# Modes:
#   strict    (default) survivors = CONFIRMED && reproduced==true only
#   advisory  also surface PLAUSIBLE / needs_human (never claim "all three gates")
#
# TOOL vs TARGET:
#   TOOL_HOME  = this script's directory (prompts, provider, select-backends)
#   TARGET     = git repo under review (--repo PATH, or cwd git toplevel)
#   dogfood forces TARGET = the git root that hosts this tool (usually wezdeck)
#
# Context pack v1 (find/refute share one pack):
#   META + INTENT + CHANGESET + DIFF + FILES + PROJECT_SLICE
#   --head WORKTREE includes uncommitted TARGET changes
#   --intent / --intent-file supply change intent
#   PROJECT_SLICE = downstream refs to changed symbols (blast radius); grep floor,
#                   language-aware resolvers pluggable. --no-impact to skip.
#   --pack-only              build pack + emit impact candidates; skip gates
#   --project-slice-file F   main-agent filtered keep list for PROJECT_SLICE
#   --keep-pack DIR          retain pack.md + impact_candidates.json for audit
#
# Main-agent impact filter (optional two-phase):
#   1) run.sh BASE --pack-only --keep-pack DIR --json
#   2) main agent writes DIR/project_slice.keep.json (conservative keep)
#   3) run.sh BASE --project-slice-file DIR/project_slice.keep.json …
#   Single-shot without filter still works (full same-name candidates in pack).
#
# All logic is agent-agnostic; the only agent-specific code is in
# lib/provider.sh. See docs/adversarial-review.md and SKILL.md.
#
# Exit codes:
#   0 done (no strict survivors, or advisory without --fail-on-finding)
#   1 usage
#   2 provider unusable
#   3 internal
#  10 --fail-on-finding and at least one strict survivor

set -euo pipefail

# TOOL_HOME: skill/runner unit (not the repo under review)
tool_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lib_dir="$tool_root"
# Git root that *hosts* the tool sources (for dogfood + relative tool_paths)
tool_host_root="$(cd "$tool_root/../../.." && pwd)"
# repo_root = TARGET under review (set after args; default cwd git toplevel)
repo_root=""
target_repo_arg=""
prompts="$lib_dir/prompts"
schema="$lib_dir/lib/findings-schema.json"
# shellcheck source=/dev/null
. "$lib_dir/lib/provider.sh"
# shellcheck source=/dev/null
. "$lib_dir/lib/rubric-lib.sh"

log() { printf '\033[2m[adv-review]\033[0m %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit "${2:-1}"; }

sev_rank() { case "$1" in critical) echo 4;; high) echo 3;; medium) echo 2;; *) echo 1;; esac; }

jarr_append() { printf '%s' "$1" | jq -c --argjson x "$2" '. + [$x]'; }

# Validate an array of findings against the minimal schema contract.
# Drops invalid elements; echoes filtered array. Exit 0 always if input is array.
_validate_findings() {
  local raw="$1"
  # schema file is documentation + contract; enforce the required fields here
  # without jq --argfile / IN (broader portability).
  printf '%s' "$raw" | jq -c '
    def ok:
      (type=="object")
      and (.file|type=="string")
      and (.line|type=="number")
      and (.summary|type=="string")
      and ((.failure_scenario|type=="string") and ((.failure_scenario|length)>0))
      and ((.severity=="critical") or (.severity=="high") or (.severity=="medium") or (.severity=="low"))
      and ((.verdict=="CONFIRMED") or (.verdict=="PLAUSIBLE"));
    if type != "array" then empty else [ .[] | select(ok) ] end
  ' 2>/dev/null || printf '%s' '[]'
}

# Extract related unified-diff hunks for a finding's file (best-effort).
_diff_for_file() {
  local full_diff="$1" file="$2"
  printf '%s\n' "$full_diff" | awk -v f="$file" '
    BEGIN { show=0 }
    /^\+\+\+ b\// {
      path=$0; sub(/^\+\+\+ b\//,"",path)
      show = (path==f)
    }
    show { print }
  '
}

# Globals set before gate 3: base, head_ref, changed (newline-separated paths)
# Sandbox must mirror the *reviewed* tree, not whatever HEAD the agent cwd is on.
_SANDBOX_PATH=""
_sandbox_cleanup() {
  local p="${_SANDBOX_PATH:-}"
  [ -z "$p" ] && return 0
  _SANDBOX_PATH=""
  # best-effort: registered worktree first, then raw dir
  git -C "$repo_root" worktree remove --force "$p" >/dev/null 2>&1 || true
  rm -rf "$p" >/dev/null 2>&1 || true
}
trap '_sandbox_cleanup' EXIT INT TERM HUP

# Materialize reviewed tree into $1 (absolute sandbox path).
# - head_ref is a real commit-ish → detached worktree at that rev
# - head_ref=WORKTREE (dogfood) → worktree at base (usually HEAD) + apply WT changes
_sandbox_materialize() {
  local sand="$1"
  local rev files f dir
  if [ "$head_ref" = "WORKTREE" ]; then
    rev="$(git -C "$repo_root" rev-parse "$base^{commit}")"
  else
    rev="$(git -C "$repo_root" rev-parse "$head_ref^{commit}")"
  fi
  if ! git -C "$repo_root" worktree add --detach "$sand" "$rev" >/dev/null 2>&1; then
    return 1
  fi
  _SANDBOX_PATH="$sand"

  if [ "$head_ref" = "WORKTREE" ]; then
    # Copy live worktree bytes for reviewed paths so dogfood sees uncommitted edits.
    if [ -n "${changed:-}" ]; then
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        if [ -f "$repo_root/$f" ]; then
          dir="$(dirname "$sand/$f")"
          mkdir -p "$dir"
          # tracked or untracked: copy bytes from the live worktree
          cp -a "$repo_root/$f" "$sand/$f"
        elif [ -e "$repo_root/$f" ]; then
          dir="$(dirname "$sand/$f")"
          mkdir -p "$dir"
          cp -a "$repo_root/$f" "$sand/$f"
        else
          # deleted in worktree relative to base
          rm -rf "$sand/$f"
        fi
      done <<< "$changed"
    fi
  fi
  return 0
}

# Danger patterns: deny auto-exec (still not a full OS sandbox).
_repro_is_dangerous() {
  local script="$1"
  printf '%s' "$script" | grep -Eqi \
    'rm[[:space:]]+-[a-zA-Z]*f[a-zA-Z]*[[:space:]]+/|rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*f|:\(\)\{|fork[[:space:]]*\(|\$\(curl|`curl|(^|[^a-zA-Z_-])(curl|wget|sudo|mkfs|shutdown|reboot|dd|nc|ncat|python[[:space:]]+-c|python3[[:space:]]+-c|node[[:space:]]+-e|perl[[:space:]]+-e|ruby[[:space:]]+-e|chmod[[:space:]]+[0-7]*[67]|chown|ssh-keygen|scp|rsync)([^a-zA-Z_-]|$)|git[[:space:]]+push|npm[[:space:]]+publish|pip[[:space:]]+install|/etc/passwd|\.ssh/|/dev/sd|mkfifo|nohup|/proc/|/sys/' \
    && return 0
  return 1
}

# Run repro script in a sandbox that matches the *reviewed* tree.
# returns: 0 reproduced · 1 did-not-reproduce · 2 inconclusive · 3 dangerous
_repro_verdict() {
  local raw="$1"
  local script rc sand
  script="$(printf '%s\n' "$raw" | awk '/^```bash/{f=1;next} /^```/{if(f){f=0}} f')"
  [ -z "$script" ] && return 2
  if _repro_is_dangerous "$script"; then
    return 3
  fi

  sand="$(mktemp -d "${TMPDIR:-/tmp}/adv-review-sand.XXXXXX")"
  if ! _sandbox_materialize "$sand"; then
    rm -rf "$sand"
    return 2
  fi
  printf '%s\n' "$script" > "$sand/.adv-repro.sh"
  # drop write to .git inside sandbox (best-effort hardening)
  chmod -R a-w "$sand/.git" 2>/dev/null || true
  set +e
  ( cd "$sand" && timeout 60 bash .adv-repro.sh >/dev/null 2>&1 )
  rc=$?
  set -e
  _sandbox_cleanup

  case "$rc" in
    0)   return 1 ;;   # exit 0  -> behaved correctly, NOT reproduced
    99)  return 1 ;;   # agent could not build a repro
    124) return 2 ;;   # timeout
    *)   return 0 ;;   # non-zero -> defect reproduced
  esac
}

# Emit report. Globals: want_json, base, head_ref, reviewer, refuter, mode, skipped_gates,
# writer, select_form, select_degraded, select_reason, auto_selected
_emit() {
  local survivors="$1" needs_human="$2" dropped="$3"
  local skipped_json
  skipped_json="$(printf '%s\n' "${skipped_gates[@]:-}" | jq -R . | jq -sc 'map(select(length>0))')"
  if [ "$want_json" -eq 1 ]; then
    jq -nc --argjson survivors "$survivors" --argjson needs_human "$needs_human" \
       --argjson dropped "$dropped" --argjson skipped "$skipped_json" \
       --arg base "$base" --arg head "$head_ref" \
       --arg reviewer "$reviewer" --arg refuter "$refuter" --arg mode "$mode" \
       --arg reviewer_model "$(provider_model "$reviewer")" \
       --arg refuter_model "$(provider_model "$refuter")" \
       --arg writer "${writer:-}" --arg form "${select_form:-manual}" \
       --argjson degraded "${select_degraded:-false}" --arg reason "${select_reason:-}" \
       --argjson auto "${auto_selected:-false}" \
       --arg pack_id "${PACK_ID:-}" --arg pack_hash "${PACK_HASH:-}" \
       --arg context "pack-v1" --arg pack_file "${PACK_FILE:-}" \
       --arg impact_filter "${PACK_IMPACT_FILTER:-none}" \
       --argjson impact_n "${PACK_IMPACT_N:-0}" \
       --argjson impact_candidates_n "${PACK_IMPACT_CANDIDATES_N:-0}" \
       --argjson impact_dropped_n "${PACK_IMPACT_DROPPED_N:-0}" \
       '{mode:$mode, base:$base, head:$head, writer:$writer, reviewer:$reviewer, refuter:$refuter,
         reviewer_model:$reviewer_model, refuter_model:$refuter_model,
         form:$form, degraded:$degraded, select_reason:$reason, auto_selected:$auto,
         context:$context, pack_id:$pack_id, pack_hash:$pack_hash, pack_file:$pack_file,
         impact_filter:$impact_filter, impact_n:$impact_n,
         impact_candidates_n:$impact_candidates_n, impact_dropped_n:$impact_dropped_n,
         skipped_gates:$skipped, survivors:$survivors, needs_human:$needs_human, dropped:$dropped}'
    return
  fi
  local ns nh nd
  ns="$(printf '%s' "$survivors" | jq 'length')"
  nh="$(printf '%s' "$needs_human" | jq 'length')"
  nd="$(printf '%s' "$dropped" | jq 'length')"
  echo
  echo "═══ Adversarial review [$mode]: $base..$head_ref  ($reviewer vs $refuter) ═══"
  echo "## 对抗审查披露"
  echo "- writer: ${writer:-unspecified}"
  echo "- form: ${select_form:-manual}"
  echo "- reviewer: $reviewer (model: $(provider_model "$reviewer"))"
  echo "- refuter: $refuter (model: $(provider_model "$refuter"))"
  echo "- auto_selected: ${auto_selected:-false}"
  echo "- degraded: ${select_degraded:-false}"
  echo "- reason: ${select_reason:-}"
  echo "- context: pack-v1"
  echo "- pack_id: ${PACK_ID:-n/a}"
  echo "- pack_hash: ${PACK_HASH:-n/a}"
  echo "- impact_filter: ${PACK_IMPACT_FILTER:-none} (kept ${PACK_IMPACT_N:-0} / candidates ${PACK_IMPACT_CANDIDATES_N:-0}; dropped ${PACK_IMPACT_DROPPED_N:-0})"
  if [ "$(printf '%s' "$skipped_json" | jq 'length')" -gt 0 ]; then
    echo "- skipped_gates: $(printf '%s' "$skipped_json" | jq -r 'join(", ")')"
    echo "  (may be SINGLE-MODEL — not full cross-agent)"
  else
    echo "- skipped_gates: 无"
  fi
  echo
  echo "── 阻塞 · survivors (strict blockers = CONFIRMED + reproduced) [$ns] ──"
  if [ "$ns" -eq 0 ]; then
    echo "(none)"
  else
    printf '%s' "$survivors" | jq -r '.[] |
      "• [\(.severity)] \(.file):\(.line) — \(.summary)\n    scenario: \(.failure_scenario)\n    repro: \(.repro.note // "n/a")"'
  fi
  if [ "$mode" = "advisory" ] || [ "$nh" -gt 0 ]; then
    echo
    echo "── 非阻塞·backlog · needs_human / plausible [$nh] ──"
    if [ "$nh" -eq 0 ]; then
      echo "(none)"
    else
      printf '%s' "$needs_human" | jq -r '.[] |
        "• [\(.severity)] \(.file):\(.line) — \(.summary)\n    note: \(.repro.note // .verdict // "n/a")"'
    fi
  fi
  [ "$nd" -gt 0 ] && echo && echo "($nd 条非阻塞 finding 已 drop — 详见 --json)"
}

# --- selfcheck / dogfood passthrough ----------------------------------------
if [ "${1:-}" = "selfcheck" ]; then shift; _selfcheck "$@"; exit $?; fi

dogfood=0
if [ "${1:-}" = "dogfood" ]; then
  dogfood=1
  shift
fi

# --- args --------------------------------------------------------------------
base=""; head_ref="HEAD"; reviewer=""; refuter=""
writer="human"; auto_select=0
min_sev="low"; want_json=0; dry=0; mode="strict"; fail_on=0
auto_selected=false; select_form="manual"; select_degraded=false; select_reason=""
skipped_gates=()
intent_text=""; intent_file=""; keep_pack_dir=""
max_files=10; max_file_bytes=40960; context_window=200
impact_enable=1
project_slice_file=""
pack_only=0
path_filter=()
PACK_ID=""; PACK_HASH=""; PACK_FILE=""; PACK_DIR=""
PACK_IMPACT_FILTER="none"; PACK_IMPACT_N=0; PACK_IMPACT_CANDIDATES_N=0; PACK_IMPACT_DROPPED_N=0
while [ $# -gt 0 ]; do
  case "$1" in
    --reviewer) reviewer="$2"; shift 2 ;;
    --refuter|--critic) refuter="$2"; shift 2 ;;
    --writer) writer="$2"; auto_select=1; shift 2 ;;
    --auto-select) auto_select=1; shift ;;
    --no-probe) ADV_REVIEW_PROBE=0; shift ;;
    --repo) target_repo_arg="$2"; shift 2 ;;
    --head) head_ref="$2"; shift 2 ;;
    --intent) intent_text="$2"; shift 2 ;;
    --intent-file) intent_file="$2"; shift 2 ;;
    --max-files) max_files="$2"; shift 2 ;;
    --max-file-bytes) max_file_bytes="$2"; shift 2 ;;
    --context-window) context_window="$2"; shift 2 ;;
    --no-impact) impact_enable=0; shift ;;
    --project-slice-file) project_slice_file="$2"; shift 2 ;;
    --pack-only) pack_only=1; shift ;;
    --keep-pack) keep_pack_dir="$2"; shift 2 ;;
    --min-severity) min_sev="$2"; shift 2 ;;
    --mode) mode="$2"; shift 2 ;;
    --json) want_json=1; shift ;;
    --dry-run) dry=1; shift ;;
    --fail-on-finding) fail_on=1; shift ;;
    -h|--help)
      sed -n '2,60p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "unknown flag: $1" ;;
    *) [ -z "$base" ] && base="$1" || die "unexpected arg: $1"; shift ;;
  esac
done

case "$mode" in strict|advisory) ;; *) die "mode must be strict|advisory" ;; esac

# Resolve TARGET (repo under review). dogfood always uses the tool host repo.
if [ "$dogfood" -eq 1 ]; then
  repo_root="$tool_host_root"
elif [ -n "$target_repo_arg" ]; then
  [ -d "$target_repo_arg" ] || die "--repo not a directory: $target_repo_arg"
  repo_root="$(cd "$target_repo_arg" && pwd)"
  if git -C "$repo_root" rev-parse --show-toplevel >/dev/null 2>&1; then
    repo_root="$(git -C "$repo_root" rev-parse --show-toplevel)"
  fi
else
  if git rev-parse --show-toplevel >/dev/null 2>&1; then
    repo_root="$(git rev-parse --show-toplevel)"
  else
    die "not inside a git repo; pass --repo <path> or cd into TARGET"
  fi
fi

# Backend selection: --writer / --auto-select, or default pair when reviewer/refuter omitted.
# pack-only skips selection/probes — no gates run.
# shellcheck source=/dev/null
. "$lib_dir/lib/select-backends.sh"
if [ "$pack_only" -eq 1 ]; then
  reviewer="${reviewer:-none}"
  refuter="${refuter:-none}"
  select_form="pack-only"
  select_reason="pack-only: backend selection skipped"
elif [ "$auto_select" -eq 1 ] || [ -z "$reviewer" ] || [ -z "$refuter" ]; then
  if select_review_backends "$writer"; then
    if [ -z "$reviewer" ]; then reviewer="$SEL_REVIEWER"; auto_selected=true; fi
    if [ -z "$refuter" ]; then refuter="$SEL_REFUTER"; auto_selected=true; fi
    select_form="${SEL_FORM:-manual}"
    select_degraded="${SEL_DEGRADED:-false}"
    select_reason="${SEL_REASON:-}"
    log "backend select: writer=$writer → $reviewer vs $refuter (form=$select_form degraded=$select_degraded)"
    log "  reason: $select_reason"
  else
    die "no review backends available for writer=$writer" 2
  fi
fi
# manual defaults if still empty
if [ "$pack_only" -ne 1 ]; then
  [ -n "$reviewer" ] || reviewer="claude"
  [ -n "$refuter" ] || refuter="codex"
fi

log "tool=$tool_root"
log "target=$repo_root"
cd "$repo_root"

if [ "$dogfood" -eq 1 ]; then
  # dogfood = WORKTREE + tool path filter
  base="HEAD"
  head_ref="WORKTREE"
  path_filter=(
    "scripts/dev/adversarial-review"
    "docs/adversarial-review.md"
    "openclaw/scripts/claw-worktree.sh"
  )
  if [ -z "$intent_text" ] && [ -z "$intent_file" ]; then
    intent_text="dogfood: adversarial-review toolkit self-review (uncommitted + HEAD vs tool paths)"
  fi
  log "dogfood: WORKTREE review of tool paths against HEAD"
fi

[ -n "$base" ] || die "missing BASE_REF (try: run.sh HEAD~1  or  run.sh dogfood)"

if [ "$head_ref" != "WORKTREE" ]; then
  git rev-parse --verify -q "$base" >/dev/null || die "bad ref: $base"
  git rev-parse --verify -q "$head_ref" >/dev/null || die "bad ref: $head_ref"
else
  git rev-parse --verify -q "$base" >/dev/null || die "bad ref: $base"
fi
min_rank="$(sev_rank "$min_sev")"

# --- stage 0: build context pack ---------------------------------------------
# shellcheck source=/dev/null
. "$lib_dir/lib/context-pack.sh"
build_context_pack
changed="$PACK_CHANGED"
diff="$PACK_DIFF"

_emit_pack_only() {
  local skip_reason="${1:-}"
  if [ "$want_json" -eq 1 ]; then
    jq -nc \
      --arg mode "pack-only" \
      --arg base "$base" --arg head "$head_ref" \
      --arg writer "${writer:-}" \
      --arg pack_id "${PACK_ID:-}" --arg pack_hash "${PACK_HASH:-}" \
      --arg pack_file "${PACK_FILE:-}" --arg pack_dir "${PACK_DIR:-}" \
      --arg candidates_file "${PACK_IMPACT_CANDIDATES_FILE:-}" \
      --arg impact_filter "${PACK_IMPACT_FILTER:-none}" \
      --arg skip_reason "$skip_reason" \
      --argjson has_runtime "${PACK_HAS_RUNTIME:-0}" \
      --argjson impact_n "${PACK_IMPACT_N:-0}" \
      --argjson impact_candidates_n "${PACK_IMPACT_CANDIDATES_N:-0}" \
      --argjson impact_dropped_n "${PACK_IMPACT_DROPPED_N:-0}" \
      --argjson impact_candidates "${PACK_IMPACT_CANDIDATES_JSON:-[]}" \
      --argjson project_slice "${PACK_IMPACT_JSON:-[]}" \
      --argjson changed "$(printf '%s\n' "${PACK_CHANGED:-}" | jq -R . | jq -sc 'map(select(length>0))')" \
      '{mode:$mode, base:$base, head:$head, writer:$writer,
        pack_id:$pack_id, pack_hash:$pack_hash, pack_file:$pack_file, pack_dir:$pack_dir,
        has_runtime:$has_runtime, skip_reason:$skip_reason,
        impact_filter:$impact_filter, impact_n:$impact_n,
        impact_candidates_n:$impact_candidates_n, impact_dropped_n:$impact_dropped_n,
        impact_candidates_file:$candidates_file,
        impact_candidates:$impact_candidates, project_slice:$project_slice,
        changed:$changed,
        next_steps:(
          if ($skip_reason|length)>0 then
            ["skipped: "+$skip_reason]
          elif $impact_candidates_n==0 then
            ["no impact candidates — run full review without --project-slice-file"]
          else
            ["write keep list to pack_dir/project_slice.keep.json (array or {keep,dropped,filter,notes})",
             "re-run without --pack-only with --project-slice-file <keep.json>",
             "when unsure whether a hit is a real consumer: KEEP it"]
          end
        )}'
  else
    echo "═══ pack-only: $base..$head_ref ═══"
    echo "pack_dir:  ${PACK_DIR:-n/a}"
    echo "pack_file: ${PACK_FILE:-n/a}"
    echo "pack_id:   ${PACK_ID:-n/a}"
    echo "runtime:   ${PACK_HAS_RUNTIME:-0}"
    [ -n "$skip_reason" ] && echo "skip:      $skip_reason"
    echo "impact:    candidates=${PACK_IMPACT_CANDIDATES_N:-0} slice=${PACK_IMPACT_N:-0} filter=${PACK_IMPACT_FILTER:-none}"
    [ -n "${PACK_IMPACT_CANDIDATES_FILE:-}" ] && echo "candidates_file: $PACK_IMPACT_CANDIDATES_FILE"
    if [ "${PACK_IMPACT_CANDIDATES_N:-0}" -gt 0 ]; then
      echo
      echo "── impact candidates (grep floor / same-name) ──"
      printf '%s' "${PACK_IMPACT_CANDIDATES_JSON:-[]}" | jq -r '
        .[:40][] | "- \(.file):\(.line) \(.symbol) [\(.confidence)/\(.resolver)]"'
      [ "${PACK_IMPACT_CANDIDATES_N:-0}" -gt 40 ] && echo "- … (${PACK_IMPACT_CANDIDATES_N} total)"
      echo
      echo "Main-agent filter: write keep list, then re-run gates with:"
      echo "  --project-slice-file ${PACK_DIR}/project_slice.keep.json"
      echo "When unsure, KEEP. Do not drop to make the change look safer."
    fi
  fi
}

[ -n "$changed" ] || {
  log "no changes in range"
  if [ "$pack_only" -eq 1 ]; then _emit_pack_only "no changes in range"; fi
  exit 0
}

if [ "${PACK_HAS_RUNTIME:-0}" -eq 0 ]; then
  log "skip: diff is docs/tests only — no runtime behavior to review adversarially"
  if [ "$pack_only" -eq 1 ]; then _emit_pack_only "docs/tests only"; fi
  exit 0
fi

log "range $base..$head_ref  mode=$mode  writer=$writer  reviewer=$reviewer  refuter=$refuter"
log "context=pack-v1 pack_id=$PACK_ID hash=${PACK_HASH:0:12}…"
if [ "$impact_enable" -eq 1 ] || [ -n "${project_slice_file:-}" ]; then
  log "impact: slice=${PACK_IMPACT_N:-0} candidates=${PACK_IMPACT_CANDIDATES_N:-0} filter=${PACK_IMPACT_FILTER:-none}"
else
  log "impact: disabled (--no-impact)"
fi

if [ "$pack_only" -eq 1 ]; then
  log "pack-only — gates skipped; impact candidates ready for main-agent filter"
  _emit_pack_only ""
  exit 0
fi

if [ "$dry" -eq 1 ]; then
  log "dry-run — planned gates:"
  log "  writer        -> $writer (form=$select_form degraded=$select_degraded)"
  log "  reason        -> $select_reason"
  log "  context       -> pack-v1 ($PACK_FILE)"
  log "  pack_hash     -> $PACK_HASH"
  log "  project_slice -> slice=${PACK_IMPACT_N:-0} candidates=${PACK_IMPACT_CANDIDATES_N:-0} filter=${PACK_IMPACT_FILTER:-none}"
  log "  stage1 find   -> $reviewer  (INPUT=context pack)"
  log "  stage2 refute -> $refuter $(provider_available "$refuter" && echo '(available)' || echo '(UNAVAILABLE)') (same pack + findings)"
  log "  stage3 repro  -> $reviewer + sandbox worktree"
  exit 0
fi

provider_available "$reviewer" || die "reviewer '$reviewer' unavailable" 2

# Shared pack body for find + refute (same bytes)
pack_body="$(cat "$PACK_FILE")"
# The critic also gets the authoritative review rubric (find only; the refuter
# judges findings, not dimensions).
critic_in="$pack_body"$'\n\n=== RUBRIC ===\n'"$(rubric_text)"

# --- stage 1: find -----------------------------------------------------------
log "stage 1/3 · find ($reviewer)…"
f1="$(printf '%s' "$critic_in" | run_agent "$reviewer" "$prompts/critic.md" high)" \
  || die "stage1: $reviewer produced no valid JSON" 3
f1="$(_validate_findings "$f1")"
f1="$(printf '%s' "$f1" | jq -c '
  [ .[]
    | .id = (.id // ((.file//"")+":"+((.line//0)|tostring)+":"+(.summary//"")))
    | .refuted = (.refuted // false)
  ]')"
n1="$(printf '%s' "$f1" | jq 'length')"
log "  → $n1 schema-valid finding(s) with failure_scenario"
if [ "$n1" -eq 0 ]; then
  _emit '[]' '[]' '[]'
  exit 0
fi

# --- stage 2: refute ---------------------------------------------------------
# Multi-role is mandatory for 对抗审查: always attempt refute when provider is
# available. Same backend/family still runs gate2 (opposite prompt), but results
# are SINGLE-MODEL — never claim cross-agent.
survivors="$f1"
if provider_same_family "$reviewer" "$refuter" || [ "$(_provider_canonical "$reviewer")" = "$(_provider_canonical "$refuter")" ]; then
  log "stage 2/3 · refute ($refuter) as SECOND ROLE (same capability as reviewer → SINGLE-MODEL)"
  skipped_gates+=("cross-model(single-model-multi-role)")
elif ! provider_available "$refuter"; then
  log "stage 2/3 · SKIP — refuter '$refuter' unavailable; cannot complete multi-role 对抗审查"
  skipped_gates+=("refute-unavailable($refuter)")
  # Without refute, do not pretend adversarial completeness
  survivors="$f1"
else
  log "stage 2/3 · refute ($refuter)…"
fi

if provider_available "$refuter" && [[ " ${skipped_gates[*]} " != *"refute-unavailable"* ]]; then
  refute_in="$pack_body"$'\n\n=== FINDINGS ===\n'"$f1"
  if f2_raw="$(printf '%s' "$refute_in" | run_agent "$refuter" "$prompts/refute.md" high)"; then
    f2="$(_validate_findings "$f2_raw")"
    survivors="$(jq -nc --argjson s1 "$f1" --argjson s2 "$f2" '
      ($s2 | map({key:(.id // (.file+":"+(.line|tostring)+":"+.summary)), value:.}) | from_entries) as $m
      | [ $s1[]
          | . as $o
          | ($m[$o.id] // null) as $n
          | if $n == null then . else
              .refuted = ($n.refuted // false)
              | .refute_reason = ($n.refute_reason // null)
            end
          | select((.refuted // false) == false)
        ]')"
    log "  → $(printf '%s' "$survivors" | jq 'length')/$n1 survived refutation"
  else
    log "  ! refuter returned no valid JSON — keeping stage1 findings, gate marked skipped"
    skipped_gates+=("refute-bad-json")
  fi
fi

# --- stage 3: empirical reproduction -----------------------------------------
log "stage 3/3 · empirical reproduction (sandbox worktree)…"
final='[]'; needs_human='[]'; dropped='[]'
ns="$(printf '%s' "$survivors" | jq 'length')"
if [ "$ns" -gt 0 ]; then
  for i in $(seq 0 $((ns - 1))); do
    f="$(printf '%s' "$survivors" | jq -c ".[$i]")"
    verdict="$(printf '%s' "$f" | jq -r '.verdict // "PLAUSIBLE"')"
    file="$(printf '%s' "$f" | jq -r '.file // ""')"
    hunk="$(_diff_for_file "$diff" "$file")"

    if [ "$verdict" != "CONFIRMED" ]; then
      fj="$(printf '%s' "$f" | jq -c '.repro={ran:false,reproduced:null,note:"PLAUSIBLE — not repro-gated"}')"
      if [ "$mode" = "advisory" ]; then
        needs_human="$(jarr_append "$needs_human" "$fj")"
      else
        dropped="$(jarr_append "$dropped" "$fj")"
      fi
      continue
    fi

    # Only repro-gate dimensions the rubric marks repro_gated=yes. A design
    # dimension (no) OR a category not in the rubric (empty) is NOT a strict
    # blocker — surface it as needs_human. This enforces "the rubric is the sole
    # criteria": an off-rubric category can't be promoted via a failing repro.
    gated="$(rubric_repro_gated "$(printf '%s' "$f" | jq -r '.category // ""')")"
    if [ "$gated" != "yes" ]; then
      note=$([ "$gated" = "no" ] && echo "design/advisory dimension — not repro-gated" || echo "category not in rubric — needs human")
      fj="$(printf '%s' "$f" | jq -c --arg n "$note" '.repro={ran:false,reproduced:null,note:$n}')"
      needs_human="$(jarr_append "$needs_human" "$fj")"
      log "  ~ non-repro-gated ($(printf '%s' "$f" | jq -r '.category // "?"')): $(printf '%s' "$f" | jq -r '.summary')"
      continue
    fi

    repro_in="$(jq -nc --argjson finding "$f" --arg hunk "$hunk" \
      '{finding:$finding, related_diff:$hunk}')"
    script_raw="$(printf '%s' "$repro_in" | agent_text "$reviewer" "$prompts/repro.md" low || true)"
    set +e
    _repro_verdict "$script_raw"
    rc=$?
    set -e
    case "$rc" in
      0) note="reproduced"; bucket=survivor; repd=true ;;
      1) note="did not reproduce (behaved correctly)"; bucket=dropped; repd=false ;;
      2) note="inconclusive (timeout/no script) — needs human"; bucket=human; repd=null ;;
      3) note="repro script flagged dangerous — needs human"; bucket=human; repd=null ;;
    esac
    fj="$(printf '%s' "$f" | jq -c --arg n "$note" --argjson r "$repd" \
      '.repro={ran:true,reproduced:$r,note:$n}')"
    case "$bucket" in
      survivor)
        final="$(jarr_append "$final" "$fj")"
        log "  • $(printf '%s' "$f" | jq -r '.file'):$(printf '%s' "$f" | jq -r '.line') — $note"
        ;;
      human)
        needs_human="$(jarr_append "$needs_human" "$fj")"
        log "  ? needs human: $(printf '%s' "$f" | jq -r '.summary') — $note"
        ;;
      dropped)
        dropped="$(jarr_append "$dropped" "$fj")"
        log "  ✗ dropped: $(printf '%s' "$f" | jq -r '.summary') — $note"
        ;;
    esac
  done
fi

# severity filter on survivors + needs_human
filter_sev() {
  printf '%s' "$1" | jq -c --argjson m "$min_rank" '
    def rank: {critical:4,high:3,medium:2,low:1}[.severity // "low"] // 1;
    [ .[] | select(rank >= $m) ] | sort_by(-(rank))'
}
final="$(filter_sev "$final")"
needs_human="$(filter_sev "$needs_human")"

_emit "$final" "$needs_human" "$dropped"

if [ "$fail_on" -eq 1 ]; then
  n_final="$(printf '%s' "$final" | jq 'length')"
  if [ "$n_final" -gt 0 ]; then
    exit 10
  fi
fi
exit 0
