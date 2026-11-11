#!/usr/bin/env bash
# Interactive UI that runs *inside* the floating worktree sidebar pane.
# Args: <session> <window_id> <cwd> <prefetch_file> <repo_label> <current_root>
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/runtime-log-lib.sh"

session_name="${1:-}"
current_window_id="${2:-}"
cwd="${3:-}"
prefetch_file="${4:-}"
repo_label="${5:-worktrees}"
current_root="${6:-}"
open_script="$script_dir/tmux-worktree-open.sh"

if [[ -z "$session_name" || ! -f "$prefetch_file" ]]; then
  printf 'worktree sidebar: missing args\n' >&2
  sleep 2
  exit 1
fi

labels=()
paths=()
branches=()
statuses=()
ages=()
while IFS=$'\t' read -r lab path br _win st age _reason || [[ -n "${lab:-}" ]]; do
  [[ -n "${path:-}" ]] || continue
  labels+=("$lab")
  paths+=("$path")
  branches+=("${br:-}")
  statuses+=("${st:-}")
  ages+=("${age:-}")
done < "$prefetch_file"

n=${#paths[@]}
if (( n == 0 )); then
  clear
  printf 'No worktrees for %s\n\nq quit\n' "$repo_label"
  while true; do
    IFS= read -r -n1 -s key || break
    case "$key" in q|Q|$'\e') break ;; esac
  done
  exit 0
fi

selected=0
for i in "${!paths[@]}"; do
  if [[ "${paths[$i]}" == "$current_root" ]]; then
    selected=$i
    break
  fi
done

accel=(1 2 3 4 5 6 7 8 9 0 a b c d e f g h i j k l m n o p q r s t u v w x y z)

status_glyph() {
  case "${1:-}" in
    waiting) printf '▲' ;;
    running) printf '●' ;;
    done) printf '✓' ;;
    *) printf ' ' ;;
  esac
}

draw() {
  local i glyph mark br trail accel_ch
  clear
  printf ' %s\n' "$repo_label"
  printf ' ───────────────\n'
  for i in "${!paths[@]}"; do
    mark=' '
    (( i == selected )) && mark='▶'
    glyph="$(status_glyph "${statuses[$i]}")"
    br="${branches[$i]}"
    [[ -n "$br" ]] && br="[$br]"
    trail=""
    case "${statuses[$i]}" in
      waiting|running|done) trail="$glyph ${ages[$i]}" ;;
      *) [[ -n "${ages[$i]}" ]] && trail="${ages[$i]}" ;;
    esac
    accel_ch=""
    if (( i < ${#accel[@]} )); then
      accel_ch="${accel[$i]} "
    fi
    printf '%s %s%s %s %s\n' "$mark" "$accel_ch" "${labels[$i]}" "$br" "$trail"
  done
  printf '\n j/k Enter  q\n'
}

open_selected() {
  local path="${paths[$selected]}"
  runtime_log_info worktree "sidebar selected" \
    "session_name=$session_name" \
    "worktree_root=$path" \
    "index=$selected" || true
  bash "$open_script" "$session_name" "$path" "$current_window_id" "$cwd" >/dev/null 2>&1 &
}

cleanup_pane() {
  # Kill this floating pane on any exit so global remain-on-exit cannot
  # respawn a leftover interactive shell (the "ghost window" after q).
  local pane="${TMUX_PANE:-}"
  [[ -n "$pane" ]] || return 0
  tmux kill-pane -t "$pane" 2>/dev/null || true
}
trap cleanup_pane EXIT

draw
while true; do
  IFS= read -r -n1 -s key || break
  case "$key" in
    q|Q) break ;;
    j)
      (( selected = (selected + 1) % n ))
      draw
      ;;
    k)
      (( selected = (selected - 1 + n) % n ))
      draw
      ;;
    ''|$'\n'|$'\r')
      open_selected
      draw
      ;;
    $'\x1b')
      IFS= read -r -n1 -s k2 || true
      if [[ "$k2" == '[' ]]; then
        IFS= read -r -n1 -s k3 || true
        case "$k3" in
          B) (( selected = (selected + 1) % n )); draw ;;
          A) (( selected = (selected - 1 + n) % n )); draw ;;
        esac
      else
        break
      fi
      ;;
    [0-9a-z])
      for i in "${!accel[@]}"; do
        if [[ "${accel[$i]}" == "$key" && i -lt n ]]; then
          selected=$i
          open_selected
          draw
          break
        fi
      done
      ;;
  esac
done

exit 0
