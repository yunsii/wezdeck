#!/usr/bin/env bash
# Usage:
#   run.sh "<problem>" [options]
#   run.sh --problem-file <path> [options]
#   run.sh selfcheck [claude|codex|grok ...]
#
# Multi-persona brainstorm over a free-form problem, in three stages:
#   1 Diverge    N personas × cross-provider generate ideas INDEPENDENTLY
#   2 Challenge  a devil's-advocate stress-tests every idea (feasibility/risk)
#   3 Converge   a judge blind-ranks + synthesizes a recommendation
#
# Stateless by design: each stage is a fresh provider call and the prior stage's
# JSON is passed as INPUT — NOT a CLI session resume. That is deliberate:
#   - diverge personas must NOT see each other (independence beats groupthink)
#   - resume binds one provider; brainstorm wants cross-model diversity
# See SKILL.md and memory: adversarial-review-no-resume.
#
# TOOL vs INPUT:
#   TOOL_HOME  = this script's directory (prompts, lib)
#   provider.sh is REUSED from the sibling adversarial-review skill.
#
# Options:
#   --problem-file F     read problem from file instead of positional arg
#   --constraints TEXT   constraints to honor (or --constraints-file F)
#   --constraints-file F
#   --personas N         how many persona lenses to use (1..4, default 4)
#   --diverge CSV        providers for diverge (default: all available)
#   --challenger P       provider for stage 2 (default: 2nd available)
#   --judge P            provider for stage 3 (default: 3rd available)
#   --top N              how many ideas to highlight as top (default 3)
#   --json               emit machine-readable JSON instead of a report
#   --dry-run            print the plan and exit
#
# Exit codes: 0 ok · 1 usage · 2 provider unusable · 3 internal

set -euo pipefail

tool_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
prompts="$tool_root/prompts"
schema="$tool_root/lib/ideas-schema.json"

# Single-shot stages: provider run_agent → __invoke.
# Parallel diverge: fanout-lib (sources provider one-way).
adv_provider="$tool_root/../adversarial-review/lib/provider.sh"
fanout_lib="$tool_root/../agent-fanout/lib/fanout-lib.sh"
[ -f "$fanout_lib" ] || {
  printf 'error: fanout lib not found at %s\n' "$fanout_lib" >&2
  exit 3
}
# shellcheck source=/dev/null
. "$fanout_lib"
# shellcheck source=/dev/null
. "$(dirname "$adv_provider")/roles-lib.sh"

log() { printf '\033[2m[brainstorm]\033[0m %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit "${2:-1}"; }

# Persona lenses for diverge, loaded from the standard (add a lens = one line
# in lib/personas.conf, no code edits). Format per line: name|description
PERSONAS=()
while IFS= read -r _pl; do
  [ -z "$_pl" ] && continue
  case "$_pl" in \#*) continue ;; esac
  PERSONAS+=("$_pl")
done < "$tool_root/lib/personas.conf"
[ "${#PERSONAS[@]}" -ge 1 ] || die "no personas found in lib/personas.conf" 3

# --- selfcheck passthrough ---------------------------------------------------
if [ "${1:-}" = "selfcheck" ]; then
  shift
  cands=("$@")
  [ "${#cands[@]}" -gt 0 ] || cands=("${_ALL_PROVIDERS[@]}")
  rc=0
  for p in "${cands[@]}"; do
    if provider_available "$p"; then
      printf '  %-12s available\n' "$p"
    else
      printf '  %-12s UNAVAILABLE\n' "$p"; rc=1
    fi
  done
  exit $rc
fi

# --- args --------------------------------------------------------------------
problem=""; problem_file=""; constraints=""; constraints_file=""
personas_n=4; diverge_csv=""; challenger=""; judge=""
top_n=3; want_json=0; dry=0
skipped=()

while [ $# -gt 0 ]; do
  case "$1" in
    --problem-file) problem_file="$2"; shift 2 ;;
    --constraints) constraints="$2"; shift 2 ;;
    --constraints-file) constraints_file="$2"; shift 2 ;;
    --personas) personas_n="$2"; shift 2 ;;
    --diverge) diverge_csv="$2"; shift 2 ;;
    --challenger) challenger="$2"; shift 2 ;;
    --judge) judge="$2"; shift 2 ;;
    --top) top_n="$2"; shift 2 ;;
    --json) want_json=1; shift ;;
    --dry-run) dry=1; shift ;;
    -h|--help) sed -n '2,42p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown flag: $1" ;;
    *) [ -z "$problem" ] && problem="$1" || die "unexpected arg: $1"; shift ;;
  esac
