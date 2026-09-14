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
#
#   --capture  → CLI stdout is printed on this function's stdout (stderr→log
#                or /dev/null). Used by review providers that post-process text.
#   without --capture → stdout+stderr go to --log (default /dev/null); ticket style.
#
# Env:
#   HOST_AGENT_INVOKE_MOCK=1  → no real CLI; append one JSON line to trace; exit 0
#   HOST_AGENT_INVOKE_TRACE   → trace path (JSONL)
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

# Run one headless host CLI. Returns CLI exit (0 under MOCK).
host_agent_invoke_run() {
  local backend="" mode="read" cwd="" prompt_file="" add_dir="" log_path="" effort="" model=""
  local capture=0
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

  local trace_line
  trace_line="$(python3 -c 'import json,sys; print(json.dumps({"backend":sys.argv[1],"mode":sys.argv[2],"cwd":sys.argv[3],"prompt_file":sys.argv[4],"add_dir":sys.argv[5],"mock":bool(sys.argv[6]=="1"),"capture":bool(sys.argv[7]=="1")}))' \
    "$backend" "$mode" "$cwd" "$prompt_file" "${add_dir:-}" "${HOST_AGENT_INVOKE_MOCK:-0}" "$capture")"
  _host_agent_trace "$trace_line"

  if [ "${HOST_AGENT_INVOKE_MOCK:-0}" = "1" ]; then
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
    cd "$cwd"
    case "$backend" in
      claude)
        # Claude has no --prompt-file; -p with no argv prompt reads stdin (avoids ARG_MAX).
        if [ "$mode" = "write" ]; then
          env -u TMUX -u TMUX_PANE -u WEZTERM_PANE -u WEZTERM_UNIX_SOCKET \
            AGENT_ATTENTION_SKIP=1 DELEGATE_HEADLESS=1 HOST_AGENT_HEADLESS=1 \
            claude -p --permission-mode bypassPermissions \
              --output-format text \
              ${model:+--model "$model"} \
              ${effort:+--effort "$effort"} \
              ${add_dir:+--add-dir "$add_dir"} \
              --settings '{"disableAllHooks":true}' \
              <"$prompt_file"
        else
          env -u TMUX -u TMUX_PANE -u WEZTERM_PANE -u WEZTERM_UNIX_SOCKET \
            AGENT_ATTENTION_SKIP=1 HOST_AGENT_HEADLESS=1 \
            claude -p --output-format json \
              --permission-mode plan \
              --allowed-tools Read Grep Glob \
              ${model:+--model "$model"} \
              ${effort:+--effort "$effort"} \
              --settings '{"disableAllHooks":true}' \
              <"$prompt_file"
        fi
        ;;
      codex)
        local bin
        bin="$(_host_agent_codex_bin)" || exit 3
        if [ "$mode" = "write" ]; then
          env -u CODEX_HOME -u TMUX -u TMUX_PANE -u WEZTERM_PANE -u WEZTERM_UNIX_SOCKET \
            AGENT_ATTENTION_SKIP=1 DELEGATE_HEADLESS=1 HOST_AGENT_HEADLESS=1 \
            "$bin" exec --full-auto \
              ${model:+-c model="$model"} \
              ${effort:+-c model_reasoning_effort="$effort"} \
              - <"$prompt_file"
        else
          env -u CODEX_HOME -u TMUX -u TMUX_PANE -u WEZTERM_PANE -u WEZTERM_UNIX_SOCKET \
            AGENT_ATTENTION_SKIP=1 HOST_AGENT_HEADLESS=1 \
            "$bin" exec --json --sandbox read-only \
              ${model:+-c model="$model"} \
              ${effort:+-c model_reasoning_effort="$effort"} \
              - <"$prompt_file"
        fi
        ;;
      grok)
        if [ "$mode" = "write" ]; then
          env -u TMUX -u TMUX_PANE -u WEZTERM_PANE -u WEZTERM_UNIX_SOCKET \
            AGENT_ATTENTION_SKIP=1 DELEGATE_HEADLESS=1 HOST_AGENT_HEADLESS=1 \
            grok --prompt-file "$prompt_file" --always-approve \
              ${model:+-m "$model"} \
              ${effort:+--reasoning-effort "$effort"}
        else
          env -u TMUX -u TMUX_PANE -u WEZTERM_PANE -u WEZTERM_UNIX_SOCKET \
            AGENT_ATTENTION_SKIP=1 HOST_AGENT_HEADLESS=1 \
            grok --prompt-file "$prompt_file" --output-format json \
              ${model:+-m "$model"} \
              ${effort:+--reasoning-effort "$effort"}
        fi
        ;;
    esac
  }

  if [ "$capture" -eq 1 ]; then
    _host_agent_run_cli 2>"${log_path:-/dev/null}" || rc=$?
  else
    _host_agent_run_cli >"${log_path:-/dev/null}" 2>&1 || rc=$?
  fi

  return "$rc"
}
