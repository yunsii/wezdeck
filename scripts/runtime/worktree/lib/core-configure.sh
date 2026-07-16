#!/usr/bin/env bash
# core-configure.sh — worktree-task configure.
# shellcheck shell=bash

wt_core_configure() {
  local cwd="$PWD"
  local repo_override=""
  local selected_repo=""
  local start_ms

  start_ms="$(runtime_log_now_ms)"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cwd)
        [[ $# -ge 2 ]] || { wt_core_configure_usage; exit 1; }
        cwd="$2"
        shift 2
        ;;
      --repo)
        [[ $# -ge 2 ]] || { wt_core_configure_usage; exit 1; }
        repo_override="$2"
        shift 2
        ;;
      -h|--help)
        wt_core_configure_usage
        exit 0
        ;;
      *)
        wt_core_configure_usage
        exit 1
        ;;
    esac
  done

  wt_core_resolve_repo_context "$cwd"
  wt_config_set_defaults

  [[ -n "$repo_override" ]] || wt_die "configure requires --repo /absolute/path/to/wezdeck-checkout"
  selected_repo="$(wt_config_resolve_wezterm_repo_root "$WT_RESOLVED_CWD" "$repo_override")"
  runtime_log_info task "configuring worktree-task repo" "cwd=$WT_RESOLVED_CWD" "selected_repo=$selected_repo"

  wt_config_save_user_wezterm_repo "$selected_repo"
  runtime_log_info task "configured worktree-task repo" "selected_repo=$selected_repo" "user_config_file=$WT_CONFIG_USER_FILE" "duration_ms=$(runtime_log_duration_ms "$start_ms")"
  printf 'wezterm_config_repo=%s\n' "$selected_repo"
  printf 'user_config_file=%s\n' "$WT_CONFIG_USER_FILE"
}