done

[ -n "$problem_file" ] && problem="$(cat "$problem_file")"
[ -n "$constraints_file" ] && constraints="$(cat "$constraints_file")"
[ -n "$problem" ] || die "missing problem (positional arg or --problem-file)"

case "$personas_n" in ''|*[!0-9]*) die "--personas must be an integer" ;; esac
[ "$personas_n" -ge 1 ] || die "--personas must be >= 1"
[ "$personas_n" -le "${#PERSONAS[@]}" ] || personas_n="${#PERSONAS[@]}"

# --- provider selection (standard-driven: roles.conf) ------------------------
avail=()
for p in "${_ALL_PROVIDERS[@]}"; do
  provider_available "$p" && avail+=("$p")
done
[ "${#avail[@]}" -ge 1 ] || die "no providers available (none of: ${_ALL_PROVIDERS[*]})" 2

# per-stage effort from the standard
div_effort="$(role_effort brainstorm diverge)"
ch_effort="$(role_effort brainstorm challenge)"
cv_effort="$(role_effort brainstorm converge)"

# available candidates for a role, in standard order (fallback: all available)
_role_cands() {
  local c out=""
  for c in $(role_candidates "$1" "$2"); do provider_available "$c" && out="$out $c"; done
  [ -n "$out" ] && printf '%s' "${out# }" || printf '%s' "${avail[*]}"
}
read -r -a div_seq <<< "$(_role_cands brainstorm diverge)"
read -r -a ch_seq  <<< "$(_role_cands brainstorm challenge)"
read -r -a cv_seq  <<< "$(_role_cands brainstorm converge)"

# diverge providers: --diverge overrides; else the standard's diverge sequence
diverge_providers=()
if [ -n "$diverge_csv" ]; then
  IFS=',' read -r -a _req <<< "$diverge_csv"
  for p in "${_req[@]}"; do
    if provider_available "$p"; then diverge_providers+=("$p"); else log "skip diverge provider (unavailable): $p"; fi
  done
  [ "${#diverge_providers[@]}" -ge 1 ] || die "no requested --diverge providers available" 2
else
  diverge_providers=("${div_seq[@]}")
fi
primary="${diverge_providers[0]}"

# challenger / judge: --flag overrides; else the standard's first available
[ -n "$challenger" ] || challenger="${ch_seq[0]}"
[ -n "$judge" ]      || judge="${cv_seq[0]}"

# notes (not fatal). diverge already rotates models, so only flag when the two
# convergent roles collapse onto one model (that is what weakens L2 isolation).
provider_same_family "$challenger" "$judge" && skipped+=("challenge+judge-same-model")
provider_available "$challenger" || skipped+=("challenger-unavailable($challenger)")
provider_available "$judge" || skipped+=("judge-unavailable($judge)")

# --- validation helper -------------------------------------------------------
_validate_ideas() {
  printf '%s' "$1" | jq -c '
    def ok: (type=="object")
      and (.title|type=="string") and ((.title|length)>0)
      and (.summary|type=="string") and ((.summary|length)>0);
    if type != "array" then [] else [ .[] | select(ok) ] end
  ' 2>/dev/null || printf '%s' '[]'
}

# Tag + merge one persona body into all_ideas (current shell — do not $()-wrap).
# Sets INGEST_N. Return 1 if no valid ideas.
_ingest_diverge_body() {
  local pname="$1" raw="$2"
  local ideas_i sliced
  INGEST_N=0
  if sliced="$(printf '%s' "$raw" | _json_slice 2>/dev/null)"; then
    raw="$sliced"
  fi
  ideas_i="$(_validate_ideas "$raw")"
  INGEST_N="$(printf '%s' "$ideas_i" | jq 'length')"
  [ "$INGEST_N" -gt 0 ] || return 1
  ideas_i="$(printf '%s' "$ideas_i" | jq -c --arg p "$pname" \
    '[ .[] | .persona=$p | .id=($p+"::"+(.title//"")) ]')"
  all_ideas="$(jq -nc --argjson a "$all_ideas" --argjson b "$ideas_i" '$a + $b')"
  return 0
}

# Run a stage against candidates until one returns valid JSON.
# Reads INPUT from stdin; $1=prompt_file, rest=candidate providers.
# On success: echoes "<provider>\n<JSON>" ; returns 0. Else 1.
_run_with_fallback() {
  local prompt_file="$1" effort="$2"; shift 2
  local input out p
  input="$(cat)"
  for p in "$@"; do
    provider_available "$p" || continue
    if out="$(printf '%s' "$input" | run_agent "$p" "$prompt_file" "$effort")"; then
      printf '%s\n%s' "$p" "$out"; return 0
    fi
    log "  ! $p failed on $(basename "$prompt_file") — trying next candidate"
  done
  return 1
}

