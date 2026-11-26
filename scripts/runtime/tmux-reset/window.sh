#!/usr/bin/env bash

window_primary_command() {
  local window_target="${1:?missing window target}"
  local pane_index=""
  local pane_active=""
  local command=""
  local current_command=""
  local preferred_command=""
  local fallback_command=""

  while IFS= read -r pane_index; do
    [[ -n "$pane_index" ]] || continue
    pane_active="$(tmux display-message -p -t "${window_target}.${pane_index}" '#{pane_active}' 2>/dev/null || true)"
    command="$(tmux display-message -p -t "${window_target}.${pane_index}" '#{pane_start_command}' 2>/dev/null || true)"
    current_command="$(tmux display-message -p -t "${window_target}.${pane_index}" '#{pane_current_command}' 2>/dev/null || true)"
    command="$(normalize_tmux_command "$command")"
    current_command="$(normalize_tmux_command "$current_command")"

    case "$command" in
      *'run-managed-command.sh'*|*'run-pane-command'*)
        printf '%s\n' "$command"
        return 0
        ;;
    esac

    if [[ -n "$command" ]]; then
      [[ -n "$fallback_command" ]] || fallback_command="$command"
      if [[ "$pane_active" == "1" ]]; then
        preferred_command="$command"
      fi
      continue
    fi

    if [[ -n "$current_command" ]] && ! tmux_worktree_is_shell_command "$current_command"; then
      [[ -n "$fallback_command" ]] || fallback_command="$current_command"
      if [[ "$pane_active" == "1" ]]; then
        preferred_command="$current_command"
      fi
    fi
  done < <(tmux list-panes -t "$window_target" -F '#{pane_index}' 2>/dev/null || true)

  if [[ -n "$preferred_command" ]]; then
    printf '%s\n' "$preferred_command"
    return 0
  fi

  if [[ -n "$fallback_command" ]]; then
    printf '%s\n' "$fallback_command"
    return 0
  fi

  build_primary_shell_command
}

window_layout_for_target() {
  local window_target="${1:?missing window target}"
  local layout=""
  local pane_count=""

  layout="$(tmux_worktree_window_metadata "$window_target" @wezterm_window_layout)"
  if [[ -n "$layout" ]]; then
    printf '%s\n' "$layout"
    return 0
  fi

  pane_count="$(tmux list-panes -t "$window_target" 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "${pane_count:-0}" -gt 1 ]]; then
    printf 'managed_two_pane\n'
  else
    printf 'single\n'
  fi
}

window_role_for_target() {
  local window_target="${1:?missing window target}"
  local session_name="${2:?missing session name}"
  local role=""

  role="$(tmux_worktree_window_metadata "$window_target" @wezterm_window_role)"
  if [[ -n "$role" ]]; then
    printf '%s\n' "$role"
    return 0
  fi

  if [[ "$(session_role "$session_name")" == "default" ]]; then
    printf 'shell\n'
  else
    printf 'managed_primary\n'
  fi
}

