#!/usr/bin/env bash
# host-agent-invoke.sh — shared host headless CLI invoke (claude/codex/grok).
#
# Pure invoke concerns only: PATH, attention-skip, pane-env strip, host
# CODEX_HOME unset, prompt-via-file, read vs write flag profiles.
# Callers own worktrees, prompts, result-file contracts, and ticket state.
#
# Public:
#   host_agent_invoke_run --backend NAME --mode read|write --cwd DIR \
#     --prompt-file PATH [--add-dir PATH] [--log PATH] [--effort LEVEL] \
#     [--model ID] [--capture]
#     [--allow-tool RULE]... [--append-system-file F] [--max-turns N]   (read profile)
#     [--run-dir DIR [--run-id ID] [--launch-extra JSON_FILE]
#      [--sink-py FILE --sink-arg ARG]] [--resume SESSION_ID [--fork]]
#
#   --run-dir  → observability: writes <run>.launch.json before the CLI starts,
#                switches the CLI to its event stream, tees it to
#                <run>.stream.jsonl and writes the run record <run>.json
#                (lib/run_observe.py). Exclusive with --capture.
#   --resume / --fork → continue or branch a prior backend session by id.
#
#   --capture  → CLI stdout is printed on this function's stdout (stderr→log
#                or /dev/null). Used by review providers that post-process text.
#   without --capture → stdout+stderr go to --log (default /dev/null); ticket style.
#
# Env:
#   HOST_AGENT_INVOKE_MOCK=1  → no real CLI; append one JSON line to trace; exit 0
#   HOST_AGENT_INVOKE_TRACE   → trace path (JSONL)
#   HOST_AGENT_INVOKE_MOCK_STREAM / _MOCK_RC → under MOCK + --run-dir, feed this
#                recorded CLI stream through run_observe.py (offline tests)
#
# shellcheck shell=bash

if [ -n "${_HOST_AGENT_INVOKE_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
_HOST_AGENT_INVOKE_LOADED=1

_HOST_AGENT_INVOKE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Non-login agent shells often miss host CLIs.
case ":${PATH:-}:" in *":${HOME}/.local/bin:"*) ;; *)
  export PATH="${HOME}/.local/bin${PATH:+:$PATH}" ;;
esac
case ":${PATH:-}:" in *":${HOME}/.grok/bin:"*) ;; *)
  export PATH="${HOME}/.grok/bin${PATH:+:$PATH}" ;;
esac

host_agent_invoke_root() {
  cd "$_HOST_AGENT_INVOKE_LIB_DIR/.." && pwd
}