constraints_disp="${constraints:-(none)}"

if [ "$dry" -eq 1 ]; then
  log "dry-run — planned brainstorm:"
  log "  problem      -> ${problem:0:60}…"
  log "  personas     -> $personas_n of ${#PERSONAS[@]}"
  log "  diverge      -> ${diverge_providers[*]} (rotated across personas)"
  log "  challenger   -> $challenger $(provider_available "$challenger" && echo '(available)' || echo '(UNAVAILABLE)')"
  log "  judge        -> $judge $(provider_available "$judge" && echo '(available)' || echo '(UNAVAILABLE)')"
  [ "${#skipped[@]}" -gt 0 ] && log "  notes        -> ${skipped[*]}"
  exit 0
fi

# --- stage 1: diverge (parallel primary + serial fallback) ------------------
log "stage 1/3 · diverge ($personas_n personas over: ${diverge_providers[*]})…"
all_ideas='[]'
ndp="${#diverge_providers[@]}"
div_tmp="$(mktemp -d "${TMPDIR:-/tmp}/brainstorm-diverge.XXXXXX")"

# persona_meta lines: pname|primary|cand2,cand3,...
# full prompt path contains "diverge" so PROVIDER_MOCK uses provider fixtures.
job_args=()
persona_meta=()
for i in $(seq 0 $((personas_n - 1))); do
  entry="${PERSONAS[$i]}"
  pname="${entry%%|*}"
  pdesc="${entry#*|}"
  prov="${diverge_providers[$((i % ndp))]}"
  d_cands=("$prov"); for c in "${div_seq[@]}"; do [ "$c" != "$prov" ] && d_cands+=("$c"); done
  d_in="=== YOUR PERSONA ==="$'\n'"$pname: $pdesc"$'\n\n'"=== PROBLEM ==="$'\n'"$problem"$'\n\n'"=== CONSTRAINTS ==="$'\n'"$constraints_disp"
  full_pf="$div_tmp/diverge-${pname}.full.md"
  {
    cat "$prompts/diverge.md"
    printf '\n\n=== INPUT ===\n%s' "$d_in"
  } >"$full_pf"
  printf '%s' "$d_in" >"$div_tmp/${pname}.input.md"
  rest_cands=("${d_cands[@]:1}")
  IFS=','; rest_joined="${rest_cands[*]-}"; unset IFS
  persona_meta+=("${pname}|${prov}|${rest_joined}")
  job_args+=(--job "${pname}|${prov}|${full_pf}")
done

# Primary: true parallel across personas (one backend each).
primary_ok=()
set +e
FANOUT_QUIET=1 fanout_run_jobs --out "$div_tmp/out" --effort "$div_effort" --parallel "${job_args[@]}"
set -e
for meta in "${persona_meta[@]}"; do
  pname="${meta%%|*}"
  rest="${meta#*|}"
  prov="${rest%%|*}"
  body_f="$div_tmp/out/${pname}.md"
  [ -f "$body_f" ] && [ -s "$body_f" ] || continue
  if _ingest_diverge_body "$pname" "$(cat "$body_f")"; then
    log "  • $pname ($prov) → $INGEST_N idea(s) [fanout]"
    primary_ok+=("$pname")
  fi
done

# Fallback: failed personas, serial run_agent candidate chain.
for meta in "${persona_meta[@]}"; do
  pname="${meta%%|*}"
  rest="${meta#*|}"
  prov="${rest%%|*}"
  rest_cands="${rest#*|}"
  skip=0
  for okp in "${primary_ok[@]+"${primary_ok[@]}"}"; do
    [ "$okp" = "$pname" ] && { skip=1; break; }
  done
  [ "$skip" -eq 1 ] && continue

  d_cands=("$prov")
  if [ -n "$rest_cands" ]; then
    IFS=',' read -r -a _rc <<<"$rest_cands"
    d_cands+=("${_rc[@]}")
  fi
  d_in="$(cat "$div_tmp/${pname}.input.md")"
  if draw="$(printf '%s' "$d_in" | _run_with_fallback "$prompts/diverge.md" "$div_effort" "${d_cands[@]}")"; then
    dused="$(printf '%s' "$draw" | head -n1)"
    raw="$(printf '%s' "$draw" | tail -n +2)"
    [ "$dused" != "$prov" ] && skipped+=("diverge-fellback($pname:$prov→$dused)")
    if _ingest_diverge_body "$pname" "$raw"; then
      log "  • $pname ($dused) → $INGEST_N idea(s) [fallback]"
    else
      log "  ! $pname empty after fallback validate — skipped"
      skipped+=("diverge-bad-json($pname)")
    fi
  else
    log "  ! $pname produced no valid JSON on any provider — skipped"
    skipped+=("diverge-bad-json($pname)")
  fi
