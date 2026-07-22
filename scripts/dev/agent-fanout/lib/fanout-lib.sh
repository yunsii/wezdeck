#!/usr/bin/env bash
# fanout-lib.sh — multi-shot host-CLI scheduler (parallel / serial).
#
# Dependency is one-way: this file sources provider.sh (plugins + mock helpers).
# Single-shot hot path stays in provider agent_text/run_agent → __invoke.
#
# Public API:
#   fanout_call      thin single invoke → stdout (no temp dir)
#   fanout_run       same prompt → 1..N backends; writes --out layout
#   fanout_run_jobs  name|backend|prompt_file jobs; writes --out layout
#
# Jobs always pass prompt *file paths* (not full text in global arrays).
# Env: PROVIDER_MOCK=1 · FANOUT_QUIET=1 · FANOUT_TIMEOUT=N
#
# shellcheck shell=bash

if [ -n "${_FANOUT_LIB_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
_FANOUT_LIB_LOADED=1

_FANOUT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_FANOUT_TOOL_ROOT="$(cd "$_FANOUT_LIB_DIR/.." && pwd)"
_FANOUT_PROVIDER="${FANOUT_PROVIDER_LIB:-$_FANOUT_TOOL_ROOT/../adversarial-review/lib/provider.sh}"

[ -f "$_FANOUT_PROVIDER" ] || {
  printf 'error: provider lib not found at %s\n' "$_FANOUT_PROVIDER" >&2
  return 5 2>/dev/null || exit 5
}
# shellcheck source=/dev/null
. "$_FANOUT_PROVIDER"

fanout_log() {
  [ -n "${FANOUT_QUIET:-}" ] && return 0
  printf '\033[2m[agent-fanout]\033[0m %s\n' "$*" >&2
}

# Sets _FANOUT_PROMPT from exactly one source. Return 1 on error.
_fanout_read_prompt() {
  local prompt="${1:-}" prompt_file="${2:-}" use_stdin="${3:-0}" sources=0
  [ -n "$prompt" ] && sources=$((sources + 1))
  [ -n "$prompt_file" ] && sources=$((sources + 1))
  [ "$use_stdin" -eq 1 ] && sources=$((sources + 1))
  [ "$sources" -eq 1 ] || return 1
  if [ -n "$prompt_file" ]; then
    [ -f "$prompt_file" ] || return 1
    _FANOUT_PROMPT="$(cat "$prompt_file")"
  elif [ "$use_stdin" -eq 1 ]; then
    _FANOUT_PROMPT="$(cat)"
  else
    _FANOUT_PROMPT="$prompt"
  fi
  [ -n "${_FANOUT_PROMPT}" ]
}

_fanout_resolve_backends() {
  local csv="${1:-}" requested=() b
  if [ -n "$csv" ]; then
    IFS=',' read -r -a requested <<<"$csv"
  else
    requested=("${_ALL_PROVIDERS[@]}")
  fi
  for b in "${requested[@]}"; do
    b="$(printf '%s' "$b" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "$b" ] || continue
    b="$(_provider_canonical "$b")"
    if [ -n "${PROVIDER_MOCK:-}" ] || provider_available "$b"; then
      printf '%s\n' "$b"
    else
      fanout_log "skip unavailable: $b"
    fi
  done
}

# --- thin single call → stdout (no disk) ------------------------------------
# Exit: 0 ok · 1 usage · 3 unavailable · 4 empty/error · 124 timeout
fanout_call() {
  local backend="" effort="" timeout_sec="${FANOUT_TIMEOUT:-0}"
  local prompt="" prompt_file="" use_stdin=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --backend) backend="${2:-}"; shift 2 ;;
      --effort) effort="${2:-}"; shift 2 ;;
      --timeout) timeout_sec="${2:-0}"; shift 2 ;;
      --prompt) prompt="${2:-}"; shift 2 ;;
      --prompt-file) prompt_file="${2:-}"; shift 2 ;;
      --stdin) use_stdin=1; shift ;;
      *) printf 'fanout_call: unknown option %s\n' "$1" >&2; return 1 ;;
    esac
  done
  [ -n "$backend" ] || { printf 'fanout_call: --backend required\n' >&2; return 1; }
  case "$timeout_sec" in ''|*[!0-9]*) timeout_sec=0 ;; esac
  _fanout_read_prompt "$prompt" "$prompt_file" "$use_stdin" \
    || { printf 'fanout_call: need exactly one non-empty --prompt / --prompt-file / --stdin\n' >&2; return 1; }

  local canon body rc=0
  canon="$(_provider_canonical "$backend")"

  if [ -n "${PROVIDER_MOCK:-}" ]; then
    # Free-form only. Structured fixtures live in provider._provider_mock.
    printf 'mock-reply from %s\n' "$canon"
    return 0
  fi
  if ! declare -F "${canon}__invoke" >/dev/null 2>&1 || ! provider_available "$canon"; then
    return 3
  fi

  set +e
  if [ "$timeout_sec" -gt 0 ] && command -v timeout >/dev/null 2>&1; then
    body="$(printf '%s' "$_FANOUT_PROMPT" | timeout --signal=TERM --kill-after=5s "$timeout_sec" \
      bash -c '
        set -euo pipefail
        # shellcheck source=/dev/null
        . "$1"
        "${2}__invoke" "$3"
      ' bash "$_FANOUT_PROVIDER" "$canon" "$effort")"
    rc=$?
  else
    body="$(printf '%s' "$_FANOUT_PROMPT" | "${canon}__invoke" "$effort")"
    rc=$?
  fi
  set -e

  [ "$rc" -eq 124 ] && return 124
  [ "$rc" -eq 0 ] || return 4
  [ -n "$body" ] || return 4
  printf '%s' "$body"
  return 0
}

