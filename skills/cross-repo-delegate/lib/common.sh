#!/usr/bin/env bash
# Shared paths + helpers for cross-repo delegate tickets.
# shellcheck shell=bash

delegate_tool_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

delegate_tickets_root() {
  printf '%s' "${DELEGATE_TICKETS_ROOT:-$HOME/.agent/tickets}"
}

delegate_now_iso() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

delegate_now_epoch() {
  date +%s
}

delegate_die() {
  printf 'error: %s\n' "$*" >&2
  exit "${2:-1}"
}

delegate_log() {
  printf '\033[2m[delegate]\033[0m %s\n' "$*" >&2
}

# flock wrapper: delegate_with_lock <lockfile> -- command...
delegate_with_lock() {
  local lockfile=$1
  shift
  [[ "${1:-}" == "--" ]] && shift
  mkdir -p "$(dirname "$lockfile")"
  (
    flock -w 30 9 || delegate_die "could not acquire lock: $lockfile" 3
    "$@"
  ) 9>"$lockfile"
}

delegate_ensure_tree() {
  local root
  root="$(delegate_tickets_root)"
  mkdir -p "$root/_data" "$root/by-target" "$root/by-source" "$root/archive" "$root/.locks"
  if [[ ! -f "$root/README.md" ]]; then
    cp "$(delegate_tool_root)/templates/tickets-README.md" "$root/README.md" 2>/dev/null \
      || printf '%s\n' "# Delegate tickets" "Canonical body: \`_data/<id>/\`. Buckets under \`by-target/\` are derived." >"$root/README.md"
  fi
  if [[ ! -f "$root/config.yml" ]]; then
    cp "$(delegate_tool_root)/config.example.yml" "$root/config.yml"
    delegate_log "wrote default config: $root/config.yml"
  fi
}

