#!/usr/bin/env bash
# Copy habit-weekly md/json into the configured private archive repo and push.
#
# Usage:
#   push-archive.sh --since YYYY-MM-DD --until YYYY-MM-DD \
#     --md PATH.md [--json PATH.json]
#
# Config (first match wins per field):
#   env HABIT_WEEKLY_ARCHIVE_{REPO,PATH,BRANCH} / HABIT_WEEKLY_PUSH_JSON
#   ~/.config/habit-weekly/state.json → .archive
#
# Never force-pushes. Local --write artifacts are left untouched on failure.
set -euo pipefail

TOOL_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

since=''
until=''
md_src=''
json_src=''
dry_run=0

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

while (( $# )); do
  case "$1" in
    --since) since="${2:?}"; shift 2 ;;
    --until) until="${2:?}"; shift 2 ;;
    --md) md_src="${2:?}"; shift 2 ;;
    --json) json_src="${2:?}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ -n "$since" && -n "$until" && -n "$md_src" ]] || {
  echo 'require --since --until --md' >&2
  exit 2
}
[[ -f "$md_src" ]] || { printf 'missing md: %s\n' "$md_src" >&2; exit 2; }
if [[ -n "$json_src" && ! -f "$json_src" ]]; then
  printf 'missing json: %s\n' "$json_src" >&2
  exit 2
fi

state_file="${HABIT_WEEKLY_STATE:-$HOME/.config/habit-weekly/state.json}"

# shellcheck disable=SC2034
eval "$(
  STATE_FILE="$state_file" python3 - <<'PY'
import json, os, shlex
from pathlib import Path

state_path = Path(os.environ["STATE_FILE"])
archive = {}
if state_path.is_file():
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
        archive = data.get("archive") or {}
    except (OSError, json.JSONDecodeError):
        archive = {}

def pick(env_key, *keys, default=""):
    val = os.environ.get(env_key, "").strip()
    if val:
        return val
    for k in keys:
        v = archive.get(k)
        if v is None:
            continue
        s = str(v).strip()
        if s:
            return s
    return default

repo = pick("HABIT_WEEKLY_ARCHIVE_REPO", "repo")
path = pick("HABIT_WEEKLY_ARCHIVE_PATH", "local_path")
branch = pick("HABIT_WEEKLY_ARCHIVE_BRANCH", "branch", default="main")
push_json_env = os.environ.get("HABIT_WEEKLY_PUSH_JSON", "").strip()
if push_json_env != "":
    push_json = push_json_env not in ("0", "false", "no", "off")
else:
    push_json = bool(archive.get("push_json", True))

print(f"ARCHIVE_REPO={shlex.quote(repo)}")
print(f"ARCHIVE_PATH={shlex.quote(path)}")
print(f"ARCHIVE_BRANCH={shlex.quote(branch)}")
print(f"PUSH_JSON={'1' if push_json else '0'}")
PY
)"

[[ -n "$ARCHIVE_PATH" ]] || {
  echo 'archive local_path unset; set ~/.config/habit-weekly/state.json or HABIT_WEEKLY_ARCHIVE_PATH' >&2
  exit 2
}
[[ -d "$ARCHIVE_PATH/.git" ]] || {
  printf 'archive path is not a git repo: %s\n' "$ARCHIVE_PATH" >&2
  printf 'hint: gh repo clone %s %s\n' \
    "${ARCHIVE_REPO:-yunsii/wezdeck-habit-weekly}" "$ARCHIVE_PATH" >&2
  exit 2
}

year="${since:0:4}"
stem="habit-weekly-${since}_to_${until}"
dest_dir="$ARCHIVE_PATH/reports/$year"
dest_md="$dest_dir/${stem}.md"
dest_json="$dest_dir/${stem}.json"

mkdir -p "$dest_dir"
cp -f "$md_src" "$dest_md"
copied_json=0
if [[ "$PUSH_JSON" == "1" && -n "$json_src" ]]; then
  cp -f "$json_src" "$dest_json"
  copied_json=1
fi

(
  cd "$ARCHIVE_PATH"
  # Ensure we are on the configured branch when it exists.
  if git show-ref --verify --quiet "refs/heads/$ARCHIVE_BRANCH"; then
    git checkout -q "$ARCHIVE_BRANCH"
  elif git show-ref --verify --quiet "refs/remotes/origin/$ARCHIVE_BRANCH"; then
    git checkout -q -B "$ARCHIVE_BRANCH" "origin/$ARCHIVE_BRANCH"
  else
    git checkout -q -B "$ARCHIVE_BRANCH"
  fi

  if git rev-parse --verify --quiet "@{u}" >/dev/null 2>&1; then
    git pull --ff-only
  fi

  paths=("reports/$year/${stem}.md")
  if (( copied_json )); then
    paths+=("reports/$year/${stem}.json")
  fi
  git add -- "${paths[@]}"

  if git diff --cached --quiet; then
    printf 'archive up-to-date: %s\n' "$dest_md" >&2
    exit 0
  fi

  msg="chore(habit): weekly ${since}→${until}"
  if (( dry_run )); then
    printf 'dry-run: would commit %s\n' "$msg" >&2
    git status --short -- "${paths[@]}"
    git reset -q HEAD -- "${paths[@]}"
    exit 0
  fi

  git commit -m "$msg"
  git push origin "HEAD:$ARCHIVE_BRANCH"
  printf 'pushed %s\n' "$dest_md" >&2
  if (( copied_json )); then
    printf 'pushed %s\n' "$dest_json" >&2
  fi
)