# --- mock body for a prompt file (reuses provider fixtures by template name) --
# Callers may pass full assembled prompts; we key on path keywords only for
# known templates (diverge/critic), never grepping prompt *content*.
_fanout_mock_body() {
  local prompt_file="$1" canon="$2"
  local input base kind
  input="$(awk '/^=== INPUT ===$/{p=1;next} p' "$prompt_file" 2>/dev/null || true)"
  [ -n "$input" ] || input="$(cat "$prompt_file" 2>/dev/null || true)"
  base="$(basename "$prompt_file")"
  kind=""
  case "$base" in
    diverge.md) kind="diverge.md" ;;
    critic.md) kind="critic.md" ;;
    challenge.md) kind="challenge.md" ;;
    refute.md) kind="refute.md" ;;
    converge.md) kind="converge.md" ;;
    repro.md) kind="repro.md" ;;
  esac
  # Assembled full prompts often look like moonshot.full.md — allow *diverge* path.
  if [ -z "$kind" ]; then
    case "$prompt_file" in
      *diverge*) kind="diverge.md" ;;
      *critic*) kind="critic.md" ;;
    esac
  fi
  if [ -n "$kind" ]; then
    _provider_mock "$kind" "$input"
  else
    printf 'mock-reply from %s\n' "$canon"
  fi
}