window_root_for_target() {
  local window_target="${1:?missing window target}"
  local session_name="${2:?missing session name}"
  local requested_cwd="${3:-}"
  local role=""
  local root=""
  local resolved=""
  local healed=""
  local pane_path=""

  role="$(window_role_for_target "$window_target" "$session_name")"
  root="$(tmux_worktree_window_metadata "$window_target" @wezterm_window_root)"

  if [[ -n "$requested_cwd" ]]; then
    if [[ "$role" == managed* ]]; then
      # Only adopt requested_cwd when it is inside a git worktree.
      # pane-exit-keep used to respawn dead agent panes into $HOME when
      # #{pane_current_path} was empty; F5 then overwrote @wezterm_window_root
      # with that HOME path and locked the window there.
      if tmux_worktree_in_git_repo "$requested_cwd" 2>/dev/null; then
        resolved="$(resolve_worktree_root_for_cwd "$requested_cwd" || true)"
        if [[ -n "$resolved" && -d "$resolved" ]]; then
          root="$resolved"
        fi
      fi
    else
      root="$requested_cwd"
    fi
  fi

  # Managed windows: if stored/requested root is missing or not a git
  # worktree (HOME poison), heal from sibling panes that still sit in-repo.
  if [[ "$role" == managed* ]] \
    && { [[ -z "$root" || ! -d "$root" ]] || ! tmux_worktree_in_git_repo "$root" 2>/dev/null; }; then
    healed="$(tmux_worktree_current_root_for_window "$window_target" || true)"
    if [[ -n "$healed" && -d "$healed" ]]; then
      root="$healed"
    else
      while IFS= read -r pane_path; do
        pane_path="$(tmux_worktree_normalize_pane_path "$pane_path")"
        [[ -n "$pane_path" && -d "$pane_path" ]] || continue
        if tmux_worktree_in_git_repo "$pane_path" 2>/dev/null; then
          resolved="$(resolve_worktree_root_for_cwd "$pane_path" || true)"
          if [[ -n "$resolved" && -d "$resolved" ]]; then
            root="$resolved"
            break
          fi
        fi
      done < <(tmux list-panes -t "$window_target" -F '#{pane_current_path}' 2>/dev/null || true)
    fi
  fi

  if [[ -z "$root" && "$role" == managed* ]]; then
    root="$(tmux_worktree_current_root_for_window "$window_target" || true)"
  fi
  if [[ -z "$root" ]]; then
    root="$(tmux list-panes -t "$window_target" -F '#{pane_current_path}' 2>/dev/null | head -n 1 || true)"
  fi
  if [[ -z "$root" || ! -d "$root" ]]; then
    root="${HOME:-$PWD}"
  fi

  tmux_worktree_abs_path "$root"
}

window_label_for_target() {
  local window_target="${1:?missing window target}"
  local worktree_root="${2:?missing worktree root}"
  local session_name="${3:?missing session name}"
  local role=""
  local label=""
  local main_worktree_root=""

  label="$(tmux_worktree_window_metadata "$window_target" @wezterm_window_label)"
  if [[ -n "$label" ]]; then
    printf '%s\n' "$label"
    return 0
  fi

  role="$(window_role_for_target "$window_target" "$session_name")"
  if [[ "$role" == "shell" ]]; then
    label="$(basename "$worktree_root")"
    if [[ -z "$label" || "$label" == "/" ]]; then
      label="shell"
    fi
    printf '%s\n' "$label"
    return 0
  fi

  if [[ "$role" == "managed_primary" ]] && tmux_worktree_in_git_repo "$worktree_root"; then
    main_worktree_root="$(tmux_worktree_main_root "$(tmux_worktree_common_dir "$worktree_root")" || true)"
    tmux_worktree_label_for_root "$worktree_root" "$main_worktree_root"
    return 0
  fi

  label="$(tmux display-message -p -t "$window_target" '#{window_name}' 2>/dev/null || true)"
  if [[ -n "$label" ]]; then
    printf '%s\n' "$label"
    return 0
  fi

  printf '%s\n' "$(basename "$worktree_root")"
}