done

rm -rf "$div_tmp"

n_ideas="$(printf '%s' "$all_ideas" | jq 'length')"
log "  → $n_ideas total idea(s)"
[ "$n_ideas" -gt 0 ] || die "diverge produced no ideas" 3

# --- stage 2: challenge ------------------------------------------------------
challenged="$all_ideas"
# candidates: challenger first, then the rest of the challenge sequence
ch_cands=("$challenger"); for c in "${ch_seq[@]}"; do [ "$c" != "$challenger" ] && ch_cands+=("$c"); done
if provider_available "$challenger" || [ "${#ch_cands[@]}" -gt 0 ]; then
  log "stage 2/3 · challenge ($challenger)…"
  c_in="=== PROBLEM ==="$'\n'"$problem"$'\n\n'"=== CONSTRAINTS ==="$'\n'"$constraints_disp"$'\n\n'"=== IDEAS ==="$'\n'"$all_ideas"
  if raw2="$(printf '%s' "$c_in" | _run_with_fallback "$prompts/challenge.md" "$ch_effort" "${ch_cands[@]}")"; then
    used="$(printf '%s' "$raw2" | head -n1)"
    c2_raw="$(printf '%s' "$raw2" | tail -n +2)"
    [ "$used" != "$challenger" ] && skipped+=("challenger-fellback($challenger→$used)")
    challenger="$used"
    c2="$(_validate_ideas "$c2_raw")"
    challenged="$(jq -nc --argjson base "$all_ideas" --argjson ch "$c2" '
      ($ch | map({key:(.id // (.persona+"::"+.title)), value:.}) | from_entries) as $m
      | [ $base[]
          | . as $o
          | ($m[$o.id] // {}) as $n
          | $o + ( $n
                   | {feasibility, risks, blocking_assumptions, challenge_note}
                   | with_entries(select(.value != null)) )
        ]')"
    log "  → challenged $(printf '%s' "$challenged" | jq '[.[]|select(.feasibility!=null)]|length')/$n_ideas idea(s)"
  else
    log "  ! challenger returned no valid JSON — keeping ideas unchallenged"
    skipped+=("challenge-bad-json")
  fi
else
  log "stage 2/3 · SKIP — challenger '$challenger' unavailable"
fi

# --- stage 3: converge -------------------------------------------------------
synthesis=""; key_tradeoffs='[]'; final_ideas="$challenged"
# candidates: judge first, then the rest of the converge sequence
jd_cands=("$judge"); for c in "${cv_seq[@]}"; do [ "$c" != "$judge" ] && jd_cands+=("$c"); done
log "stage 3/3 · converge ($judge)…"
v_in="=== PROBLEM ==="$'\n'"$problem"$'\n\n'"=== CONSTRAINTS ==="$'\n'"$constraints_disp"$'\n\n'"=== IDEAS ==="$'\n'"$challenged"
if raw3="$(printf '%s' "$v_in" | _run_with_fallback "$prompts/converge.md" "$cv_effort" "${jd_cands[@]}")"; then
  used="$(printf '%s' "$raw3" | head -n1)"
  conv_raw="$(printf '%s' "$raw3" | tail -n +2)"
  [ "$used" != "$judge" ] && skipped+=("judge-fellback($judge→$used)")
  judge="$used"
  conv_ideas="$(printf '%s' "$conv_raw" | jq -c '.ideas // empty' 2>/dev/null || true)"
  cj="$(_validate_ideas "$conv_ideas")"
  if [ -n "$conv_ideas" ] && [ "$(printf '%s' "$cj" | jq 'length')" -gt 0 ]; then
    # Merge the judge's score/verdict/judge_note back onto the challenged set by
    # id — never let the judge silently drop ideas. Ideas the judge omitted are
    # kept unscored (they sort by novelty), and every original field is preserved.
    final_ideas="$(jq -nc --argjson base "$challenged" --argjson j "$cj" '
      ($j | map({key:(.id // (.persona+"::"+.title)), value:.}) | from_entries) as $m
      | [ $base[]
          | . as $o
          | ($m[$o.id] // {}) as $n
          | $o + ( $n | {score, verdict, judge_note} | with_entries(select(.value != null)) )
        ]')"
    synthesis="$(printf '%s' "$conv_raw" | jq -r '.synthesis // ""' 2>/dev/null || true)"
    key_tradeoffs="$(printf '%s' "$conv_raw" | jq -c '(.key_tradeoffs // []) | if type=="array" then . else [] end' 2>/dev/null || printf '[]')"
    n_scored="$(printf '%s' "$final_ideas" | jq '[.[]|select(.score!=null)]|length')"
    [ "$n_scored" -lt "$n_ideas" ] && skipped+=("converge-partial($n_scored/$n_ideas scored)")
    log "  → judged $n_scored/$n_ideas idea(s)"
  else
    log "  ! judge output missing valid ideas — keeping challenged set unranked"
    skipped+=("converge-bad-json")
  fi
else
  log "  ! all judge candidates failed — keeping challenged set unranked"
  skipped+=("converge-failed")
fi

# rank: by score if judged, else by novelty
ranked="$(printf '%s' "$final_ideas" | jq -c '
  def num: if type=="number" then . else 0 end;
  sort_by(-(.score|num), -(.novelty|num))')"

# --- emit --------------------------------------------------------------------
skipped_json="$(printf '%s\n' "${skipped[@]:-}" | jq -R . | jq -sc 'map(select(length>0))')"

if [ "$want_json" -eq 1 ]; then
  jq -nc --argjson ideas "$ranked" --arg synthesis "$synthesis" \
     --argjson tradeoffs "$key_tradeoffs" --argjson skipped "$skipped_json" \
     --arg primary "$primary" --arg challenger "$challenger" --arg judge "$judge" \
     --arg challenger_model "$(provider_model "$challenger")" \
     --arg judge_model "$(provider_model "$judge")" \
     --argjson personas "$personas_n" \
     '{diverge_primary:$primary, challenger:$challenger, challenger_model:$challenger_model,
       judge:$judge, judge_model:$judge_model, personas:$personas,
       consensus:"single-judge · cross-model UNREVIEWED",
       skipped:$skipped, synthesis:$synthesis, key_tradeoffs:$tradeoffs, ideas:$ideas}'
  exit 0
fi

echo
echo "═══ Brainstorm: ${problem:0:70} ═══"
echo "## 头脑风暴披露"
_div_disp=""; for _p in "${diverge_providers[@]}"; do _div_disp="$_div_disp $_p($(provider_model "$_p"))"; done
echo "- diverge personas: $personas_n over${_div_disp}"
echo "- challenger: $challenger (model: $(provider_model "$challenger"))"
echo "- judge: $judge (model: $(provider_model "$judge"))"
echo "- consensus: 单盲评委推荐,非多模型共识(cross-model UNREVIEWED)"
if [ "$(printf '%s' "$skipped_json" | jq 'length')" -gt 0 ]; then
  echo "- notes: $(printf '%s' "$skipped_json" | jq -r 'join(", ")')"
else
  echo "- notes: 无"
fi
echo
nr="$(printf '%s' "$ranked" | jq 'length')"
echo "── top $top_n of $nr idea(s) ──"
printf '%s' "$ranked" | jq -r --argjson top "$top_n" '
  to_entries
  | map(select(.key < $top))
  | .[]
  | .value as $i
  | "• [\($i.score // "?")/10 · \($i.verdict // "?")] \($i.title)  (\($i.persona // "?"))\n"
    + "    \($i.summary)\n"
    + (if $i.feasibility then "    feasibility: \($i.feasibility)/5" else "" end)
    + (if ($i.risks // [] | length) > 0 then "  · risks: \($i.risks | join("; "))" else "" end)
    + (if $i.judge_note then "\n    why: \($i.judge_note)" else "" end)
'
if [ "$nr" -gt "$top_n" ]; then
  echo
  echo "── other idea(s) ──"
  printf '%s' "$ranked" | jq -r --argjson top "$top_n" '
    to_entries | map(select(.key >= $top)) | .[] | .value
    | "· [\(.score // "?")/10] \(.title)  (\(.persona // "?"))"'
fi
if [ -n "$synthesis" ]; then
  echo
  echo "── synthesis (单评委推荐 · UNREVIEWED) ──"
  echo "$synthesis"
fi
if [ "$(printf '%s' "$key_tradeoffs" | jq 'length')" -gt 0 ]; then
  echo
  echo "── key tradeoffs ──"
  printf '%s' "$key_tradeoffs" | jq -r '.[] | "• \(.)"'
fi
exit 0
