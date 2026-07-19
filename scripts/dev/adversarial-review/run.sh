#!/usr/bin/env bash
# Usage:
#   run.sh <BASE_REF> [options]
#   run.sh selfcheck [claude|codex|codex-gpt|codex-grok ...]
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
# All logic is agent-agnostic; the only agent-specific code is in
# lib/provider.sh. See docs/adversarial-review.md.
#
# Exit codes:
#   0 done (no strict survivors, or advisory without --fail-on-finding)
#   1 usage
#   2 provider unusable
#   3 internal
#  10 --fail-on-finding and at least one strict survivor

set -euo pipefail

lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$lib_dir/../../.." && pwd)"
prompts="$lib_dir/prompts"
schema="$lib_dir/lib/findings-schema.json"
# shellcheck source=/dev/null
. "$lib_dir/lib/provider.sh"

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

# Emit report. Globals: want_json, base, head_ref, reviewer, refuter, mode, skipped_gates
_emit() {
  local survivors="$1" needs_human="$2" dropped="$3"
  local skipped_json
  skipped_json="$(printf '%s\n' "${skipped_gates[@]:-}" | jq -R . | jq -sc 'map(select(length>0))')"
  if [ "$want_json" -eq 1 ]; then
    jq -nc --argjson survivors "$survivors" --argjson needs_human "$needs_human" \
       --argjson dropped "$dropped" --argjson skipped "$skipped_json" \
       --arg base "$base" --arg head "$head_ref" \
       --arg reviewer "$reviewer" --arg refuter "$refuter" --arg mode "$mode" \
       '{mode:$mode, base:$base, head:$head, reviewer:$reviewer, refuter:$refuter,
         skipped_gates:$skipped, survivors:$survivors, needs_human:$needs_human, dropped:$dropped}'
    return
  fi
  local ns nh nd
  ns="$(printf '%s' "$survivors" | jq 'length')"
  nh="$(printf '%s' "$needs_human" | jq 'length')"
  nd="$(printf '%s' "$dropped" | jq 'length')"
  echo
  echo "═══ Adversarial review [$mode]: $base..$head_ref  ($reviewer vs $refuter) ═══"
  if [ "$(printf '%s' "$skipped_json" | jq 'length')" -gt 0 ]; then
    echo "⚠ skipped gates: $(printf '%s' "$skipped_json" | jq -r 'join(", ")')"
    echo "  (result may be SINGLE-MODEL — not full cross-agent)"
  fi
  echo
  echo "── survivors (strict blockers: CONFIRMED + reproduced) [$ns] ──"
  if [ "$ns" -eq 0 ]; then
    echo "(none)"
  else
    printf '%s' "$survivors" | jq -r '.[] |
      "• [\(.severity)] \(.file):\(.line) — \(.summary)\n    scenario: \(.failure_scenario)\n    repro: \(.repro.note // "n/a")"'
  fi
  if [ "$mode" = "advisory" ] || [ "$nh" -gt 0 ]; then
    echo
    echo "── needs_human / plausible [$nh] ──"
    if [ "$nh" -eq 0 ]; then
      echo "(none)"
    else
      printf '%s' "$needs_human" | jq -r '.[] |
        "• [\(.severity)] \(.file):\(.line) — \(.summary)\n    note: \(.repro.note // .verdict // "n/a")"'
    fi
  fi
  [ "$nd" -gt 0 ] && echo && echo "($nd finding(s) dropped — see --json for details)"
}

# --- selfcheck / dogfood passthrough ----------------------------------------
if [ "${1:-}" = "selfcheck" ]; then shift; _selfcheck "$@"; exit $?; fi

dogfood=0
if [ "${1:-}" = "dogfood" ]; then
  dogfood=1
  shift
fi

# --- args --------------------------------------------------------------------
base=""; head_ref="HEAD"; reviewer="claude"; refuter="codex"
min_sev="low"; want_json=0; dry=0; mode="strict"; fail_on=0
skipped_gates=()
while [ $# -gt 0 ]; do
  case "$1" in
    --reviewer) reviewer="$2"; shift 2 ;;
    --refuter|--critic) refuter="$2"; shift 2 ;;  # --critic is deprecated alias
    --head) head_ref="$2"; shift 2 ;;
    --min-severity) min_sev="$2"; shift 2 ;;
    --mode) mode="$2"; shift 2 ;;
    --json) want_json=1; shift ;;
    --dry-run) dry=1; shift ;;
    --fail-on-finding) fail_on=1; shift ;;
    -h|--help)
      sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "unknown flag: $1" ;;
    *) [ -z "$base" ] && base="$1" || die "unexpected arg: $1"; shift ;;
  esac
