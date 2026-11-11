#!/usr/bin/env bash
# Shared worktree list prefetch for Alt+g (centered popup default; optional
# parked sidebar path can reuse the same TSV).
#
# Requires (sourced by caller before use):
#   tmux-worktree-lib.sh, attention-state-lib.sh, tmux-user-interact-lib.sh,
#   access-ledger-lib.sh
# Optional: menu-bench-lib.sh (bench_mark no-ops if absent), runtime-log-lib.sh
#
# worktree_prefetch_list <session> <window_id> <cwd> <prefetch_file>
#
# Writes TSV rows to prefetch_file:
#   label \t path \t branch \t window_id \t status \t age \t reason
#
# Sets caller-visible globals:
#   current_worktree_root repo_common_dir main_worktree_root repo_label
#   list_root context_origin
#   item_labels item_paths item_branches item_window_ids item_accelerators
#
# Returns:
#   0 success (file may have zero rows)
#   1 missing session_name
#   2 could not resolve worktree context
#
# WORKTREE_PREFETCH_START_MS — optional epoch-ms for attention TTL / ages
# (defaults to runtime_log_now_ms or date).

worktree_prefetch_list() {
  local session_name="${1:-}"
  local current_window_id="${2:-}"
  local cwd="${3:-$PWD}"
  local prefetch_file="${4:-}"
  local context="" context_origin=""
  local start_ms accelerators ranked_rows git_order
  local idx_root idx_window_id idx_interact
  local ledger_path ledger_ms
  local as_window as_status as_age as_reason
  local worktree_label worktree_path branch_name prefetch_window_id
  local row_interact row_tier attention_cells now_s age_s visit_age
  local row_status row_age row_reason
  local attention_state_file
  declare -A worktree_window_index=()
  declare -A worktree_window_interact=()
  declare -A worktree_ledger_interact=()
  declare -A window_status=()

  if [[ -z "$session_name" || -z "$prefetch_file" ]]; then
    return 1
  fi

  : > "$prefetch_file"
  item_labels=()
  item_paths=()
  item_branches=()
  item_window_ids=()
  item_accelerators=()
  accelerators=(1 2 3 4 5 6 7 8 9 0 a b c d e f g h i j k l m n o p q r s t u v w x y z)

  if [[ -n "${WORKTREE_PREFETCH_START_MS:-}" && "$WORKTREE_PREFETCH_START_MS" =~ ^[0-9]+$ ]]; then
    start_ms="$WORKTREE_PREFETCH_START_MS"
  elif declare -F runtime_log_now_ms >/dev/null 2>&1; then
    start_ms="$(runtime_log_now_ms)"
  else
    start_ms="$(date +%s%3N 2>/dev/null || echo $(($(date +%s) * 1000)))"
  fi

  context="$(tmux_worktree_context_for_context "$current_window_id" "$cwd" "$session_name" || true)"
  if [[ -z "$context" ]]; then
    return 2
  fi

  IFS=$'\t' read -r current_worktree_root repo_common_dir main_worktree_root repo_label context_origin <<< "$context"
  list_root="$main_worktree_root"
  if [[ "$context_origin" == "session" ]]; then
    if declare -F runtime_log_warn >/dev/null 2>&1; then
      runtime_log_warn worktree "worktree menu recovered context from session peer" \
        "session_name=$session_name" \
        "current_window_id=$current_window_id" \
        "cwd=$cwd" \
        "peer_worktree_root=$current_worktree_root" \
        "repo_common_dir=$repo_common_dir" || true
    fi
    current_worktree_root=""
  fi

  if declare -F bench_mark >/dev/null 2>&1; then
    bench_mark context_resolved
  fi

  if [[ -n "$current_window_id" ]]; then
    tmux_user_interact_flush_current "$session_name" "$current_window_id" || true
  fi
  if [[ -n "$current_worktree_root" ]]; then
    access_ledger_touch "$session_name" "$current_worktree_root" >/dev/null 2>&1 || true
  fi

  while IFS=$'\t' read -r idx_root idx_window_id idx_interact; do
    [[ -n "$idx_root" && -n "$idx_window_id" ]] || continue
    worktree_window_index["$idx_root"]="$idx_window_id"
    worktree_window_interact["$idx_root"]="${idx_interact:-0}"
  done < <(tmux_worktree_build_window_index "$session_name" "$repo_common_dir")

  while IFS=$'\t' read -r ledger_path ledger_ms; do
    [[ -n "$ledger_path" && "$ledger_ms" =~ ^[0-9]+$ ]] || continue
    worktree_ledger_interact["$ledger_path"]=$(( ledger_ms / 1000 ))
  done < <(access_ledger_all_worktree_ms_tsv)

  attention_state_file="$(attention_state_path)"
  if [[ -s "$attention_state_file" ]]; then
    while IFS=$'\t' read -r as_window as_status as_age as_reason; do
      [[ -n "$as_window" ]] || continue
      if [[ -z "${window_status[$as_window]+set}" ]]; then
        window_status["$as_window"]="$as_status"$'\t'"$as_age"$'\t'"$as_reason"
      fi
    done < <(jq -r \
      --arg sess "$session_name" \
      --argjson now "$start_ms" \
      --argjson ttl 1800000 '
        def age($ms): (($now - $ms) / 1000 | floor) as $s
          | if $s < 0 then "0s"
            elif $s < 60 then "\($s)s"
            elif $s < 3600 then "\(($s / 60) | floor)m"
            else "\(($s / 3600) | floor)h" end;
        def rank: if . == "waiting" then 0 elif . == "running" then 1
                  elif . == "done" then 2 else 3 end;
        def clean: (. // "") | gsub("[\t\r\n]"; " ");
        [ (.entries // {}) | to_entries[] | .value
          | select((.tmux_session // "") == $sess and (.tmux_window // "") != "")
          | select(($now - (.ts // 0)) < $ttl)
          | { w: .tmux_window, s: (.status // ""), a: age(.ts // $now),
              r: (.reason | clean) } ]
        | sort_by(.s | rank)
        | .[] | [.w, .s, .a, .r] | @tsv
      ' "$attention_state_file" 2>/dev/null || true)
  fi
  if declare -F bench_mark >/dev/null 2>&1; then
    bench_mark attention_joined
  fi

  ranked_rows=()
  git_order=0
  while IFS=$'\t' read -r worktree_label worktree_path branch_name; do
    [[ -n "$worktree_path" ]] || continue
    prefetch_window_id="${worktree_window_index[$worktree_path]:-}"
    row_interact="$(access_ledger_visit_ts_s "$worktree_path" \
      "${worktree_window_interact[$worktree_path]:-0}" \
      "${worktree_ledger_interact[$worktree_path]:-0}")"
    [[ "$row_interact" =~ ^[0-9]+$ ]] || row_interact=0
    row_tier=0
    if tmux_worktree_is_delegated "$worktree_path" "$branch_name"; then
      row_tier=1
    fi
    attention_cells=$'\t\t'
    if [[ -n "$prefetch_window_id" && -n "${window_status[$prefetch_window_id]:-}" ]]; then
      attention_cells="${window_status[$prefetch_window_id]}"
    elif [[ -z "$prefetch_window_id" ]] && (( row_interact > 0 )); then
      now_s=$(( start_ms / 1000 ))
      age_s=$(( now_s - row_interact ))
      (( age_s < 0 )) && age_s=0
      if (( age_s < 60 )); then
        visit_age="${age_s}s"
      elif (( age_s < 3600 )); then
        visit_age="$(( age_s / 60 ))m"
      elif (( age_s < 86400 )); then
        visit_age="$(( age_s / 3600 ))h"
      else
        visit_age="$(( age_s / 86400 ))d"
      fi
      attention_cells=$'\t'"$visit_age"$'\t'
    fi
    ranked_rows+=("$row_tier"$'\t'"$row_interact"$'\t'"$git_order"$'\t'"$worktree_label"$'\t'"$worktree_path"$'\t'"$branch_name"$'\t'"$prefetch_window_id"$'\t'"$attention_cells")
    git_order=$((git_order + 1))
  done < <(tmux_worktree_list "$list_root" || true)

  if (( ${#ranked_rows[@]} > 0 )); then
    while IFS=$'\t' read -r _ _ _ worktree_label worktree_path branch_name prefetch_window_id row_status row_age row_reason; do
      [[ -n "$worktree_path" ]] || continue
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$worktree_label" "$worktree_path" "$branch_name" "$prefetch_window_id" \
        "$row_status" "$row_age" "$row_reason" >> "$prefetch_file"
      item_labels+=("$worktree_label")
      item_paths+=("$worktree_path")
      item_branches+=("$branch_name")
      item_window_ids+=("$prefetch_window_id")
      if (( ${#item_labels[@]} <= ${#accelerators[@]} )); then
        item_accelerators+=("${accelerators[$((${#item_labels[@]} - 1))]}")
      else
        item_accelerators+=("")
      fi
    done < <(printf '%s\n' "${ranked_rows[@]}" | LC_ALL=C sort -t $'\t' -k1,1n -k2,2nr -k3,3n)
  fi

  if declare -F bench_mark >/dev/null 2>&1; then
    bench_mark prefetched_items
  fi
  return 0
}