# --- one job → out_dir/{stem}.md|.log|.meta.json ; print stem:status --------
_fanout_job_to_files() {
  local stem="$1" backend="$2" prompt_file="$3" effort="$4" out_dir="$5" timeout_sec="$6"
  local outfile="$out_dir/${stem}.md"
  local logfile="$out_dir/${stem}.log"
  local metafile="$out_dir/${stem}.meta.json"
  local canon model started ended elapsed rc=0 body_bytes=0 status="ok" err_note=""

  canon="$(_provider_canonical "$backend")"
  model="$(provider_model "$canon" 2>/dev/null || echo unknown)"
  started="$(date +%s)"
  {
    echo "[$(date -Iseconds)] start stem=$stem backend=$canon prompt_file=$prompt_file"
  } >"$logfile"

  set +e
  if [ -n "${PROVIDER_MOCK:-}" ]; then
    _fanout_mock_body "$prompt_file" "$canon" >"$outfile" 2>>"$logfile"
    rc=$?
  elif ! declare -F "${canon}__invoke" >/dev/null 2>&1; then
    status="unavailable"; rc=3; err_note="no __invoke"; : >"$outfile"
  elif ! provider_available "$canon"; then
    status="unavailable"; rc=3; err_note="not on PATH"; : >"$outfile"
  elif [ ! -f "$prompt_file" ]; then
    status="error"; rc=4; err_note="missing prompt file"; : >"$outfile"
  else
    if [ "$timeout_sec" -gt 0 ] && command -v timeout >/dev/null 2>&1; then
      timeout --signal=TERM --kill-after=5s "$timeout_sec" \
        bash -c '
          set -euo pipefail
          # shellcheck source=/dev/null
          . "$1"
          cat "$2" | "${3}__invoke" "$4"
        ' bash "$_FANOUT_PROVIDER" "$prompt_file" "$canon" "$effort" \
        >"$outfile" 2>>"$logfile"
      rc=$?
    else
      cat "$prompt_file" | "${canon}__invoke" "$effort" >"$outfile" 2>>"$logfile"
      rc=$?
    fi
    if [ "$rc" -eq 124 ]; then
      status="timeout"; err_note="wall clock ${timeout_sec}s"
    elif [ "$rc" -ne 0 ]; then
      status="error"; err_note="invoke rc=$rc"
    elif [ ! -s "$outfile" ]; then
      status="empty"; rc=4; err_note="empty stdout"
    fi
  fi
  set -e

  ended="$(date +%s)"
  elapsed=$((ended - started))
  body_bytes=0
  [ -f "$outfile" ] && body_bytes="$(wc -c <"$outfile" | tr -d ' ')"
  if [ "$status" = "ok" ] && [ "$rc" -ne 0 ]; then status="error"; fi
  {
    echo "[$(date -Iseconds)] end status=$status rc=$rc bytes=$body_bytes elapsed=${elapsed}s ${err_note}"
  } >>"$logfile"

  jq -nc \
    --arg name "$stem" \
    --arg backend "$canon" \
    --arg model "$model" \
    --arg status "$status" \
    --arg effort "${effort}" \
    --arg err "$err_note" \
    --argjson rc "$rc" \
    --argjson bytes "$body_bytes" \
    --argjson elapsed "$elapsed" \
    --arg started "$(date -u -d "@$started" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$started" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$started")" \
    '{
      name:$name, backend:$backend, model:$model, status:$status, rc:$rc,
      bytes:$bytes, elapsed_sec:$elapsed, effort:$effort,
      error: (if $err=="" then null else $err end),
      started:$started
    }' >"$metafile"

  printf '%s:%s\n' "$stem" "$status"
}

_fanout_tally() {
  FANOUT_N_OK=0; FANOUT_N_FAIL=0; FANOUT_N_SKIP=0
  local line
  for line in "$@"; do
    case "$line" in
      *:ok) FANOUT_N_OK=$((FANOUT_N_OK + 1)) ;;
      *:unavailable) FANOUT_N_SKIP=$((FANOUT_N_SKIP + 1)) ;;
      *) FANOUT_N_FAIL=$((FANOUT_N_FAIL + 1)) ;;
    esac
  done
  if [ "$FANOUT_N_OK" -eq 0 ]; then
    FANOUT_OVERALL="failed"; FANOUT_EXIT=4
  elif [ "$FANOUT_N_FAIL" -gt 0 ]; then
    FANOUT_OVERALL="partial"; FANOUT_EXIT=3
  else
    FANOUT_OVERALL="ok"; FANOUT_EXIT=0
  fi
}

