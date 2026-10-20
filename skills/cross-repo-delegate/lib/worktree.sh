#!/usr/bin/env bash
# Ensure a delegate-* linked worktree for a ticket via worktree-task.
# shellcheck shell=bash

delegate_wezdeck_repo() {
  if [[ -n "${WEZDECK_REPO:-}" && -d "${WEZDECK_REPO}" ]]; then
    printf '%s' "$WEZDECK_REPO"
    return 0
  fi
  if [[ -f "${HOME}/.config/worktree-task/config.env" ]]; then
    # shellcheck disable=SC1090
    . "${HOME}/.config/worktree-task/config.env"
    if [[ -n "${WEZDECK_REPO:-}" && -d "${WEZDECK_REPO}" ]]; then
      printf '%s' "$WEZDECK_REPO"
      return 0
    fi
  fi
  local guess="${HOME}/github/wezterm-config"
  if [[ -d "$guess/scripts/runtime/worktree" ]]; then
    printf '%s' "$guess"
    return 0
  fi
  return 1
}

# Prints worktree_path=... lines from worktree-task; echoes path on stdout last line via RESULT
# Usage: delegate_ensure_worktree <target_repo_path> <ticket_id> <title>
# Sets: DELEGATE_WORKTREE_PATH DELEGATE_WORKTREE_BRANCH
delegate_ensure_worktree() {
  local target_repo=$1 ticket_id=$2 title=$3
  local wezdeck wt_bin slug branch out path
  wezdeck="$(delegate_wezdeck_repo)" || delegate_die "WEZDECK_REPO not found (configure worktree-task or set WEZDECK_REPO)"
  wt_bin="$wezdeck/scripts/runtime/worktree/worktree-task"
  [[ -x "$wt_bin" ]] || delegate_die "worktree-task missing: $wt_bin"

  slug="delegate-${ticket_id}"
  branch="delegate/${ticket_id}"

  # Reuse if already recorded
  local meta_path
  meta_path="$(delegate_tickets_root)/_data/${ticket_id}/meta.json"
  if [[ -f "$meta_path" ]]; then
    path="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("worktree") or "")' "$meta_path")"
    if [[ -n "$path" && -d "$path" ]]; then
      DELEGATE_WORKTREE_PATH="$path"
      DELEGATE_WORKTREE_BRANCH="$(git -C "$path" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "$branch")"
      printf '%s\n' "$DELEGATE_WORKTREE_PATH"
      return 0
    fi
  fi

  delegate_log "launching worktree slug=$slug cwd=$target_repo"
  out="$(
    WEZDECK_REPO="$wezdeck" "$wt_bin" launch \
      --cwd "$target_repo" \
      --title "${title:-$ticket_id}" \
      --task-slug "$slug" \
      --branch "$branch" \
      --provider none \
      --no-attach \
      --provider-mode off
  )" || delegate_die "worktree-task launch failed"

  path="$(printf '%s\n' "$out" | awk -F= '/^worktree_path=/{print $2; exit}')"
  [[ -n "$path" && -d "$path" ]] || {
    printf '%s\n' "$out" >&2
    delegate_die "worktree_path missing from launch output"
  }
  DELEGATE_WORKTREE_PATH="$path"
  DELEGATE_WORKTREE_BRANCH="$(printf '%s\n' "$out" | awk -F= '/^branch_name=/{print $2; exit}')"
  printf '%s\n' "$DELEGATE_WORKTREE_PATH"
}

# Allowlisted dirt that Mode 3 workers leave behind (never blocks reclaim).
# Comma-separated path prefixes relative to the worktree root.
DELEGATE_RECLAIM_IGNORE_GLOBS="${DELEGATE_RECLAIM_IGNORE_GLOBS:-.delegate,.delegate/}"