_host_agent_codex_bin() {
  if command -v codex >/dev/null 2>&1; then command -v codex; return 0; fi
  local c
  for c in "$HOME/.local/bin/codex" "$HOME/.codex/bin/codex"; do
    [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

_host_agent_trace() {
  local line=$1
  if [ -n "${HOST_AGENT_INVOKE_TRACE:-}" ]; then
    mkdir -p "$(dirname "$HOST_AGENT_INVOKE_TRACE")"
    printf '%s\n' "$line" >>"$HOST_AGENT_INVOKE_TRACE"
  fi
}

# Grok read profile: plan mode + read-only command allowlist + no web.
# Plain "no --always-approve" is NOT read-only for headless grok (verified by
# fe1 2026-11-20: it still wrote files). Keep this list to commands without
# side effects; anything not listed stays denied by plan mode.
HOST_AGENT_GROK_READ_ALLOW=(
  'Bash(git log:*)'
  'Bash(git show:*)'
  'Bash(git diff:*)'
  'Bash(git status:*)'
  'Bash(git blame:*)'
  'Bash(git ls-files:*)'
  'Bash(git grep:*)'
  'Bash(git rev-parse:*)'
  'Bash(ls:*)'
  'Bash(cat:*)'
  'Bash(head:*)'
  'Bash(tail:*)'
  'Bash(wc:*)'
  'Bash(rg:*)'
  'Bash(grep:*)'
)

# Fill _HOST_AGENT_GROK_ARGV (grok args after the binary) for MODE.
# Args: mode prompt_file model effort
_host_agent_grok_argv() {
  local mode=$1 prompt_file=$2 model=$3 effort=$4 observe=${5:-0} resume=${6:-} fork=${7:-0} rule
  local fmt=json
  [ "$observe" = "1" ] && fmt=streaming-json
  _HOST_AGENT_GROK_ARGV=(--prompt-file "$prompt_file")
  if [ -n "$resume" ]; then
    _HOST_AGENT_GROK_ARGV+=(--resume "$resume")
    [ "$fork" = "1" ] && _HOST_AGENT_GROK_ARGV+=(--fork-session)
  fi
  if [ "$mode" = "write" ]; then
    _HOST_AGENT_GROK_ARGV+=(--always-approve)
    [ "$observe" = "1" ] && _HOST_AGENT_GROK_ARGV+=(--output-format "$fmt")
  else
    _HOST_AGENT_GROK_ARGV+=(--output-format "$fmt" --permission-mode plan --disable-web-search)
    for rule in "${HOST_AGENT_GROK_READ_ALLOW[@]}"; do
      _HOST_AGENT_GROK_ARGV+=(--allow "$rule")
    done
    for rule in ${_HOST_AGENT_ALLOW[@]+"${_HOST_AGENT_ALLOW[@]}"}; do
      case "$rule" in Bash\(*) _HOST_AGENT_GROK_ARGV+=(--allow "$rule") ;; esac
    done
  fi
  [ -n "$model" ] && _HOST_AGENT_GROK_ARGV+=(-m "$model")
  [ -n "$effort" ] && _HOST_AGENT_GROK_ARGV+=(--reasoning-effort "$effort")
  return 0
}

# Build the full CLI argv (binary first) into _HOST_AGENT_ARGV.
# Args: backend mode model effort add_dir observe resume fork
# observe=1 switches every backend to its machine-readable event stream
# (claude stream-json, codex --json, grok streaming-json) for run_observe.py.
_host_agent_cli_argv() {
  local backend=$1 mode=$2 model=$3 effort=$4 add_dir=$5 observe=$6 resume=$7 fork=$8
  _HOST_AGENT_ARGV=()
  case "$backend" in
    claude)
      _HOST_AGENT_ARGV=(claude -p)
      if [ "$mode" = "write" ]; then
        _HOST_AGENT_ARGV+=(--permission-mode bypassPermissions)
      elif [ -n "${_HOST_AGENT_ALLOW[*]:-}" ]; then
        _HOST_AGENT_ARGV+=(--permission-mode plan --allowed-tools "${_HOST_AGENT_ALLOW[@]}")
      else
        _HOST_AGENT_ARGV+=(--permission-mode plan --allowed-tools Read Grep Glob)
      fi
      [ -n "${_HOST_AGENT_SYSTEM_TEXT:-}" ] && _HOST_AGENT_ARGV+=(--append-system-prompt "$_HOST_AGENT_SYSTEM_TEXT")
      [ -n "${_HOST_AGENT_MAX_TURNS:-}" ] && _HOST_AGENT_ARGV+=(--max-turns "$_HOST_AGENT_MAX_TURNS")
      if [ "$observe" = "1" ]; then
        _HOST_AGENT_ARGV+=(--output-format stream-json --verbose)
      elif [ "$mode" = "write" ]; then
        _HOST_AGENT_ARGV+=(--output-format text)
      else
        _HOST_AGENT_ARGV+=(--output-format json)
      fi
      if [ -n "$resume" ]; then
        _HOST_AGENT_ARGV+=(--resume "$resume")
        [ "$fork" = "1" ] && _HOST_AGENT_ARGV+=(--fork-session)
      fi
      [ -n "$model" ] && _HOST_AGENT_ARGV+=(--model "$model")
      [ -n "$effort" ] && _HOST_AGENT_ARGV+=(--effort "$effort")
      [ -n "$add_dir" ] && [ "$mode" = "write" ] && _HOST_AGENT_ARGV+=(--add-dir "$add_dir")
      _HOST_AGENT_ARGV+=(--settings '{"disableAllHooks":true}')
      ;;
    codex)
      local bin
      bin="$(_host_agent_codex_bin)" || bin=codex
      _HOST_AGENT_ARGV=("$bin" exec)
      if [ -n "$resume" ]; then
        # `exec resume|fork` take no --full-auto/--sandbox; same profile via -c.
        if [ "$fork" = "1" ]; then _HOST_AGENT_ARGV+=(fork); else _HOST_AGENT_ARGV+=(resume); fi
        if [ "$mode" = "write" ]; then
          _HOST_AGENT_ARGV+=(-c 'sandbox_mode="workspace-write"' -c 'approval_policy="never"')
        else
          _HOST_AGENT_ARGV+=(-c 'sandbox_mode="read-only"' -c 'approval_policy="never"')
        fi
        _HOST_AGENT_ARGV+=(--json)
      elif [ "$mode" = "write" ]; then
        _HOST_AGENT_ARGV+=(--full-auto)
        [ "$observe" = "1" ] && _HOST_AGENT_ARGV+=(--json)
      else
        _HOST_AGENT_ARGV+=(--json --sandbox read-only)
      fi
      [ -n "$model" ] && _HOST_AGENT_ARGV+=(-c "model=\"$model\"")
      [ -n "$effort" ] && _HOST_AGENT_ARGV+=(-c "model_reasoning_effort=\"$effort\"")
      [ -n "$resume" ] && _HOST_AGENT_ARGV+=("$resume")
      _HOST_AGENT_ARGV+=(-)
      ;;
    grok)
      _HOST_AGENT_ARGV=(grok "${_HOST_AGENT_GROK_ARGV[@]}")
      ;;
  esac
}