_fanout_write_summary() {
  local out_dir="$1" overall="$2" effort="$3" serial="$4" timeout_sec="$5"
  local n_ok="$6" n_fail="$7" n_skip="$8"
  shift 8
  local meta_arr='[]' stem
  for stem in "$@"; do
    if [ -f "$out_dir/${stem}.meta.json" ]; then
      meta_arr="$(jq -c --argjson a "$meta_arr" '$a + [.]' "$out_dir/${stem}.meta.json")"
    fi
  done
  jq -nc \
    --arg out "$out_dir" \
    --arg overall "$overall" \
    --arg effort "$effort" \
    --argjson serial "$serial" \
    --argjson timeout "$timeout_sec" \
    --argjson ok "$n_ok" \
    --argjson fail "$n_fail" \
    --argjson skip "$n_skip" \
    --argjson backends "$meta_arr" \
    --argjson prompt_bytes "$( [ -f "$out_dir/prompt.md" ] && wc -c <"$out_dir/prompt.md" | tr -d ' ' || echo 0 )" \
    --arg finished "$(date -Iseconds)" \
    '{
      tool:"agent-fanout",
      overall:$overall,
      out:$out,
      prompt_bytes:$prompt_bytes,
      effort:$effort,
      serial:$serial,
      timeout_sec:$timeout,
      counts:{ok:$ok, fail:$fail, unavailable:$skip},
      backends:$backends,
      finished:$finished
    }' >"$out_dir/summary.json"
}

# Parallel arrays of paths only: STEMS / BACKENDS / PROMPT_FILES
_fanout_dispatch() {
  local serial="$1" timeout_sec="$2" effort="$3" out_dir="$4"
  local results=() stem backend pfile line pids=() names=() i pid n
  n="${#FANOUT_JOB_STEMS[@]}"
  [ "$n" -ge 1 ] || return 2
  [ "${#FANOUT_JOB_BACKENDS[@]}" -eq "$n" ] && [ "${#FANOUT_JOB_PROMPT_FILES[@]}" -eq "$n" ] \
    || { printf 'fanout: job arrays length mismatch\n' >&2; return 5; }

  if [ "$serial" -eq 1 ] || [ "$n" -le 1 ]; then
    for i in $(seq 0 $((n - 1))); do
      line="$(_fanout_job_to_files \
        "${FANOUT_JOB_STEMS[$i]}" "${FANOUT_JOB_BACKENDS[$i]}" \
        "${FANOUT_JOB_PROMPT_FILES[$i]}" "$effort" "$out_dir" "$timeout_sec")"
      results+=("$line")
      fanout_log "  • $line"
    done
  else
    for i in $(seq 0 $((n - 1))); do
      stem="${FANOUT_JOB_STEMS[$i]}"
      (
        _fanout_job_to_files \
          "$stem" "${FANOUT_JOB_BACKENDS[$i]}" \
          "${FANOUT_JOB_PROMPT_FILES[$i]}" "$effort" "$out_dir" "$timeout_sec" \
          >"$out_dir/${stem}.wait"
      ) &
      pids+=("$!")
      names+=("$stem")
    done
    for i in "${!pids[@]}"; do
      pid="${pids[$i]}"; stem="${names[$i]}"
      wait "$pid" || true
      if [ -f "$out_dir/${stem}.wait" ]; then
        line="$(cat "$out_dir/${stem}.wait")"
      else
        line="${stem}:error"
      fi
      results+=("$line")
      fanout_log "  • $line"
      rm -f "$out_dir/${stem}.wait"
    done
  fi

  FANOUT_RESULTS=("${results[@]}")
  _fanout_tally "${results[@]}"
  _fanout_write_summary "$out_dir" "$FANOUT_OVERALL" "$effort" "$serial" "$timeout_sec" \
    "$FANOUT_N_OK" "$FANOUT_N_FAIL" "$FANOUT_N_SKIP" "${FANOUT_JOB_STEMS[@]}"
  fanout_log "done overall=$FANOUT_OVERALL ok=$FANOUT_N_OK fail=$FANOUT_N_FAIL out=$out_dir"
  return "$FANOUT_EXIT"
}

