#!/usr/bin/env bash
# agent-launcher.sh — entry point for managed agent panes spawned by tmux.
#
# Bash-only: the sourced runtime-env-lib.sh uses `[[`, `${var:0:1}` substring
# expansion, and `shopt -s nullglob`. Don't switch this shebang back to `sh`
# without also rewriting the lib in pure POSIX.
#
# Why this script exists:
#   Several launch paths fork the agent via `tmux new-window <cmd>` / tmux
#   respawn-pane, where tmux runs `<cmd>` through a plain `sh -c` direct
#   from the server process. That `sh` traverses no shell rc files, so
#   secrets exported by the user's ~/.zshrc (files under
#   ~/.config/shell-env.d/*.env, etc.) never reach the agent or its child
#   scripts — leading to e.g. `npm view @coco/x-server` returning 401
#   inside the agent's Bash tool while the same command works in the
#   user's shell.
#
#   This script is the one place we explicitly load runtime env files
#   before exec'ing into the resume-or-fresh agent command. All managed
#   profiles in config/worktree-task.env reference it via
#   ${WEZDECK_REPO}/scripts/runtime/agent-launcher.sh <agent>, so every
#   path (Alt+g on-demand, refresh-current-window, tab-overflow,
#   workspace first-open) shares the same env view.
#
# Usage:
#   agent-launcher.sh <claude|claude-sub2api|claude-kimi|codex|grok|agy>
#
# Claude auth profiles:
#   claude            OAuth / subscription (team or individual). Gateway
#                     env vars are cleared so a leaked ANTHROPIC_* from
#                     the parent shell cannot silently override OAuth.
#   claude-sub2api    API gateway via ANTHROPIC_BASE_URL + token from a
#                     dedicated env file (default
#                     ~/.config/claude-profiles/sub2api.env). Do NOT put
#                     those keys in shell-env.d — that would override
#                     every claude pane.
#   claude-kimi       Kimi API via its Anthropic-compatible endpoint. Credentials
#                     live in ~/.config/claude-profiles/kimi.env.
#
# Phone sync via Happy was removed (2026-07): remote work goes through
# OpenClaw (Feishu / ACP / temporary tmux control). See
# docs/presentations/ai-dev-environment-evolution.md (v6) and
# docs/mobile-access.md.

set -eu

script_dir="$(cd "$(dirname "$0")" && pwd -P)"

# Manual TUI invocations keep the caller's CLI arguments and configuration.
if [[ "${1:-}" == codex && "${2:-}" == --interactive ]]; then
  shift 2
  for arg in "$@"; do
    case "$arg" in
      --) break ;;
      --remote|--remote=*|--no-daemon) exec codex "$@" ;;
    esac
  done
  exec codex --no-daemon "$@"
fi

# An item/workspace override is injected as an inline environment assignment
# by Lua or resume-command.sh. Preserve it across the shared env load so the
# more specific launch context wins over the machine default.
permission_override_set=0
permission_override=""
if [[ -n "${MANAGED_AGENT_PERMISSION_PROFILE+x}" ]]; then
  permission_override_set=1
  permission_override="$MANAGED_AGENT_PERMISSION_PROFILE"
fi
# shellcheck disable=SC1091
. "$script_dir/runtime-env-lib.sh"
runtime_env_load_managed
if (( permission_override_set )); then
  MANAGED_AGENT_PERMISSION_PROFILE="$permission_override"
  export MANAGED_AGENT_PERMISSION_PROFILE
fi
runtime_env_add_user_cli_paths
# shellcheck disable=SC1091
. "$script_dir/runtime-log-lib.sh" 2>/dev/null || true
WEZTERM_RUNTIME_LOG_SOURCE="${WEZTERM_RUNTIME_LOG_SOURCE:-agent-launcher.sh}"

agent="${1:-}"

_launcher_log_error() {
  local message="$1"
  shift
  if declare -F runtime_log_error >/dev/null 2>&1; then
    runtime_log_error primary_pane "$message" "$@" || true
  fi
}

if [[ -n "${2:-}" ]]; then
  printf 'agent-launcher: unexpected argument %s (Happy wrap removed)\n' "$2" >&2
  printf 'usage: agent-launcher.sh <claude|claude-sub2api|claude-kimi|codex|grok|agy>\n' >&2
  _launcher_log_error "agent launcher failed" \
    "reason=unexpected_argument" "arg=$2" "agent=${agent:-}" "cwd=$PWD"
  exit 1