# Resolve target key from --to or cwd. Prints canonical target key.
delegate_resolve_target_key() {
  local hint=${1:-}
  local root cfg
  root="$(delegate_tickets_root)"
  cfg="$root/config.yml"
  [[ -f "$cfg" ]] || delegate_die "missing config: $cfg (run: delegate init)"
  DELEGATE_HINT="$hint" python3 - "$cfg" <<'PY'
import os, re, sys
from pathlib import Path

cfg_path = Path(sys.argv[1])
hint = (os.environ.get("DELEGATE_HINT") or "").strip()
text = cfg_path.read_text(encoding="utf-8")

# Minimal YAML subset: targets.<key>.path / aliases
targets = {}
cur = None
for line in text.splitlines():
    if re.match(r"^targets:\s*$", line):
        continue
    m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
    if m:
        cur = m.group(1)
        targets[cur] = {"path": None, "aliases": []}
        continue
    if cur is None:
        continue
    m = re.match(r"^    path:\s*(.+?)\s*$", line)
    if m:
        targets[cur]["path"] = os.path.expanduser(m.group(1).strip().strip("\"'"))
        continue
    m = re.match(r"^    aliases:\s*\[(.*)\]\s*$", line)
    if m:
        raw = m.group(1).strip()
        if raw:
            targets[cur]["aliases"] = [a.strip().strip("\"'") for a in raw.split(",") if a.strip()]
        continue
    m = re.match(r"^    - \s*(.+?)\s*$", line)
    if m and "aliases" in line or False:
        pass

# also support aliases as list lines under aliases:
cur = None
mode = None
for line in text.splitlines():
    m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
    if m:
        cur = m.group(1)
        mode = None
        continue
    if cur and re.match(r"^    aliases:\s*$", line):
        mode = "aliases"
        targets.setdefault(cur, {"path": None, "aliases": []})
        continue
    if mode == "aliases" and cur:
        m = re.match(r"^      - \s*(.+?)\s*$", line)
        if m:
            targets[cur].setdefault("aliases", []).append(m.group(1).strip().strip("\"'"))
        elif re.match(r"^    \w", line):
            mode = None

def norm(p):
    try:
        return str(Path(p).resolve())
    except Exception:
        return p

def git_main_worktree_root(start: Path):
    """Primary checkout root for cwd inside a primary or linked worktree.

    Linked worktrees have a `.git` *file* whose basename is the worktree
    slug (e.g. dev-foo), which must not be treated as the allowlist key.
    Prefer `git rev-parse --git-common-dir` → parent of `.git`.
    """
    import subprocess

    git_root = None
    for cand in [start, *start.parents]:
        g = cand / ".git"
        if g.exists() or g.is_file():
            git_root = cand
            break
    if git_root is None:
        return None
    try:
        common = subprocess.check_output(
            [
                "git",
                "-C",
                str(git_root),
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
            ],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        common_p = Path(common)
        if common_p.name == ".git":
            return common_p.parent
    except Exception:
        pass
    # Fallback: parse gitdir file → …/repo/.git/worktrees/<slug>
    g = git_root / ".git"
    if g.is_file():
        try:
            text = g.read_text(encoding="utf-8").strip()
        except Exception:
            text = ""
        if text.lower().startswith("gitdir:"):
            gitdir = Path(text.split(":", 1)[1].strip())
            if gitdir.parent.name == "worktrees" and gitdir.parent.parent.name == ".git":
                return gitdir.parent.parent.parent
            if gitdir.name == ".git":
                return gitdir.parent
    if g.is_dir():
        return git_root
    return None

alias_map = {}
path_map = {}
for key, meta in targets.items():
    alias_map[key.lower()] = key
    for a in meta.get("aliases") or []:
        alias_map[a.lower()] = key
    if meta.get("path"):
        path_map[norm(meta["path"])] = key

hint = hint or ""
if not hint or hint in (".", "cwd"):
    cwd = norm(os.getcwd())
    p = Path(cwd)
    hit = None
    # 1) Exact allowlisted path while walking parents (primary + subdirs).
    for cand in [p, *p.parents]:
        n = norm(cand)
        if n in path_map:
            hit = path_map[n]
            break
    # 2) Linked worktree / nested checkout → map via primary worktree root.
    if not hit:
        main = git_main_worktree_root(p)
        if main is not None:
            n = norm(main)
            if n in path_map:
                hit = path_map[n]
            else:
                base = Path(n).name.lower()
                if base in alias_map:
                    hit = alias_map[base]
    # 3) Longest allowlisted path-prefix of cwd (odd layouts / non-git dirs).
    if not hit:
        best = None
        best_len = -1
        for path, key in path_map.items():
            if cwd == path or cwd.startswith(path + os.sep):
                if len(path) > best_len:
                    best, best_len = key, len(path)
        hit = best
    if not hit:
        print("error: cannot resolve target from cwd; pass --to <key>", file=sys.stderr)
        sys.exit(2)
    print(hit)
    sys.exit(0)

key = alias_map.get(hint.lower())
if not key:
    print(f"error: unknown target {hint!r}; known: {', '.join(sorted(targets))}", file=sys.stderr)
    sys.exit(2)
print(key)
PY
}

delegate_target_path() {
  local key=$1
  local root cfg
  root="$(delegate_tickets_root)"
  cfg="$root/config.yml"
  DELEGATE_KEY="$key" python3 - "$cfg" <<'PY'
import os, re, sys
from pathlib import Path
cfg_path = Path(sys.argv[1])
key = os.environ["DELEGATE_KEY"]
text = cfg_path.read_text(encoding="utf-8")
cur = None
path = None
for line in text.splitlines():
    m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
    if m:
        cur = m.group(1)
        continue
    if cur == key:
        m = re.match(r"^    path:\s*(.+?)\s*$", line)
        if m:
            path = os.path.expanduser(m.group(1).strip().strip("\"'"))
            break
if not path:
    print(f"error: no path for target {key}", file=sys.stderr)
    sys.exit(2)
print(path)
PY
}

delegate_new_id() {
  local stamp rand
  stamp="$(date -u +"%Y%m%d-%H%M%S")"
  rand="$(python3 -c 'import secrets; print(secrets.token_hex(3))')"
  printf 'req-%s-%s' "$stamp" "$rand"
}

# Bucket for by-target derived view
delegate_bucket_for() {
  local status=$1 owner=$2
  case "$status" in
    closed|rejected) printf 'done' ;;
    waiting_initiator|shipped)
      printf 'waiting-on-peer'
      ;;
    in_progress) printf 'in-progress' ;;
    submitted|waiting_target|failed) printf 'inbox' ;;
    *)
      if [[ "$owner" == "initiator" ]]; then
        printf 'waiting-on-peer'
      else
        printf 'inbox'
      fi
      ;;
  esac
}