# True if porcelain line is only under an allowlisted prefix.
delegate_reclaim_line_allowlisted() {
  local line=$1
  local path="${line:3}" # skip "XY " status; porcelain is 2 chars + space
  path="${path## }"
  # rename: "old -> new" — treat as non-allowlisted
  if [[ "$path" == *" -> "* ]]; then
    return 1
  fi
  # strip optional quotes from git
  path="${path#\"}"
  path="${path%\"}"
  local g
  IFS=',' read -r -a __delegate_ignore <<<"$DELEGATE_RECLAIM_IGNORE_GLOBS"
  for g in "${__delegate_ignore[@]}"; do
    g="$(printf '%s' "$g" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -n "$g" ]] || continue
    case "$path" in
      "$g"|"$g"/*|./"$g"|./"$g"/*) return 0 ;;
    esac
    # prefix without trailing slash also matches children
    case "$g" in
      */) ;;
      *)
        case "$path" in
          "$g"/*|./"$g"/*) return 0 ;;
        esac
        ;;
    esac
  done
  return 1
}

# Remove allowlisted untracked/modified paths under the worktree.
delegate_reclaim_strip_allowlisted() {
  local wt=$1
  local line path
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    delegate_reclaim_line_allowlisted "$line" || continue
    path="${line:3}"
    path="${path## }"
    path="${path#\"}"
    path="${path%\"}"
    [[ -n "$path" ]] || continue
    rm -rf "$wt/$path"
  done < <(git -C "$wt" status --porcelain --untracked-files=all 2>/dev/null || true)
  # .delegate may remain as empty dir after file deletes
  if [[ -d "$wt/.delegate" ]]; then
    rm -rf "$wt/.delegate"
  fi
}

# Record reclaim outcome on the ticket (clears meta.worktree when cleared=1).
# Args: ticket_id event_type reason worktree_path cleared(0|1) [extra_json_object]
delegate_reclaim_record() {
  local ticket_id=$1 event_type=$2 reason=$3 worktree_path=$4 cleared=${5:-0}
  DELEGATE_TICKETS_ROOT="$(delegate_tickets_root)" TOOL_ROOT="$(delegate_tool_root)" \
    ID="$ticket_id" ETYPE="$event_type" REASON="$reason" WT="$worktree_path" CLEARED="$cleared" \
    python3 - <<'PY'
import importlib.util, json, os
spec = importlib.util.spec_from_file_location(
    "ticket_fs", os.path.join(os.environ["TOOL_ROOT"], "lib", "ticket_fs.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
tid = os.environ["ID"]
mj = mod.read_meta_json(tid)
if os.environ.get("CLEARED") == "1":
    mj["worktree"] = None
    mj["branch"] = None
    mod.write_meta_json(tid, mj)
mod.append_event(
    tid,
    {
        "type": os.environ["ETYPE"],
        "reason": os.environ.get("REASON") or "",
        "worktree": os.environ.get("WT") or None,
    },
)
print(json.dumps({"ok": True}))
PY
}

# Reclaim the Mode 3 worktree for a ticket. Prints one JSON object on stdout.
# Usage: delegate_reclaim_worktree <ticket_id> [--force] [--delete-branch]
# Default keeps the local branch (unmerged ticket branches are common after squash).
delegate_reclaim_worktree() {
  local ticket_id=${1:-}
  [[ -n "$ticket_id" ]] || {
    printf '{"ok":false,"reason":"missing_ticket_id"}\n'
    return 1
  }
  shift || true
  local force=0 delete_branch=0
  while (($#)); do
    case "$1" in
      --force) force=1; shift ;;
      --delete-branch) delete_branch=1; shift ;;
      --keep-branch) delete_branch=0; shift ;;
      *)
        printf '{"ok":false,"reason":"unknown_arg","arg":"%s"}\n' "$1"
        return 1
        ;;
    esac
  done

  local meta_path expected slug path dirty_other line wezdeck wt_bin rc out keep_flag
  meta_path="$(delegate_tickets_root)/_data/${ticket_id}/meta.json"
  expected="delegate-${ticket_id}"
  path=""
  if [[ -f "$meta_path" ]]; then
    path="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("worktree") or "")' "$meta_path")"
  fi

  if [[ -z "$path" ]]; then
    printf '{"ok":true,"id":"%s","action":"noop","reason":"no_worktree"}\n' "$ticket_id"
    return 0
  fi

  if [[ ! -d "$path" ]]; then
    delegate_reclaim_record "$ticket_id" "worktree_reclaimed" "missing" "$path" 1 >/dev/null
    printf '{"ok":true,"id":"%s","action":"cleared_meta","reason":"missing","worktree":"%s"}\n' \
      "$ticket_id" "$path"
    return 0
  fi

  slug="$(basename "$path")"
  if [[ "$slug" != "$expected" ]]; then
    delegate_reclaim_record "$ticket_id" "worktree_reclaim_skipped" "slug_mismatch" "$path" 0 >/dev/null
    printf '{"ok":false,"id":"%s","action":"skipped","reason":"slug_mismatch","worktree":"%s","expected":"%s"}\n' \
      "$ticket_id" "$path" "$expected"
    return 1
  fi

  # Strip Mode 3 artifacts, then re-check dirt.
  delegate_reclaim_strip_allowlisted "$path"
  dirty_other=0
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if ! delegate_reclaim_line_allowlisted "$line"; then
      dirty_other=1
      break
    fi
  done < <(git -C "$path" status --porcelain --untracked-files=all 2>/dev/null || true)

  if ((dirty_other)) && ((force == 0)); then
    delegate_reclaim_record "$ticket_id" "worktree_reclaim_skipped" "dirty" "$path" 0 >/dev/null
    printf '{"ok":false,"id":"%s","action":"skipped","reason":"dirty","worktree":"%s"}\n' \
      "$ticket_id" "$path"
    return 1
  fi

  wezdeck="$(delegate_wezdeck_repo)" || {
    delegate_reclaim_record "$ticket_id" "worktree_reclaim_skipped" "wezdeck_missing" "$path" 0 >/dev/null
    printf '{"ok":false,"id":"%s","action":"skipped","reason":"wezdeck_missing","worktree":"%s"}\n' \
      "$ticket_id" "$path"
    return 1
  }
  wt_bin="$wezdeck/scripts/runtime/worktree/worktree-task"
  if [[ ! -x "$wt_bin" ]]; then
    delegate_reclaim_record "$ticket_id" "worktree_reclaim_skipped" "worktree_task_missing" "$path" 0 >/dev/null
    printf '{"ok":false,"id":"%s","action":"skipped","reason":"worktree_task_missing","worktree":"%s"}\n' \
      "$ticket_id" "$path"
    return 1
  fi

  local -a reclaim_args
  reclaim_args=(
    reclaim
    --worktree-root "$path"
    --provider none
    --provider-mode off
  )
  if ((delete_branch == 0)); then
    reclaim_args+=(--keep-branch)
  fi
  if ((force)); then
    reclaim_args+=(--force)
  fi

  set +e
  out="$(WEZDECK_REPO="$wezdeck" "$wt_bin" "${reclaim_args[@]}" 2>&1)"
  rc=$?
  set -e

  if [[ -d "$path" ]] && ((force)); then
    # Last resort when worktree-task refused or left the directory.
    local common primary
    common="$(git -C "$path" rev-parse --git-common-dir 2>/dev/null || true)"
    if [[ -n "$common" ]]; then
      if [[ "$common" != /* ]]; then
        common="$path/$common"
      fi
      primary="$(cd "$(dirname "$common")" && pwd)"
      set +e
      git -C "$primary" worktree remove -f "$path" 2>/dev/null || rm -rf "$path"
      git -C "$primary" worktree prune 2>/dev/null
      set -e
    else
      rm -rf "$path"
    fi
  fi

  if [[ -d "$path" ]]; then
    delegate_reclaim_record "$ticket_id" "worktree_reclaim_skipped" "reclaim_failed" "$path" 0 >/dev/null
    printf '{"ok":false,"id":"%s","action":"skipped","reason":"reclaim_failed","worktree":"%s","detail":%s}\n' \
      "$ticket_id" "$path" "$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[-500:]))')"
    return 1
  fi

  # Silence unused rc when remove succeeded via fallback.
  : "$rc"

  delegate_reclaim_record "$ticket_id" "worktree_reclaimed" "removed" "$path" 1 >/dev/null
  local keep_json=true
  ((delete_branch)) && keep_json=false
  printf '{"ok":true,"id":"%s","action":"reclaimed","reason":"removed","worktree":"%s","keep_branch":%s}\n' \
    "$ticket_id" "$path" "$keep_json"
  return 0
}

# Reclaim a delegate-* path that has no usable ticket id (orphan scan).
# Prints JSON. Args: path [--force]
delegate_reclaim_orphan_path() {
  local path=${1:-}
  [[ -n "$path" && -d "$path" ]] || {
    printf '{"ok":true,"action":"noop","reason":"missing","worktree":"%s"}\n' "${path:-}"
    return 0
  }
  shift || true
  local force=0
  while (($#)); do
    case "$1" in
      --force) force=1; shift ;;
      *) shift ;;
    esac
  done
  local slug
  slug="$(basename "$path")"
  case "$slug" in
    delegate-*) ;;
    *)
      printf '{"ok":false,"action":"skipped","reason":"not_delegate_slug","worktree":"%s"}\n' "$path"
      return 1
      ;;
  esac

  delegate_reclaim_strip_allowlisted "$path"
  local dirty_other=0 line
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    if ! delegate_reclaim_line_allowlisted "$line"; then
      dirty_other=1
      break
    fi
  done < <(git -C "$path" status --porcelain --untracked-files=all 2>/dev/null || true)
  if ((dirty_other)) && ((force == 0)); then
    printf '{"ok":false,"action":"skipped","reason":"dirty","worktree":"%s"}\n' "$path"
    return 1
  fi

  local wezdeck wt_bin
  wezdeck="$(delegate_wezdeck_repo)" || {
    printf '{"ok":false,"action":"skipped","reason":"wezdeck_missing","worktree":"%s"}\n' "$path"
    return 1
  }
  wt_bin="$wezdeck/scripts/runtime/worktree/worktree-task"
  [[ -x "$wt_bin" ]] || {
    printf '{"ok":false,"action":"skipped","reason":"worktree_task_missing","worktree":"%s"}\n' "$path"
    return 1
  }

  local -a reclaim_args
  reclaim_args=(reclaim --worktree-root "$path" --provider none --provider-mode off --keep-branch)
  ((force)) && reclaim_args+=(--force)
  set +e
  WEZDECK_REPO="$wezdeck" "$wt_bin" "${reclaim_args[@]}" >/dev/null 2>&1
  set -e

  if [[ -d "$path" ]] && ((force)); then
    local common primary
    common="$(git -C "$path" rev-parse --git-common-dir 2>/dev/null || true)"
    if [[ -n "$common" ]]; then
      [[ "$common" == /* ]] || common="$path/$common"
      primary="$(cd "$(dirname "$common")" && pwd)"
      set +e
      git -C "$primary" worktree remove -f "$path" 2>/dev/null || rm -rf "$path"
      git -C "$primary" worktree prune 2>/dev/null
      set -e
    else
      rm -rf "$path"
    fi
  fi

  if [[ -d "$path" ]]; then
    printf '{"ok":false,"action":"skipped","reason":"reclaim_failed","worktree":"%s"}\n' "$path"
    return 1
  fi
  printf '{"ok":true,"action":"reclaimed","reason":"orphan_removed","worktree":"%s","keep_branch":true}\n' "$path"
  return 0
}

# Parse duration like 7d / 12h / 30m / 90s / bare seconds → seconds on stdout.
delegate_parse_age_seconds() {
  local raw=${1:-0}
  local n unit
  if [[ "$raw" =~ ^([0-9]+)([smhd])$ ]]; then
    n="${BASH_REMATCH[1]}"
    unit="${BASH_REMATCH[2]}"
  elif [[ "$raw" =~ ^([0-9]+)$ ]]; then
    n="${BASH_REMATCH[1]}"
    unit="s"
  else
    return 1
  fi
  case "$unit" in
    s) printf '%s\n' "$n" ;;
    m) printf '%s\n' "$((n * 60))" ;;
    h) printf '%s\n' "$((n * 3600))" ;;
    d) printf '%s\n' "$((n * 86400))" ;;
    *) return 1 ;;
  esac
}