# --- same prompt → N backends -----------------------------------------------
fanout_run() {
  local backends_csv="" prompt="" prompt_file="" use_stdin=0
  local out_dir="" effort="" serial=0 timeout_sec="${FANOUT_TIMEOUT:-0}" prepend="" dry=0
  local single_print=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --backends) backends_csv="${2:-}"; shift 2 ;;
      --backend)
        if [ -n "$backends_csv" ]; then backends_csv="${backends_csv},${2:-}"
        else backends_csv="${2:-}"; fi
        shift 2 ;;
      --prompt) prompt="${2:-}"; shift 2 ;;
      --prompt-file) prompt_file="${2:-}"; shift 2 ;;
      --stdin) use_stdin=1; shift ;;
      --out|--out-dir) out_dir="${2:-}"; shift 2 ;;
      --effort) effort="${2:-}"; shift 2 ;;
      --serial) serial=1; shift ;;
      --parallel) serial=0; shift ;;
      --timeout) timeout_sec="${2:-0}"; shift 2 ;;
      --prepend) prepend="${2:-}"; shift 2 ;;
      --print) single_print=1; shift ;;
      --dry-run) dry=1; shift ;;
      *) printf 'fanout_run: unknown option %s\n' "$1" >&2; return 1 ;;
    esac
  done
  case "$timeout_sec" in ''|*[!0-9]*) timeout_sec=0 ;; esac

  _fanout_read_prompt "$prompt" "$prompt_file" "$use_stdin" \
    || { printf 'fanout_run: need exactly one non-empty --prompt / --prompt-file / --stdin\n' >&2; return 1; }
  if [ -n "$prepend" ]; then
    _FANOUT_PROMPT="${prepend}"$'\n\n'"${_FANOUT_PROMPT}"
  fi

  local available=()
  mapfile -t available < <(_fanout_resolve_backends "$backends_csv")
  [ "${#available[@]}" -ge 1 ] || { printf 'fanout_run: no usable backend\n' >&2; return 2; }
  [ "${#available[@]}" -eq 1 ] && serial=1

  if [ -z "$out_dir" ]; then
    out_dir="$(mktemp -d "${TMPDIR:-/tmp}/agent-fanout.XXXXXX")"
  else
    mkdir -p "$out_dir"
  fi
  out_dir="$(cd "$out_dir" && pwd)"
  FANOUT_OUT="$out_dir"
  printf '%s' "$_FANOUT_PROMPT" >"$out_dir/prompt.md"
  # One shared prompt file for all backends (paths only in job arrays).
  local shared_pf="$out_dir/prompt.md"

  fanout_log "backends=${available[*]} parallel=$([ "$serial" -eq 1 ] && echo no || echo yes) out=$out_dir"

  if [ "$dry" -eq 1 ]; then
    jq -nc \
      --arg out "$out_dir" \
      --arg effort "$effort" \
      --argjson serial "$serial" \
      --argjson timeout "$timeout_sec" \
      --argjson backends "$(printf '%s\n' "${available[@]}" | jq -R . | jq -s .)" \
      --argjson prompt_bytes "$(wc -c <"$shared_pf" | tr -d ' ')" \
      '{dry_run:true, out:$out, backends:$backends, serial:$serial,
        timeout_sec:$timeout, effort:$effort, prompt_bytes:$prompt_bytes}'
    FANOUT_EXIT=0
    return 0
  fi

  FANOUT_JOB_STEMS=()
  FANOUT_JOB_BACKENDS=()
  FANOUT_JOB_PROMPT_FILES=()
  local b
  for b in "${available[@]}"; do
    FANOUT_JOB_STEMS+=("$b")
    FANOUT_JOB_BACKENDS+=("$b")
    FANOUT_JOB_PROMPT_FILES+=("$shared_pf")
  done

  local rc=0
  _fanout_dispatch "$serial" "$timeout_sec" "$effort" "$out_dir" || rc=$?
  if [ "$single_print" -eq 1 ] && [ "${#available[@]}" -eq 1 ]; then
    cat "$out_dir/${available[0]}.md" 2>/dev/null || true
  fi
  return "$rc"
}