fi

# Normalize underscore form from managed_cli / web profile ids
# (claude_kimi, claude_sub2api) to the launcher's hyphenated names.
case "$agent" in
  claude_sub2api) agent='claude-sub2api' ;;
  claude_kimi) agent='claude-kimi' ;;
esac

# Visible boot cue. Until the agent CLI paints its first frame, the pane
# is blank — that's the shell-chain forks (~150ms, mainly `zsh -ilc`
# inheriting interactive PATH) plus the agent's own session-resume load
# (0.5-3s for `claude --continue`, similar for `codex resume --last`).
# Printing one dim line turns "blank pane for several seconds" into
# "pane shows what it's doing"; the agent's first paint typically clears
# the screen, so the banner is only visible while it's actually useful.
# This script is the universal terminus for every managed-agent launch
# path (workspace first-open, refresh-current-window, Alt+g on-demand,
# tab-overflow cold-spawn, worktree-task), so the cue lands once
# regardless of which entry point the user took. Disable with
# WEZTERM_NO_LOADING_BANNER=1 if it ever interferes.
print_loading_banner() {
  [[ -t 1 ]] || return 0
  [[ "${WEZTERM_NO_LOADING_BANNER:-}" == "1" ]] && return 0

  local label="$1"
  local mode="${2:-base}"
  [[ -n "$label" ]] || label="agent"

  # \033[2J\033[H = clear + home so the banner anchors at top-left even
  # if the parent shell painted a prompt bit before this. Two newlines
  # of leading padding so the banner sits a couple rows down instead of
  # hugging the very top edge.
  printf '\033[2J\033[H\n\n  \033[2;36mLoading %s ...\033[0m\n  \033[2;36mMode: %s\033[0m\n' \
    "$label" "$mode"
}

# shellcheck disable=SC1091
. "$script_dir/agent-claude-sub2api-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/agent-workspace-trust-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/agent-otel-lib.sh"

loading_mode="base"
if [[ -n "${MANAGED_AGENT_PERMISSION_PROFILE:-}" ]]; then
  loading_mode="$MANAGED_AGENT_PERMISSION_PROFILE"
fi
print_loading_banner "$agent" "$loading_mode"

# Workflow breadcrumb: every managed primary pane boots as resume-attempt;
# the || branch logs resume_fallback_fresh when continue/resume finds nothing.
log_resume_boot() {
  local name="$1"
  local permission_profile="${2:-base}"
  local permission_resolution="${3:-base}"
  if declare -F runtime_log_info >/dev/null 2>&1; then
    runtime_log_info primary_pane "agent resume boot" \
      "agent=$name" "mode=resume_attempt" \
      "permission_profile=$permission_profile" \
      "permission_resolution=$permission_resolution" "cwd=$PWD" || true
  fi
}