# Run one headless host CLI. Returns CLI exit (0 under MOCK).
host_agent_invoke_run() {
  local backend="" mode="read" cwd="" prompt_file="" add_dir="" log_path="" effort="" model=""
  local capture=0 run_dir="" run_id="" resume="" fork=0 launch_extra="" sink_py="" sink_arg="" system_file=""
  local -a _HOST_AGENT_ALLOW=()
  local _HOST_AGENT_MAX_TURNS="" _HOST_AGENT_SYSTEM_TEXT=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --backend) backend="${2:-}"; shift 2 ;;
      --mode) mode="${2:-}"; shift 2 ;;
      --cwd) cwd="${2:-}"; shift 2 ;;
      --prompt-file) prompt_file="${2:-}"; shift 2 ;;
      --add-dir) add_dir="${2:-}"; shift 2 ;;
      --log) log_path="${2:-}"; shift 2 ;;
      --effort) effort="${2:-}"; shift 2 ;;
      --model) model="${2:-}"; shift 2 ;;
      --capture) capture=1; shift ;;
      --run-dir) run_dir="${2:-}"; shift 2 ;;
      --run-id) run_id="${2:-}"; shift 2 ;;
      --resume) resume="${2:-}"; shift 2 ;;
      --fork) fork=1; shift ;;
      --launch-extra) launch_extra="${2:-}"; shift 2 ;;
      --sink-py) sink_py="${2:-}"; shift 2 ;;
      --sink-arg) sink_arg="${2:-}"; shift 2 ;;
      --allow-tool) _HOST_AGENT_ALLOW+=("${2:-}"); shift 2 ;;
      --append-system-file) system_file="${2:-}"; shift 2 ;;
      --max-turns) _HOST_AGENT_MAX_TURNS="${2:-}"; shift 2 ;;
      *)
        printf 'host_agent_invoke_run: unknown option %s\n' "$1" >&2
        return 1
        ;;
    esac
  done

  [ -n "$backend" ] || { printf 'host_agent_invoke_run: --backend required\n' >&2; return 1; }
  [ -n "$cwd" ] || { printf 'host_agent_invoke_run: --cwd required\n' >&2; return 1; }
  [ -n "$prompt_file" ] || { printf 'host_agent_invoke_run: --prompt-file required\n' >&2; return 1; }
  [ -f "$prompt_file" ] || { printf 'host_agent_invoke_run: prompt missing: %s\n' "$prompt_file" >&2; return 1; }
  [ -d "$cwd" ] || { printf 'host_agent_invoke_run: cwd missing: %s\n' "$cwd" >&2; return 1; }

  case "$mode" in read|write) ;; *)
    printf 'host_agent_invoke_run: --mode must be read|write (got %s)\n' "$mode" >&2
    return 1
    ;;
  esac
  case "$backend" in claude|codex|grok) ;; *)
    printf 'host_agent_invoke_run: unknown backend %s (claude|codex|grok)\n' "$backend" >&2
    return 1
    ;;
  esac
  local observe=0
  if [ -n "$run_dir" ]; then
    [ "$capture" -eq 0 ] || { printf 'host_agent_invoke_run: --run-dir and --capture are exclusive\n' >&2; return 1; }
    [ -n "$run_id" ] || run_id="run-$(date -u +%Y%m%d-%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
    observe=1
  fi
  if [ "$fork" -eq 1 ] && [ -z "$resume" ]; then
    printf 'host_agent_invoke_run: --fork needs --resume ID\n' >&2
    return 1
  fi

  if [ -n "$system_file" ]; then
    [ -f "$system_file" ] || { printf 'host_agent_invoke_run: system file missing: %s\n' "$system_file" >&2; return 1; }
    if [ "$backend" = "claude" ]; then
      _HOST_AGENT_SYSTEM_TEXT="$(cat "$system_file")"
    else
      # no append-system flag on codex/grok: prepend it to a copy of the prompt
      local merged="${prompt_file}.with-system.md"
      { cat "$system_file"; printf '\n\n---\n\n'; cat "$prompt_file"; } >"$merged"
      prompt_file="$merged"
    fi
  fi

  # argv is recorded for grok (built before MOCK return so tests can assert it).
  local -a _HOST_AGENT_GROK_ARGV=()
  [ "$backend" = "grok" ] && _host_agent_grok_argv "$mode" "$prompt_file" "$model" "$effort" "$observe" "$resume" "$fork"
  local -a _HOST_AGENT_ARGV=()
  _host_agent_cli_argv "$backend" "$mode" "$model" "$effort" "$add_dir" "$observe" "$resume" "$fork"

  local trace_line
  trace_line="$(python3 -c 'import json,sys; print(json.dumps({"backend":sys.argv[1],"mode":sys.argv[2],"cwd":sys.argv[3],"prompt_file":sys.argv[4],"add_dir":sys.argv[5],"mock":bool(sys.argv[6]=="1"),"capture":bool(sys.argv[7]=="1"),"run_id":sys.argv[8] or None,"resume":sys.argv[9] or None,"fork":sys.argv[10]=="1","argv":sys.argv[11:]}))' \
    "$backend" "$mode" "$cwd" "$prompt_file" "${add_dir:-}" "${HOST_AGENT_INVOKE_MOCK:-0}" "$capture" "$run_id" "$resume" "$fork" "${_HOST_AGENT_GROK_ARGV[@]}")"
  _host_agent_trace "$trace_line"

  local observe_py="$_HOST_AGENT_INVOKE_LIB_DIR/run_observe.py"
  local -a sink_args=()
  [ -n "$sink_py" ] && sink_args=(--sink-py "$sink_py" --sink-arg "$sink_arg")
  if [ "$observe" -eq 1 ]; then
    mkdir -p "$run_dir"
    python3 "$observe_py" launch --run-dir "$run_dir" --run-id "$run_id" \
      --backend "$backend" --mode "$mode" --cwd "$cwd" --prompt-file "$prompt_file" \
      --model "$model" --effort "$effort" --add-dir "$add_dir" \
      ${resume:+--resume "$resume"} $( [ "$fork" -eq 1 ] && printf -- '--fork' ) \
      ${launch_extra:+--extra "$launch_extra"} "${sink_args[@]}" \
      -- "${_HOST_AGENT_ARGV[@]}" \
      || printf 'host_agent_invoke_run: launch record failed (continuing)\n' >&2
  fi

  if [ "${HOST_AGENT_INVOKE_MOCK:-0}" = "1" ]; then
    if [ "$observe" -eq 1 ]; then
      local mock_rc="${HOST_AGENT_INVOKE_MOCK_RC:-0}" rcf="$run_dir/$run_id.rc"
      printf '%s\n' "$mock_rc" >"$rcf"
      if [ -n "${HOST_AGENT_INVOKE_MOCK_STREAM:-}" ] && [ -f "$HOST_AGENT_INVOKE_MOCK_STREAM" ]; then
        python3 "$observe_py" parse --run-dir "$run_dir" --run-id "$run_id" --backend "$backend" \
          --rc-file "$rcf" "${sink_args[@]}" <"$HOST_AGENT_INVOKE_MOCK_STREAM" 2>>"${log_path:-/dev/null}"
      else
        python3 "$observe_py" parse --run-dir "$run_dir" --run-id "$run_id" --backend "$backend" \
          --rc-file "$rcf" "${sink_args[@]}" </dev/null 2>>"${log_path:-/dev/null}"
      fi
      rm -f "$rcf"
      return "$mock_rc"
    fi
    if [ "$capture" -eq 1 ]; then
      # Shape-stable empty payload so callers' jq pipes do not crash.
      case "$backend" in
        claude) printf '%s' '{"result":""}' ;;
        grok) printf '%s' '{"text":""}' ;;
        *) printf '%s' '' ;;
      esac
    fi
    return 0
  fi

  local rc=0
  _host_agent_run_cli() {
    cd "$cwd" || exit 3
    if [ "$backend" = "codex" ]; then
      [ -n "$(_host_agent_codex_bin)" ] || exit 3
    fi
    local -a env_args=(env -u TMUX -u TMUX_PANE -u WEZTERM_PANE -u WEZTERM_UNIX_SOCKET)
    [ "$backend" = "codex" ] && env_args+=(-u CODEX_HOME)
    env_args+=(AGENT_ATTENTION_SKIP=1 HOST_AGENT_HEADLESS=1)
    [ "$mode" = "write" ] && env_args+=(TICKET_HEADLESS=1)
    if [ "$backend" = "grok" ]; then
      # grok reads --prompt-file itself
      "${env_args[@]}" "${_HOST_AGENT_ARGV[@]}"
    else
      # Prompt via stdin (avoids ARG_MAX).
      "${env_args[@]}" "${_HOST_AGENT_ARGV[@]}" <"$prompt_file"
    fi
  }

  if [ "$observe" -eq 1 ]; then
    local fifo pidf rcf parser_pid cli_pid
    fifo="$run_dir/$run_id.fifo"; pidf="$run_dir/$run_id.pid"; rcf="$run_dir/$run_id.rc"
    rm -f "$fifo" "$pidf" "$rcf"
    mkfifo "$fifo"
    python3 "$observe_py" parse --run-dir "$run_dir" --run-id "$run_id" --backend "$backend" \
      --pid-file "$pidf" --rc-file "$rcf" "${sink_args[@]}" \
      <"$fifo" 2>>"${log_path:-/dev/null}" &
    parser_pid=$!
    _host_agent_run_cli >"$fifo" 2>>"${log_path:-/dev/null}" &
    cli_pid=$!
    printf '%s\n' "$cli_pid" >"$pidf"
    wait "$cli_pid" || rc=$?
    printf '%s\n' "$rc" >"$rcf"
    wait "$parser_pid" 2>/dev/null || true
    rm -f "$fifo" "$pidf" "$rcf"
  elif [ "$capture" -eq 1 ]; then
    _host_agent_run_cli 2>"${log_path:-/dev/null}" || rc=$?
  else
    _host_agent_run_cli >"${log_path:-/dev/null}" 2>&1 || rc=$?
  fi

  return "$rc"
}