window_refresh_spec() {
  local session_name="${1:?missing session name}"
  local window_target="${2:?missing window target}"
  local requested_cwd="${3:-}"
  local worktree_root=""
  local window_label=""
  local primary_command=""
  local layout=""
  local role=""
  local resume_command=""

  worktree_root="$(window_root_for_target "$window_target" "$session_name" "$requested_cwd")"
  window_label="$(window_label_for_target "$window_target" "$worktree_root" "$session_name")"
  role="$(window_role_for_target "$window_target" "$session_name")"
  primary_command="$(tmux_worktree_window_metadata "$window_target" @wezterm_window_primary_command)"
  if [[ -z "$primary_command" && "$role" == "shell" ]]; then
    primary_command="$(build_primary_shell_command)"
  elif [[ -z "$primary_command" ]]; then
    primary_command="$(window_primary_command "$window_target")"
  fi

  # Refresh on a managed window must put the primary pane back in agent
  # mode under the resume profile, regardless of what command the pane is
  # currently carrying — the user expectation is "respawn the agent",
  # not "respawn whatever shell I happened to drop into". The resume
  # command falls back to a fresh agent when the cwd has no prior
  # conversation, so this is safe even on first refresh of a brand-new
  # worktree. Resolver returns "" when MANAGED_AGENT_PROFILE has no
  # `_RESUME_COMMAND` configured; in that case we keep the metadata
  # command (the existing behavior).
  # Session handoff pins @wezterm_window_agent_profile so later F5 keeps
  # the target agent instead of snapping back to MANAGED_AGENT_PROFILE.
  if [[ "$role" == managed* ]]; then
    window_agent="$(tmux show-window-options -v -t "$window_target" \
      @wezterm_window_agent_profile 2>/dev/null || true)"
    resume_command=""
    if [[ -n "$window_agent" ]] && declare -F resolve_profile_resume_command >/dev/null 2>&1; then
      resume_command="$(resolve_profile_resume_command "${wezterm_config_repo:-}" \
        "$window_agent" "$worktree_root" 2>/dev/null || true)"
    fi
    if [[ -z "$resume_command" ]] && declare -F resolve_resume_primary_command >/dev/null 2>&1; then
      resume_command="$(resolve_resume_primary_command "${wezterm_config_repo:-}" "$worktree_root" 2>/dev/null || true)"
    fi
    if [[ -n "$resume_command" ]]; then
      primary_command="$resume_command"
    fi
    primary_command="$(build_primary_agent_command "$primary_command")"
    unset window_agent
  fi

  layout="$(window_layout_for_target "$window_target")"

  printf '%s\t%s\t%s\t%s\t%s\n' "$worktree_root" "$window_label" "$primary_command" "$layout" "$role"
}

apply_window_metadata() {
  local session_name="${1:?missing session name}"
  local window_target="${2:?missing window target}"
  local worktree_root="${3:?missing worktree root}"
  local window_label="${4:?missing window label}"
  local primary_command="${5:?missing primary command}"
  local layout="${6:?missing layout}"
  local role="${7:?missing role}"
  local workspace_name=""

  workspace_name="$(session_workspace_name "$session_name")"
  tmux_worktree_set_session_metadata "$session_name" "$workspace_name" "$(session_role "$session_name")"
  tmux_worktree_set_window_metadata "$window_target" "$role" "$worktree_root" "$window_label" "$primary_command" "$layout"
}

backfill_window_metadata() {
  local session_name="${1:?missing session name}"
  local window_target="${2:?missing window target}"
  local worktree_root=""
  local window_label=""
  local primary_command=""
  local layout=""
  local role=""

  IFS=$'\t' read -r worktree_root window_label primary_command layout role <<< "$(window_refresh_spec "$session_name" "$window_target")"
  apply_window_metadata "$session_name" "$window_target" "$worktree_root" "$window_label" "$primary_command" "$layout" "$role"
}

