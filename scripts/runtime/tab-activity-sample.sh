#!/usr/bin/env bash
# Low-frequency git-activity sampler for tab visibility.
#
# Focus/view events are diagnostic only. This script promotes a session
# only when its git fingerprint changes, so opening a tab or peeking
# through overflow does not by itself make that tab sticky.

set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$script_dir/tab-stats-lib.sh"
# shellcheck disable=SC1091
. "$script_dir/tmux-worktree-lib.sh" 2>/dev/null || {
  tmux_worktree_session_name_for_path() { :; }
}

workspace="${1:?missing workspace}"
mode="${2:-visible}"
stats_dir="$(tab_stats_dir)"
snapshot="$stats_dir/$(tab_stats_workspace_slug "$workspace")-items.json"

[[ -f "$snapshot" ]] || exit 0

hash_stream() {
  if command -v sha1sum >/dev/null 2>&1; then
    sha1sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum | awk '{print $1}'
  else
    cksum | awk '{print $1}'
  fi
}

git_fingerprint() {
  local cwd="$1"
  local head index_hash worktree_hash
  head="$(git -C "$cwd" rev-parse --verify HEAD 2>/dev/null || printf 'NOHEAD')"
  index_hash="$(git -C "$cwd" diff --cached --name-status -- 2>/dev/null | hash_stream)"
  worktree_hash="$(git -C "$cwd" diff --name-status -- 2>/dev/null | hash_stream)"
  printf 'head=%s;index=%s;worktree=%s' "$head" "$index_hash" "$worktree_hash"
}

fingerprint_part() {
  local fp="$1"
  local key="$2"
  printf '%s' "$fp" | tr ';' '\n' | awk -F= -v k="$key" '$1 == k { print substr($0, length(k) + 2); exit }'
}

activity_delta() {
  local old_fp="$1"
  local new_fp="$2"
  local delta=0
  if [[ "$(fingerprint_part "$old_fp" head)" != "$(fingerprint_part "$new_fp" head)" ]]; then
    delta=$((delta + 100))
  fi
  if [[ "$(fingerprint_part "$old_fp" index)" != "$(fingerprint_part "$new_fp" index)" ]]; then
    delta=$((delta + 40))
  fi
  if [[ "$(fingerprint_part "$old_fp" worktree)" != "$(fingerprint_part "$new_fp" worktree)" ]]; then
    delta=$((delta + 20))
  fi
  printf '%s' "$delta"
}

old_fingerprint_for_session() {
  local session="$1"
  tab_stats_read "$workspace" \
    | jq -r --arg s "$session" '.sessions[$s].last_git_fingerprint // ""' 2>/dev/null \
    || true
}

row_filter='.items[] | select(.cwd != null)'
if [[ "$mode" != "all" ]]; then
  row_filter='.items[] | select(.cwd != null and (.has_tab // false) == true)'
fi

while IFS=$'\t' read -r cwd _has_tab; do
  [[ -n "$cwd" && -d "$cwd" ]] || continue
  git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1 || continue

  session="$(tmux_worktree_session_name_for_path "$workspace" "$cwd" 2>/dev/null || true)"
  [[ -n "$session" ]] || continue

  new_fp="$(git_fingerprint "$cwd")"
  [[ -n "$new_fp" ]] || continue

  old_fp="$(old_fingerprint_for_session "$session")"
  if [[ -z "$old_fp" ]]; then
    tab_stats_set_git_fingerprint "$workspace" "$session" "$new_fp" || true
    continue
  fi
  if [[ "$old_fp" == "$new_fp" ]]; then
    continue
  fi

  delta="$(activity_delta "$old_fp" "$new_fp")"
  if (( delta > 0 )); then
    tab_stats_record_activity "$workspace" "$session" "$delta" "$new_fp" || true
  else
    tab_stats_set_git_fingerprint "$workspace" "$session" "$new_fp" || true
  fi
done < <(jq -r "$row_filter | [.cwd, (.has_tab // false | tostring)] | @tsv" "$snapshot" 2>/dev/null)