done

case "$mode" in strict|advisory) ;; *) die "mode must be strict|advisory" ;; esac

cd "$repo_root"

if [ "$dogfood" -eq 1 ]; then
  # Review staged+unstaged+untracked under this tool + docs, vs HEAD.
  # Uses a synthetic range: stash-less path via git diff HEAD and include untracked via temporary index? 
  # Practical approach: base=HEAD, head= worktree with only our paths — use HEAD and pass "working tree"
  # by creating a temporary commit-less diff: git diff HEAD -- paths + untracked.
  base="HEAD"
  head_ref="WORKTREE"
  log "dogfood: reviewing adversarial-review + related docs against HEAD (working tree)"
fi

[ -n "$base" ] || die "missing BASE_REF (try: run.sh HEAD~1  or  run.sh dogfood)"

if [ "$head_ref" != "WORKTREE" ]; then
  git rev-parse --verify -q "$base" >/dev/null || die "bad ref: $base"
  git rev-parse --verify -q "$head_ref" >/dev/null || die "bad ref: $head_ref"
else
  git rev-parse --verify -q "$base" >/dev/null || die "bad ref: $base"
fi
min_rank="$(sev_rank "$min_sev")"

# --- stage 0: precheck -------------------------------------------------------
tool_paths=(
  "scripts/dev/adversarial-review"
  "docs/adversarial-review.md"
  "openclaw/scripts/claw-worktree.sh"
)

if [ "$head_ref" = "WORKTREE" ]; then
  # collect changed names for tool paths
  changed="$(
    {
      git diff --name-only "$base" -- "${tool_paths[@]}" 2>/dev/null || true
      git ls-files --others --exclude-standard -- "${tool_paths[@]}" 2>/dev/null || true
    } | sort -u
  )"
  diff="$(
    {
      git diff "$base" -- "${tool_paths[@]}" 2>/dev/null || true
      # untracked files as /dev/null diffs
      while IFS= read -r f; do
        [ -z "$f" ] && continue
        [ -f "$f" ] || continue
        git diff --no-index -- /dev/null "$f" 2>/dev/null || true
      done < <(git ls-files --others --exclude-standard -- "${tool_paths[@]}" 2>/dev/null || true)
    }
  )"
else
  changed="$(git diff --name-only "$base".."$head_ref")"
  diff="$(git diff "$base".."$head_ref")"
fi

[ -n "$changed" ] || { log "no changes in range"; exit 0; }

has_runtime=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    *.md|docs/*|*/testdata/*|*_test.*|*.test.*|test/*|tests/*) : ;;
    *) has_runtime=1 ;;
  esac
done <<< "$changed"
if [ "$has_runtime" -eq 0 ]; then
  log "skip: diff is docs/tests only — no runtime behavior to review adversarially"
  exit 0
fi

log "range $base..$head_ref  mode=$mode  reviewer=$reviewer  refuter=$refuter"

if [ "$dry" -eq 1 ]; then
  log "dry-run — planned gates:"
  log "  stage1 find   -> $reviewer"
  log "  stage2 refute -> $refuter $(provider_available "$refuter" && echo '(available)' || echo '(UNAVAILABLE -> skip)')"
  log "  stage3 repro  -> $reviewer + sandbox worktree"
  exit 0
fi

provider_available "$reviewer" || die "reviewer '$reviewer' unavailable" 2

# --- stage 1: find -----------------------------------------------------------
log "stage 1/3 · find ($reviewer)…"
f1="$(printf '%s' "$diff" | run_agent "$reviewer" "$prompts/critic.md")" \
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
  refute_in="$diff"$'\n\n=== FINDINGS ===\n'"$f1"
  if f2_raw="$(printf '%s' "$refute_in" | run_agent "$refuter" "$prompts/refute.md")"; then
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

    repro_in="$(jq -nc --argjson finding "$f" --arg hunk "$hunk" \
      '{finding:$finding, related_diff:$hunk}')"
    script_raw="$(printf '%s' "$repro_in" | agent_text "$reviewer" "$prompts/repro.md" || true)"
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