# --- heterogeneous jobs -----------------------------------------------------
# --job name|backend|prompt_file  (prompt_file = full prompt on disk)
fanout_run_jobs() {
  local out_dir="" effort="" serial=0 timeout_sec="${FANOUT_TIMEOUT:-0}"
  local job_specs=() jobs_file="" dry=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --out|--out-dir) out_dir="${2:-}"; shift 2 ;;
      --effort) effort="${2:-}"; shift 2 ;;
      --serial) serial=1; shift ;;
      --parallel) serial=0; shift ;;
      --timeout) timeout_sec="${2:-0}"; shift 2 ;;
      --job) job_specs+=("${2:-}"); shift 2 ;;
      --jobs-file) jobs_file="${2:-}"; shift 2 ;;
      --dry-run) dry=1; shift ;;
      *) printf 'fanout_run_jobs: unknown option %s\n' "$1" >&2; return 1 ;;
    esac
  done
  case "$timeout_sec" in ''|*[!0-9]*) timeout_sec=0 ;; esac

  if [ -n "$jobs_file" ]; then
    [ -f "$jobs_file" ] || { printf 'fanout_run_jobs: missing %s\n' "$jobs_file" >&2; return 1; }
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in ''|\#*) continue ;; esac
      job_specs+=("$line")
    done <"$jobs_file"
  fi
  [ "${#job_specs[@]}" -ge 1 ] || { printf 'fanout_run_jobs: no jobs\n' >&2; return 1; }
  [ -n "$out_dir" ] || out_dir="$(mktemp -d "${TMPDIR:-/tmp}/agent-fanout-jobs.XXXXXX")"
  mkdir -p "$out_dir"
  out_dir="$(cd "$out_dir" && pwd)"
  FANOUT_OUT="$out_dir"
  [ "${#job_specs[@]}" -eq 1 ] && serial=1

  FANOUT_JOB_STEMS=()
  FANOUT_JOB_BACKENDS=()
  FANOUT_JOB_PROMPT_FILES=()
  local spec name backend pfile rest
  for spec in "${job_specs[@]}"; do
    name="${spec%%|*}"
    rest="${spec#*|}"
    backend="${rest%%|*}"
    pfile="${rest#*|}"
    [ -n "$name" ] && [ -n "$backend" ] && [ -n "$pfile" ] \
      || { printf 'fanout_run_jobs: bad job (want name|backend|prompt_file): %s\n' "$spec" >&2; return 1; }
    [ -f "$pfile" ] || { printf 'fanout_run_jobs: missing prompt file %s\n' "$pfile" >&2; return 1; }
    if [ -n "${PROVIDER_MOCK:-}" ] || provider_available "$backend"; then
      FANOUT_JOB_STEMS+=("$name")
      FANOUT_JOB_BACKENDS+=("$(_provider_canonical "$backend")")
      FANOUT_JOB_PROMPT_FILES+=("$pfile")
    else
      fanout_log "skip job $name: backend $backend unavailable"
    fi
  done
  [ "${#FANOUT_JOB_STEMS[@]}" -ge 1 ] || { printf 'fanout_run_jobs: no usable jobs\n' >&2; return 2; }

  fanout_log "jobs=${#FANOUT_JOB_STEMS[@]} parallel=$([ "$serial" -eq 1 ] && echo no || echo yes) out=$out_dir"

  if [ "$dry" -eq 1 ]; then
    printf '%s\n' "${FANOUT_JOB_STEMS[@]}" | jq -R . | jq -s --arg out "$out_dir" \
      '{dry_run:true, out:$out, jobs:.}'
    return 0
  fi

  {
    echo "# fanout jobs"
    local i
    for i in "${!FANOUT_JOB_STEMS[@]}"; do
      echo "- ${FANOUT_JOB_STEMS[$i]} → ${FANOUT_JOB_BACKENDS[$i]} (${FANOUT_JOB_PROMPT_FILES[$i]})"
    done
  } >"$out_dir/prompt.md"

  _fanout_dispatch "$serial" "$timeout_sec" "$effort" "$out_dir"
}