reset_window_in_place() {
  local session_name=""
  local window_id=""
  local cwd=""
  local requested_cwd=""
  local worktree_root=""
  local window_label=""
  local primary_command=""
  local layout=""
  local role=""
  local target_pane=""
  local target_pane_index=""
  local target_pane_path=""
  local pane_count=0
  local primary_pane_id=""
  local target_is_primary=""
  local fresh_agent="0"

  while (($# > 0)); do
    case "$1" in
      --session-name)
        session_name="${2:?missing value for --session-name}"
        shift 2
        ;;
      --window-id)
        window_id="${2:?missing value for --window-id}"
        shift 2
        ;;
      --cwd)
        cwd="${2-}"
        shift 2
        ;;
      --fresh-agent)
        fresh_agent="1"
        shift
        ;;
      *)
        printf 'tmux-reset refresh-current-window: unknown option: %s\n' "$1" >&2
        return 1
        ;;
    esac
  done

  session_name="$(context_value_or_env "$session_name" COMMAND_PANEL_SESSION_NAME)"
  window_id="$(context_value_or_env "$window_id" COMMAND_PANEL_WINDOW_ID)"
  cwd="$(context_value_or_env "$cwd" COMMAND_PANEL_CWD)"
  requested_cwd="$(normalize_requested_cwd "$cwd")"

  [[ -n "$session_name" ]] || {
    printf 'tmux-reset refresh-current-window requires --session-name\n' >&2
    return 1
  }
  if [[ -z "$window_id" ]]; then
    window_id="$(active_window_id_for_session "$session_name" || true)"
  fi
  if [[ -z "$window_id" ]]; then
    runtime_log_warn workspace "no tmux window found for window reset" "session_name=$session_name" "cwd=${requested_cwd:-}"
    printf 'no_current_window\n'
    return 0
  fi

  IFS='|' read -r target_pane target_pane_index target_pane_path <<< "$(tmux display-message -p -t "$window_id" '#{pane_id}|#{pane_index}|#{pane_current_path}' 2>/dev/null || true)"
  [[ -n "$target_pane" ]] || {
    runtime_log_warn workspace "tmux window has no panes to reset" "session_name=$session_name" "window_id=$window_id"
    printf 'no_current_window\n'
    return 0
  }
  pane_count="$(tmux list-panes -t "$window_id" 2>/dev/null | wc -l | tr -d ' ')"
  # Prefer the explicit role tag. Pane order can change after split/kill and
  # is not a semantic primary/secondary marker. Keep first-pane as the
  # compatibility fallback for older windows without a role tag.
  primary_pane_id="$(tmux show-window-options -t "$window_id" -v @wezterm_window_primary_pane 2>/dev/null || true)"
  if [[ -n "$primary_pane_id" ]] \
    && ! tmux list-panes -t "$window_id" -F '#{pane_id}' 2>/dev/null | grep -Fxq "$primary_pane_id"; then
    primary_pane_id=""
  fi
  if [[ -z "$primary_pane_id" ]]; then
    # Pane identity is layout metadata. Never infer it from the process in a
    # pane: users may legitimately run another Codex/Claude in the secondary.
    primary_pane_id="$(tmux list-panes -t "$window_id" -F '#{pane_id}|#{pane_left}' 2>/dev/null \
      | sort -t '|' -k2,2n | head -n 1 | cut -d '|' -f1)"
  fi
  if [[ "$layout" == "managed_two_pane" ]]; then
    leftmost_pane="$(tmux list-panes -t "$window_id" -F '#{pane_id}|#{pane_left}' 2>/dev/null \
      | sort -t '|' -k2,2n | head -n 1 | cut -d '|' -f1)"
    if [[ -n "$leftmost_pane" && "$primary_pane_id" != "$leftmost_pane" ]]; then
      runtime_log_warn workspace "primary marker repaired from layout" \
        "window_id=$window_id" "stale_primary=$primary_pane_id" \
        "leftmost_pane=$leftmost_pane"
      primary_pane_id="$leftmost_pane"
      tmux set-window-option -t "$window_id" -q @wezterm_window_primary_pane "$primary_pane_id" 2>/dev/null || true
    fi
  fi
  if [[ -z "$primary_pane_id" ]]; then
    primary_pane_id="$(tmux list-panes -t "$window_id" -F '#{pane_id}' 2>/dev/null | head -n 1)"
  fi
  if [[ -n "$primary_pane_id" && "$target_pane" == "$primary_pane_id" ]]; then
    target_is_primary="1"
  else
    target_is_primary="0"
  fi

  if [[ "$target_is_primary" == "1" && "$(session_role "$session_name")" == "managed" ]]; then
    backfill_window_metadata "$session_name" "$window_id"
  fi

  IFS=$'\t' read -r worktree_root window_label primary_command layout role <<< "$(window_refresh_spec "$session_name" "$window_id" "$requested_cwd")"

  if [[ "$target_is_primary" != "1" ]]; then
    if [[ -n "$target_pane_path" && -d "$target_pane_path" && ! "$target_pane_path" =~ ^/mnt/[a-z]/Users/[^/]+$ ]]; then
      worktree_root="$(tmux_worktree_abs_path "$target_pane_path")"
    elif [[ -n "$requested_cwd" ]]; then
      worktree_root="$requested_cwd"
    else
      worktree_root="${HOME:-$PWD}"
    fi
    # Default: login shell. Overridden below only while secondary is still
    # in agent state (live process) with a typed session id.
    primary_command="$(build_primary_shell_command)"
  fi

  # F5 typed resume: resolve the pane's real agent session id before
  # kill/respawn. Primary always uses the managed resume profile.
  # Secondary follows current pane state (agent vs shell): shell → stay
  # shell and drop stale pins; agent → typed resume when id+agent known.
  # respawn-pane keeps the same pane id; durable pins cover kill-server
  # only while the secondary was left in agent state (not after exit).
  # --fresh-agent (Ctrl+n / recycle): unpin + force cold start so the pane
  # does not --continue the previous conversation. No `/new` keystrokes.
  resume_session_id=""
  resume_mode="continue_fallback"
  resume_agent=""
  _resolve_lib=""
  if [[ -n "${script_dir:-}" && -f "$script_dir/agent-session-resolve.sh" ]]; then
    _resolve_lib="$script_dir/agent-session-resolve.sh"
  elif [[ -n "${wezterm_config_repo:-}" && -f "$wezterm_config_repo/scripts/runtime/agent-session-resolve.sh" ]]; then
    _resolve_lib="$wezterm_config_repo/scripts/runtime/agent-session-resolve.sh"
  fi
  if [[ -n "$_resolve_lib" ]]; then
    # shellcheck disable=SC1090
    . "$_resolve_lib"
  fi
  if [[ "$fresh_agent" == "1" ]]; then
    resume_mode="fresh"
    if declare -F agent_session_unpin_pane >/dev/null 2>&1; then
      agent_session_unpin_pane "$target_pane" "$worktree_root" || true
    fi
    if [[ -n "${script_dir:-}" && -f "$script_dir/attention-state-lib.sh" ]]; then
      # shellcheck disable=SC1091
      . "$script_dir/attention-state-lib.sh" 2>/dev/null || true
    elif [[ -n "${wezterm_config_repo:-}" && -f "$wezterm_config_repo/scripts/runtime/attention-state-lib.sh" ]]; then
      # shellcheck disable=SC1090
      . "$wezterm_config_repo/scripts/runtime/attention-state-lib.sh" 2>/dev/null || true
    fi
    if declare -F attention_state_evict_session >/dev/null 2>&1; then
      _fresh_socket="$(tmux display-message -p -t "$target_pane" '#{socket_path}' 2>/dev/null || true)"
      _fresh_session="$(tmux display-message -p -t "$target_pane" '#{session_name}' 2>/dev/null || true)"
      if [[ -n "$_fresh_socket" && -n "$_fresh_session" ]]; then
        attention_state_evict_session "$_fresh_socket" "$_fresh_session" "" "$target_pane" \
          2>/dev/null || true
      fi
      unset _fresh_socket _fresh_session
    fi
    if [[ "$target_is_primary" == "1" && "$role" == managed* ]]; then
      primary_command="env WEZDECK_FORCE_FRESH_SESSION=1 $primary_command"
    elif [[ "$target_is_primary" != "1" ]]; then
      # Secondary / hand-started: rebuild a fresh launcher from role or pin agent.
      resume_agent=""
      _pane_role="$(tmux show-options -p -t "$target_pane" -v -q @wezterm_pane_role 2>/dev/null || true)"
      case "$_pane_role" in
        agent-cli:*) resume_agent="${_pane_role#agent-cli:}" ;;
      esac
      unset _pane_role
      if [[ -z "$resume_agent" ]] && declare -F agent_session_agent_for_pane >/dev/null 2>&1; then
        resume_agent="$(agent_session_agent_for_pane "$target_pane" || true)"
      fi
      if [[ -n "$resume_agent" ]] && declare -F agent_session_build_fresh_command >/dev/null 2>&1; then
        _fresh_cmd="$(agent_session_build_fresh_command \
          "${wezterm_config_repo:-}" "$resume_agent" || true)"
        if [[ -n "$_fresh_cmd" ]]; then
          primary_command="$_fresh_cmd"
        fi
        unset _fresh_cmd
      fi
    fi
  elif [[ -n "$_resolve_lib" ]]; then
    if [[ "$target_is_primary" != "1" ]] \
      && declare -F agent_session_secondary_in_agent_state >/dev/null 2>&1 \
      && ! agent_session_secondary_in_agent_state "$target_pane"; then
      # Shell state wins over leftover pins / attention / role tags.
      if declare -F agent_session_release_secondary_on_exit >/dev/null 2>&1; then
        agent_session_release_secondary_on_exit "$target_pane" "$worktree_root" || true
      fi
      resume_mode="secondary_shell"
      resume_session_id=""
      resume_agent=""
    else
      resume_session_id="$(agent_session_resolve_for_pane "$target_pane" || true)"
      if agent_session_id_usable "${resume_session_id:-}"; then
        resume_agent="$(agent_session_agent_for_pane "$target_pane" || true)"
        if [[ "$target_is_primary" == "1" && "$role" == managed* ]]; then
          resume_mode="typed"
          agent_session_pin_pane "$target_pane" "$resume_session_id" \
            "${resume_agent:-}" "$worktree_root"
          primary_command="env WEZDECK_RESUME_SESSION_ID=$(printf '%q' "$resume_session_id") $primary_command"
        elif [[ "$target_is_primary" != "1" && -n "$resume_agent" ]]; then
          _typed_cmd="$(agent_session_build_typed_resume_command \
            "${wezterm_config_repo:-}" "$resume_agent" "$resume_session_id" || true)"
          if [[ -n "$_typed_cmd" ]]; then
            resume_mode="typed_secondary"
            agent_session_pin_pane "$target_pane" "$resume_session_id" \
              "$resume_agent" "$worktree_root"
            primary_command="$_typed_cmd"
          else
            resume_session_id=""
            resume_agent=""
          fi
          unset _typed_cmd
        else
          resume_session_id=""
        fi
      else
        resume_session_id=""
      fi
    fi
  fi
  unset _resolve_lib

  runtime_log_info workspace "resetting tmux window in place" \
    "session_name=$session_name" \
    "window_id=$window_id" \
    "target_pane=$target_pane" \
    "target_pane_index=$target_pane_index" \
    "primary_pane_id=$primary_pane_id" \
    "target_is_primary=$target_is_primary" \
    "worktree_root=$worktree_root" \
    "window_label=$window_label" \
    "primary_command=$primary_command" \
    "layout=$layout" \
    "role=$role" \
    "resume_session_id=${resume_session_id:-}" \
    "resume_agent=${resume_agent:-}" \
    "resume_mode=$resume_mode" \
    "fresh_agent=$fresh_agent"

  # Heal client size / pane balance / status clamp before respawn so a
  # refresh after RDP or DPI change does not recreate panes into a
  # still-broken geometry. `script_dir` comes from tmux-reset.sh (the
  # sourcer); fall back to wezterm_config_repo when sourced under tests.
  _fix_layout=""
  if [[ -n "${script_dir:-}" && -f "$script_dir/tmux-fix-layout.sh" ]]; then
    _fix_layout="$script_dir/tmux-fix-layout.sh"
  elif [[ -n "${wezterm_config_repo:-}" && -f "$wezterm_config_repo/scripts/runtime/tmux-fix-layout.sh" ]]; then
    _fix_layout="$wezterm_config_repo/scripts/runtime/tmux-fix-layout.sh"
  fi
  if [[ -n "$_fix_layout" ]]; then
    _fix_args=(--session "$session_name" --window "$window_id")
    [[ -n "$requested_cwd" ]] && _fix_args+=(--cwd "$requested_cwd")
    bash "$_fix_layout" "${_fix_args[@]}" >/dev/null 2>&1 || true
  fi
  unset _fix_layout _fix_args

  tmux respawn-pane -k -t "$target_pane" -c "$worktree_root" "$primary_command"
  tmux rename-window -t "$window_id" "$window_label" 2>/dev/null || true

  # Record the immediate post-respawn process identity. This distinguishes a
  # bad command selection from an agent that starts and exits shortly after.
  runtime_log_info workspace "primary pane respawned" \
    "pane_id=$target_pane" \
    "pane_current_command=$(tmux display-message -p -t "$target_pane" '#{pane_current_command}' 2>/dev/null || true)" \
    "pane_start_command=$(tmux display-message -p -t "$target_pane" '#{pane_start_command}' 2>/dev/null || true)" \
    "primary_command=$primary_command"

  # Tag (or clear) the agent profile on the primary pane so C-n
  # can detect it through the resume wrapper's leaf=sh / leaf=node
  # startup transient. See `@agent_pane_match` in tmux.conf.
  if [[ "$target_is_primary" == "1" ]]; then
    ensure_primary_pane_role_tag "$target_pane" "$role" "${wezterm_config_repo:-}" "$worktree_root"
    tmux set-window-option -t "$window_id" -q @wezterm_window_primary_pane "$target_pane" 2>/dev/null || true
  elif [[ "$resume_mode" == "typed_secondary" && -n "$resume_agent" ]]; then
    tmux set-option -p -t "$target_pane" -q \
      @wezterm_pane_role "agent-cli:$resume_agent" 2>/dev/null || true
  fi
  # Always enforce the managed two-pane contract after respawning the
  # primary. The helper is a no-op when the secondary already exists, and
  # this also repairs a pane lost during the refresh race.
  if [[ "$target_is_primary" == "1" && "$layout" == "managed_two_pane" ]]; then
    tmux_worktree_ensure_window_panes "$window_id" "$worktree_root"
    runtime_log_info workspace "managed window panes enforced" \
      "window_id=$window_id" \
      "pane_count=$(tmux list-panes -t "$window_id" 2>/dev/null | wc -l | tr -d ' ')"
  fi
  if [[ "$target_is_primary" == "1" ]]; then
    apply_window_metadata "$session_name" "$window_id" "$worktree_root" "$window_label" "$primary_command" "$layout" "$role"
  fi

  printf 'reset_window_in_place\n'
}

refresh_current_window() {
  reset_window_in_place "$@"
}

reset_managed_window() {
  local workspace=""
  local cwd=""
  local session_name=""
  local window_id=""
  local requested_cwd=""

  while (($# > 0)); do
    case "$1" in
      --workspace)
        workspace="${2:?missing value for --workspace}"
        shift 2
        ;;
      --cwd)
        cwd="${2-}"
        shift 2
        ;;
      *)
        printf 'tmux-reset reset-managed-window: unknown option: %s\n' "$1" >&2
        return 1
        ;;
    esac
  done

  requested_cwd="$(normalize_requested_cwd "$cwd")"
  session_name="$(resolve_current_workspace_session --workspace "$workspace" --cwd "$requested_cwd" || true)"
  window_id="$(active_window_id_for_session "$session_name" || true)"
  reset_window_in_place --session-name "$session_name" --window-id "$window_id" --cwd "$cwd"
}

reset_current_window() {
  refresh_current_window "$@"
}
