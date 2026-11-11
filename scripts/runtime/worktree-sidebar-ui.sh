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

# Arithmetic that can evaluate to 0 must not trip `set -e` (bash ((0)) → status 1).
move_down() { selected=$(( (selected + 1) % n )); }
move_up() { selected=$(( (selected - 1 + n) % n )); }

status_glyph() {
  case "${1:-}" in
    waiting) printf '▲' ;;
    running) printf '●' ;;
    done) printf '✓' ;;
    *) printf ' ' ;;
  esac
}

draw() {
  local i glyph mark br trail accel_ch line cols
  cols="${COLUMNS:-$(tput cols 2>/dev/null || echo 40)}"
  (( cols < 12 )) && cols=12
  clear
  printf ' %s\n' "$repo_label"
  printf ' ───────────────\n'
  for i in "${!paths[@]}"; do
    mark=' '
    [[ "$i" -eq "$selected" ]] && mark='▶'
    glyph="$(status_glyph "${statuses[$i]}")"
    br="${branches[$i]}"
    [[ -n "$br" ]] && br="[$br]"
    trail=""
    case "${statuses[$i]}" in
      waiting|running|done) trail="$glyph ${ages[$i]}" ;;
      *) [[ -n "${ages[$i]}" ]] && trail="${ages[$i]}" ;;
    esac
    accel_ch=""
    if [[ "$i" -lt "${#accel[@]}" ]]; then
      accel_ch="${accel[$i]} "
    fi
    line=$(printf '%s %s%s %s %s' "$mark" "$accel_ch" "${labels[$i]}" "$br" "$trail")
    # Pad / clip to pane width so reverse-video highlights the whole row.
    if (( ${#line} < cols )); then
      line+=$(printf "%*s" $(( cols - ${#line} )) '')
    else
      line="${line:0:cols}"
    fi
    if [[ "$i" -eq "$selected" ]]; then
      # Reverse video — same idea as the Go popup selected row.
      printf '\033[7m%s\033[0m\n' "$line"
    else
      printf '%s\n' "$line"
    fi
  done
  printf '\n j/k Enter  q/Esc\n'
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
      move_down
      draw
      ;;
    k)
      move_up
      draw
      ;;
    ''|$'\n'|$'\r')
      open_selected
      draw
      ;;
    $'\x1b')
      # Arrow keys are ESC [ A/B. A lone Esc must not block waiting for the
      # next byte — that forced a second Esc to close. Short timeout: if
      # nothing follows, treat as dismiss.
      if IFS= read -r -n1 -s -t 0.05 k2; then
        if [[ "$k2" == '[' ]]; then
          IFS= read -r -n1 -s -t 0.05 k3 || true
          case "$k3" in
            B) move_down; draw ;;
            A) move_up; draw ;;
          esac
        else
          break
        fi
      else
        break
      fi
      ;;
    [0-9a-z])
      for i in "${!accel[@]}"; do
        if [[ "${accel[$i]}" == "$key" && "$i" -lt "$n" ]]; then
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
