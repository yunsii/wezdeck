#!/usr/bin/env bash
# Emit Alt+/ prefetch TSV rows for active session-bridge watch jobs.
# Same 10-column layout as attention picker_rows (see tmux-attention-menu.sh).
#
#   status \t body \t age \t id \t wezterm_pane \t socket \t window \t pane \t last_status \t tmux_session
#
# status is always "sb". body uses the lua label shape so the Go splitter
# columnizes:  <workspace>/<tab>/<win_pane>/<kind>  SB · <last_status> · <title>
set -euo pipefail

job_dir="${OPENCLAW_HOME:-$HOME/.openclaw}/state/session-bridge-watch"
[[ -d "$job_dir" ]] || exit 0

# Default tmux socket (session-bridge side-load may differ; per-job we can refine later)
sock="${SB_TMUX_SOCKET:-}"
if [[ -z "$sock" && -n "${TMUX:-}" ]]; then
  sock="${TMUX%%,*}"
fi
if [[ -z "$sock" ]]; then
  sock="/tmp/tmux-$(id -u)/default"
fi

now_epoch="$(date -u +%s 2>/dev/null || echo 0)"

format_age() {
  local sec="$1"
  if ! [[ "$sec" =~ ^[0-9]+$ ]]; then
    printf ''
    return
  fi
  if (( sec < 60 )); then
    printf '%ds' "$sec"
  elif (( sec < 3600 )); then
    printf '%dm' "$((sec / 60))"
  else
    printf '%dh' "$((sec / 3600))"
  fi
}

# workspace from managed session name wezterm_<ws>_<repo>_<hex>
parse_ws_repo() {
  local sess="$1"
  if [[ "$sess" =~ ^wezterm_([^_]+)_(.+)_([0-9a-fA-F]+)$ ]]; then
    printf '%s\t%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  else
    printf '?\t%s' "$sess"
  fi
}

shopt -s nullglob
for f in "$job_dir"/w-*.json; do
  [[ -f "$f" ]] || continue
  meta="$(jq -c '{
    id: (.id // ""),
    target: (.target // ""),
    pane: (.tmux_pane // ""),
    kind: (.kind // "agent"),
    status: (.last_status // "running"),
    title: (.title // ""),
    started: (.started_epoch // 0),
    active: (if .active == false then false else true end)
  }' "$f" 2>/dev/null || true)"
  [[ -n "$meta" ]] || continue

  # Soft-stopped watches are not listed (record kept on disk only).
  if [[ "$(jq -r '.active' <<<"$meta")" == "false" ]]; then
    continue
  fi

  id="$(jq -r '.id' <<<"$meta")"
  target="$(jq -r '.target' <<<"$meta")"
  pane="$(jq -r '.pane' <<<"$meta")"
  kind="$(jq -r '.kind' <<<"$meta")"
  st="$(jq -r '.status' <<<"$meta")"
  title="$(jq -r '.title' <<<"$meta")"
  started="$(jq -r '.started' <<<"$meta")"
  [[ -n "$id" && -n "$target" ]] || continue

  sess="${target%%:*}"
  rest="${target#*:}"
  win="${rest%%.*}"
  pidx="${rest#*.}"

  # Resolve live window_id + wezterm pane from tmux
  win_id=""
  wp=""
  if [[ -n "$pane" ]]; then
    win_id="$(tmux -S "$sock" display-message -t "$pane" -p '#{window_id}' 2>/dev/null || true)"
    wp="$(tmux -S "$sock" show-environment -t "$sess" WEZTERM_PANE 2>/dev/null | sed -n 's/^WEZTERM_PANE=//p' || true)"
  fi
  if [[ -z "$win_id" && -n "$sess" && -n "$win" ]]; then
    win_id="$(tmux -S "$sock" display-message -t "${sess}:${win}" -p '#{window_id}' 2>/dev/null || true)"
  fi
  # Skip dead targets (pane gone)
  if [[ -n "$pane" ]]; then
    if ! tmux -S "$sock" list-panes -a -F '#{pane_id}' 2>/dev/null | grep -Fxq "$pane"; then
      continue
    fi
  fi

  ws_repo="$(parse_ws_repo "$sess")"
  ws="${ws_repo%%$'\t'*}"
  repo="${ws_repo#*$'\t'}"
  tmux_seg="${win}_${pidx}"
  # strip title noise for branch column
  title_clean="$(printf '%s' "$title" | sed 's/^[[:space:]✳⠂⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠐]*//;s/[[:space:]]*$//')"
  [[ -n "$title_clean" ]] || title_clean="$kind"

  reason="SB watch · ${st} · ${kind}"
  body="${ws}/${repo}/${tmux_seg}/${title_clean}  ${reason}"

  age=""
  if [[ "$started" =~ ^[0-9]+$ ]] && (( started > 0 && now_epoch >= started )); then
    age="$(format_age "$((now_epoch - started))")"
  fi

  # id prefix keeps dispatch off attention --session forget paths
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "sb" \
    "$body" \
    "$age" \
    "sb::${id}" \
    "${wp:-}" \
    "$sock" \
    "${win_id:-}" \
    "${pane:-}" \
    "$st" \
    "$sess"
done