# Managed panes are spawned by tmux's plain sh -c and therefore do not inherit
# interactive zsh PATH setup. runtime_env_add_user_cli_paths has already
# injected the stable user CLI directories before this lookup.
resolve_agent_binary() {
  local name="$1"
  local resolved=""

  resolved="$(command -v "$name" 2>/dev/null || true)"
  if [[ "$resolved" == /* && -x "$resolved" ]]; then
    printf '%s\n' "$resolved"
    return 0
  fi
  return 1
}

require_agent_binary() {
  local name="$1"
  local resolved=""
  resolved="$(resolve_agent_binary "$name" || true)"
  if [[ -z "$resolved" ]]; then
    printf 'agent-launcher: %s not found on managed user CLI PATH\n' "$name" >&2
    _launcher_log_error "agent launcher failed" \
      "reason=agent_not_found" "agent=$name" "cwd=$PWD"
    return 127
  fi
  printf '%s\n' "$resolved"
}

# Called from inside `sh -c` fallback — keep argv tiny and best-effort.
fallback_log_script="$script_dir/agent-resume-fallback-log.sh"

# Web-managed model choice is scoped to this managed profile. The file is a
# single validated scalar written by agent_profiles.go; read it as data, never
# source it into the shell.
managed_model_args=()
load_managed_model_override() {
  local profile="${1//-/_}"
  local path="${HOME}/.config/wezdeck/agent-models/${profile}.env"
  local line="" model=""
  [[ -r "$path" ]] || return 0
  IFS= read -r line < "$path" || true
  [[ "$line" == MODEL="'"*"'" ]] || return 0
  model="${line#MODEL=\'}"
  model="${model%\'}"
  [[ "$model" =~ ^[[:graph:]]+$ && ${#model} -le 100 ]] || return 0
  managed_model_args=(--model "$model")
}

check_managed_profile_enabled() {
  local profile="${1//-/_}"
  local path="$HOME/.config/wezdeck/agent-profiles/${profile}.json"
  local disabled=""
  case "$profile" in
    claude|claude_sub2api|claude_kimi|codex|grok|agy) ;;
    *) return 0 ;;
  esac
  [[ -e "$path" ]] || return 0
  if [[ ! -r "$path" ]] || ! command -v jq >/dev/null 2>&1 ||
      ! disabled="$(jq -r 'if type == "object" and (.disabled == null or (.disabled | type) == "boolean") then (.disabled // false) else error("invalid settings") end' "$path" 2>/dev/null)"; then
    printf 'agent-launcher: cannot read profile settings for %s\n' "$profile" >&2
    _launcher_log_error "agent launcher failed" "reason=profile_settings_invalid" "profile=$profile" "cwd=$PWD"
    return 1
  fi
  if [[ "$disabled" == true ]]; then
    printf 'agent-launcher: profile %s is disabled in WezDeck\n' "$profile" >&2
    _launcher_log_error "agent launcher blocked" "reason=profile_disabled" "profile=$profile" "cwd=$PWD"
    return 1
  fi
}

ensure_codex_permission_overlay() {
  local profile="$1"
  local profile_file="${CODEX_HOME:-$HOME/.codex}/${profile}.config.toml"
  local applier="$script_dir/../dev/apply-codex-permission-profiles.sh"

  # Always apply: refreshes managed permission keys from the repo template and
  # converts any leftover symlink into a host-owned regular file.
  if [[ -x "$applier" ]]; then
    if ! "$applier" "$profile" >/dev/null 2>&1; then
      printf 'agent-launcher: failed to apply Codex permission overlay: %s\n' \
        "$profile" >&2
      _launcher_log_error "agent launcher failed" \
        "reason=codex_permission_overlay_apply_failed" \
        "profile=$profile" "expected=$profile_file" "cwd=$PWD"
      return 1
    fi
  fi

  if [[ -f "$profile_file" && ! -L "$profile_file" ]]; then
    return 0
  fi
  printf 'agent-launcher: Codex permission overlay unavailable: %s\n' \
    "$profile_file" >&2
  _launcher_log_error "agent launcher failed" \
    "reason=codex_permission_overlay_missing" \
    "profile=$profile" "expected=$profile_file" "cwd=$PWD"
  return 1
}

resolve_claude_permission() {
  CLAUDE_PERMISSION_ARGS=()
  CLAUDE_PERMISSION_PROFILE="${MANAGED_AGENT_PERMISSION_PROFILE:-}"
  CLAUDE_PERMISSION_RESOLUTION=base
  case "$CLAUDE_PERMISSION_PROFILE" in
    ''|auto) ;;
    full-access)
      CLAUDE_PERMISSION_ARGS=(--permission-mode bypassPermissions)
      CLAUDE_PERMISSION_RESOLUTION=cli
      ;;
    *)
      if declare -F runtime_log_warn >/dev/null 2>&1; then
        runtime_log_warn primary_pane "unknown Claude permission profile; using base config" \
          "profile=$CLAUDE_PERMISSION_PROFILE" "allowed=auto,full-access" || true
      fi
      CLAUDE_PERMISSION_PROFILE=""
      ;;
  esac
}

resolve_grok_permission() {
  GROK_PERMISSION_ARGS=()
  GROK_PERMISSION_PROFILE="${MANAGED_AGENT_PERMISSION_PROFILE:-}"
  GROK_PERMISSION_RESOLUTION=base
  case "$GROK_PERMISSION_PROFILE" in
    ''|auto) ;;
    full-access)
      GROK_PERMISSION_ARGS=(--always-approve)
      GROK_PERMISSION_RESOLUTION=cli
      ;;
    *)
      if declare -F runtime_log_warn >/dev/null 2>&1; then
        runtime_log_warn primary_pane "unknown Grok permission profile; using base config" \
          "profile=$GROK_PERMISSION_PROFILE" "allowed=auto,full-access" || true
      fi
      GROK_PERMISSION_PROFILE=""
      ;;
  esac
}

# Fallback re-paint: when `--continue` (or `resume --last`) finds no
# session, the CLI prints "No conversation found to continue" to the
# primary screen and exits non-zero. The fresh `<agent>`'s welcome card
# also renders on the primary screen (alt-screen is only entered once
# the user starts chatting), so without a re-clear the loading banner
# + error line stay visible above the welcome box. Re-clear and re-draw
# the banner inside the `||` branch so the fallback path looks the same
# as the resume-success path.
check_managed_profile_enabled "$agent" || exit 1

case "$agent" in
  claude)
    clear_anthropic_gateway_env
    ensure_claude_workspace_trust "$PWD"
    resolve_claude_permission
    load_managed_model_override claude
    wezdeck_otel_configure_agent claude
    CLAUDE_PERMISSION_ARGS+=("${managed_model_args[@]}")
    log_resume_boot claude "${CLAUDE_PERMISSION_PROFILE:-base}" "$CLAUDE_PERMISSION_RESOLUTION"
    claude_bin="$(require_agent_binary claude)"
    exec bash "$script_dir/agent-resume.sh" claude "$fallback_log_script" \
      "$claude_bin" "${CLAUDE_PERMISSION_PROFILE:-base}" \
      "${CLAUDE_PERMISSION_ARGS[@]}"
    ;;
  claude-sub2api)
    load_claude_sub2api_env
    # Env is inherited by the inner sh -c / claude process. Banner label
    # keeps the identity visible during the multi-second resume window.
    resolve_claude_permission
    load_managed_model_override claude-sub2api
    wezdeck_otel_configure_agent claude-sub2api
    CLAUDE_PERMISSION_ARGS+=("${managed_model_args[@]}")
    log_resume_boot claude-sub2api "${CLAUDE_PERMISSION_PROFILE:-base}" "$CLAUDE_PERMISSION_RESOLUTION"
    claude_bin="$(require_agent_binary claude)"
    exec bash "$script_dir/agent-resume.sh" claude-sub2api "$fallback_log_script" \
      "$claude_bin" "${CLAUDE_PERMISSION_PROFILE:-base}" \
      "${CLAUDE_PERMISSION_ARGS[@]}"
    ;;
  claude-kimi)
    load_claude_kimi_env
    resolve_claude_permission
    wezdeck_otel_configure_agent claude-kimi
    log_resume_boot claude-kimi "${CLAUDE_PERMISSION_PROFILE:-base}" "$CLAUDE_PERMISSION_RESOLUTION"
    claude_bin="$(require_agent_binary claude)"
    exec bash "$script_dir/agent-resume.sh" claude-kimi "$fallback_log_script" \
      "$claude_bin" "${CLAUDE_PERMISSION_PROFILE:-base}" \
      "${CLAUDE_PERMISSION_ARGS[@]}"
    ;;
  codex)
    codex_bin="$(require_agent_binary codex)"
    ensure_codex_workspace_trust "$PWD"
    codex_profile_args=()
    if [[ -n "${MANAGED_CODEX_PROFILE:-}" ]] \
      && declare -F runtime_log_warn >/dev/null 2>&1; then
      runtime_log_warn primary_pane "deprecated Codex permission variable ignored" \
        "variable=MANAGED_CODEX_PROFILE" \
        "replacement=MANAGED_AGENT_PERMISSION_PROFILE" || true
    fi
    codex_profile="${MANAGED_AGENT_PERMISSION_PROFILE:-}"
    codex_permission_resolution="base"
    case "$codex_profile" in
      '')
        ;;
      auto|full-access)
        ensure_codex_permission_overlay "$codex_profile" || exit 78
        codex_profile_args=(--profile "$codex_profile")
        codex_permission_resolution=profile
        ;;
      *)
        if declare -F runtime_log_warn >/dev/null 2>&1; then
          runtime_log_warn primary_pane "unknown Codex permission profile; using base config" \
            "profile=$codex_profile" "allowed=auto,full-access" || true
        fi
        codex_profile=''
        ;;
    esac
    # A shared app-server keeps its original TMUX_PANE across clients.
    # Attention hooks must use this TUI's own environment.
    load_managed_model_override codex
    wezdeck_otel_configure_agent codex
    codex_profile_args=(--no-daemon "${codex_profile_args[@]}" "${managed_model_args[@]}" "${WEZDECK_OTEL_CODEX_ARGS[@]}")
    log_resume_boot codex "${codex_profile:-base}" "$codex_permission_resolution"
    # Recycle --fresh-agent / forced F5: skip typed id and resume --last.
    if [[ "${WEZDECK_FORCE_FRESH_SESSION:-0}" == "1" ]]; then
      if declare -F runtime_log_info >/dev/null 2>&1; then
        runtime_log_info primary_pane "agent resume fresh" \
          "agent=codex" "resume_mode=fresh" \
          "force=WEZDECK_FORCE_FRESH_SESSION" "cwd=$PWD" || true
      fi
      exec "$codex_bin" "${codex_profile_args[@]+"${codex_profile_args[@]}"}"
    fi
    # shellcheck disable=SC1091
    . "$script_dir/agent-session-resolve.sh"
    codex_session_id="$(agent_session_resolve_current || true)"
    if agent_session_id_usable "${codex_session_id:-}"; then
      if declare -F runtime_log_info >/dev/null 2>&1; then
        runtime_log_info primary_pane "agent resume typed" \
          "agent=codex" "resume_mode=typed" \
          "session_id=$codex_session_id" "cwd=$PWD" || true
      fi
      if [[ -n "${TMUX_PANE:-}" ]]; then
        agent_session_pin_pane "$TMUX_PANE" "$codex_session_id" codex "$PWD"
      fi
      exec "$codex_bin" "${codex_profile_args[@]}" resume "$codex_session_id"
    fi
    exec "$codex_bin" "${codex_profile_args[@]}" resume --last
    ;;
  grok)
    # Grok Build: `--continue` resumes the most recent session for cwd
    # (same role as `claude --continue` / `codex resume --last`).
    # Always prefer the focus-filter wrapper by absolute path so managed
    # panes do not depend on whether ~/.zshrc put ~/.grok/bin (often a
    # post-update bare ELF) ahead of ~/.local/bin. Direct interactive
    # `grok` still needs `grok-with-focus-filter.sh --install` — see
    # docs/tmux-ui.md#grok-build-in-tmux.
    grok_bin="$script_dir/grok-with-focus-filter.sh"
    if [[ ! -x "$grok_bin" ]]; then
      grok_bin="$(resolve_agent_binary grok || true)"
    fi
    if [[ -z "$grok_bin" ]]; then
      printf 'agent-launcher: grok not found (expected %s or PATH)\n' \
        "$script_dir/grok-with-focus-filter.sh" >&2
      _launcher_log_error "agent launcher failed" \
        "reason=grok_not_found" \
        "expected=$script_dir/grok-with-focus-filter.sh" \
        "cwd=$PWD"
      exit 127
    fi
    resolve_grok_permission
    load_managed_model_override grok
    wezdeck_otel_configure_agent grok
    GROK_PERMISSION_ARGS+=("${managed_model_args[@]}")
    log_resume_boot grok "${GROK_PERMISSION_PROFILE:-base}" "$GROK_PERMISSION_RESOLUTION"
    exec bash "$script_dir/agent-resume.sh" grok "$fallback_log_script" \
      "$grok_bin" "${GROK_PERMISSION_PROFILE:-base}" \
      "${GROK_PERMISSION_ARGS[@]}"
    ;;
  agy)
    agy_bin="$(require_agent_binary agy)"
    ensure_agy_workspace_trust "$PWD"
    agy_args=()
    agy_permission="${MANAGED_AGENT_PERMISSION_PROFILE:-}"
    agy_permission_resolution=base
    case "$agy_permission" in
      '') ;;
      auto) agy_args+=(--mode auto); agy_permission_resolution=cli ;;
      full-access) agy_args+=(--dangerously-skip-permissions); agy_permission_resolution=cli ;;
      *)
        runtime_log_warn primary_pane "unknown Agy permission profile; using base config" \
          "profile=$agy_permission" "allowed=auto,full-access" || true
        agy_permission=''
        ;;
    esac
    load_managed_model_override agy
    agy_args+=("${managed_model_args[@]}")
    export WEZDECK_AGY_MANAGED=1
    log_resume_boot agy "${agy_permission:-base}" "$agy_permission_resolution"
    exec bash "$script_dir/agent-resume.sh" agy "$fallback_log_script" \
      "$agy_bin" "${agy_permission:-base}" "${agy_args[@]}"
    ;;
  *)
    printf 'agent-launcher: unknown agent %s\n' "$agent" >&2
    printf 'usage: agent-launcher.sh <claude|claude-sub2api|claude-kimi|codex|grok|agy>\n' >&2
    _launcher_log_error "agent launcher failed" \
      "reason=unknown_agent" "agent=${agent:-}" "cwd=$PWD"
    exit 1
    ;;
esac
