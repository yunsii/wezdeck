#!/usr/bin/env bash
# agent-workspace-trust-lib.sh — pre-trust managed workspace directories before
# launching interactive agent CLIs (Claude, Codex, Agy).
#
# Managed panes only launch in directories the user explicitly opened (workspace
# tab, Alt+g, Ctrl+k g d, or signed Web session.new / session.handoff). Seeding
# workspace trust up front stops new worktree paths from stalling on an
# interactive trust prompt and lets Web sessions auto-enter after the first
# message is sent.
#
# shellcheck shell=bash

_agent_trust_log() {
  local level="$1"
  local message="$2"
  shift 2
  local fn="runtime_log_${level}"
  if declare -F "$fn" >/dev/null 2>&1; then
    "$fn" primary_pane "$message" "$@" || true
  fi
}

_agent_trust_run_python() {
  local agent="$1"
  local target_file="$2"
  local cwd="${3:-${PWD:-}}"
  local mode="$4"
  local out=""

  [[ -n "$cwd" ]] || return 0
  if ! command -v python3 >/dev/null 2>&1; then
    _agent_trust_log warn "agent workspace trust skipped" \
      "agent=$agent" "reason=python3_missing" "cwd=$cwd"
    return 0
  fi

  if out="$(python3 - "$mode" "$target_file" "$cwd" <<'PY' 2>&1
import fcntl
import json
import os
import re
import stat
import sys
import tempfile
import tomllib

mode, path, raw_cwd = sys.argv[1], sys.argv[2], sys.argv[3]

def target_paths(cwd):
    out = []
    for cand in (cwd, os.path.realpath(cwd)):
        if not cand:
            continue
        norm = os.path.normpath(cand)
        if norm not in out:
            out.append(norm)
    return out

def atomic_write(dest, content):
    parent = os.path.dirname(dest) or "."
    os.makedirs(parent, mode=0o700, exist_ok=True)
    perm = 0o600
    try:
        perm = stat.S_IMODE(os.stat(dest).st_mode)
    except FileNotFoundError:
        pass
    fd, tmp = tempfile.mkstemp(prefix=".wezdeck-trust-", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, perm)
        os.replace(tmp, dest)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

def with_lock(dest, fn):
    parent = os.path.dirname(dest) or "."
    os.makedirs(parent, mode=0o700, exist_ok=True)
    lock_path = dest + ".wezdeck.lock"
    with open(lock_path, "a+", encoding="utf-8") as lock_f:
        fcntl.flock(lock_f.fileno(), fcntl.LOCK_EX)
        try:
            return fn()
        finally:
            fcntl.flock(lock_f.fileno(), fcntl.LOCK_UN)

def load_json_dict(dest):
    try:
        with open(dest, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("json root is not an object")
        return data
    except FileNotFoundError:
        return {}

paths = target_paths(raw_cwd)
if not paths:
    sys.exit(0)

if mode == "claude":
    def already(data):
        projects = data.get("projects")
        if not isinstance(projects, dict):
            return False
        return all(
            isinstance(projects.get(p), dict) and projects[p].get("hasTrustDialogAccepted") is True
            for p in paths
        )

    if already(load_json_dict(path)):
        sys.exit(0)

    def update():
        data = load_json_dict(path)
        if already(data):
            return False
        projects = data.get("projects")
        if not isinstance(projects, dict):
            projects = {}
            data["projects"] = projects
        for p in paths:
            entry = projects.get(p) if isinstance(projects.get(p), dict) else {}
            entry["hasTrustDialogAccepted"] = True
            projects[p] = entry
        atomic_write(path, json.dumps(data, indent=2) + "\n")
        return True

    if with_lock(path, update):
        print("added")

elif mode == "agy":
    def already(data):
        trusted = data.get("trustedWorkspaces")
        if not isinstance(trusted, list):
            return False
        norm_set = {os.path.normpath(x) for x in trusted if isinstance(x, str) and x}
        return all(p in norm_set for p in paths)

    if already(load_json_dict(path)):
        sys.exit(0)

    def update():
        data = load_json_dict(path)
        if already(data):
            return False
        trusted = data.get("trustedWorkspaces")
        if not isinstance(trusted, list):
            trusted = []
        norm_set = {os.path.normpath(x) for x in trusted if isinstance(x, str) and x}
        for p in paths:
            if p not in norm_set:
                trusted.append(p)
                norm_set.add(p)
        data["trustedWorkspaces"] = trusted
        atomic_write(path, json.dumps(data, indent=2) + "\n")
        return True

    if with_lock(path, update):
        print("added")

elif mode == "codex":
    def load_toml_text(dest):
        try:
            with open(dest, encoding="utf-8") as f:
                text = f.read()
        except FileNotFoundError:
            return "", {}
        data = tomllib.loads(text) if text.strip() else {}
        return text, data

    def missing_paths(data):
        projects = data.get("projects")
        if not isinstance(projects, dict):
            return list(paths)
        out = []
        for p in paths:
            entry = projects.get(p)
            if not (isinstance(entry, dict) and entry.get("trust_level") == "trusted"):
                out.append(p)
        return out

    _, initial = load_toml_text(path)
    if not missing_paths(initial):
        sys.exit(0)

    def escape_toml_key(val):
        return val.replace("\\", "\\\\").replace('"', '\\"')

    def upsert_section(text, p):
        header = f'[projects."{escape_toml_key(p)}"]'
        lines = text.splitlines()
        idx = None
        for i, line in enumerate(lines):
            if line.strip() == header:
                idx = i
                break
        if idx is None:
            if text and not text.endswith("\n"):
                text += "\n"
            if text and not text.endswith("\n\n"):
                text += "\n"
            return text + header + '\ntrust_level = "trusted"\n'
        end = len(lines)
        for j in range(idx + 1, len(lines)):
            stripped = lines[j].strip()
            if stripped.startswith("[") and not stripped.startswith("[["):
                end = j
                break
        replaced = False
        for j in range(idx + 1, end):
            if re.match(r"^\s*trust_level\s*=", lines[j]):
                lines[j] = 'trust_level = "trusted"'
                replaced = True
                break
        if not replaced:
            lines.insert(idx + 1, 'trust_level = "trusted"')
        return "\n".join(lines) + "\n"

    def update():
        text, data = load_toml_text(path)
        todo = missing_paths(data)
        if not todo:
            return False
        updated = text
        for p in todo:
            updated = upsert_section(updated, p)
        # Validate resulting TOML before replacing the live config.
        parsed = tomllib.loads(updated)
        if missing_paths(parsed):
            raise ValueError("codex trust verification failed after edit")
        atomic_write(path, updated)
        return True

    if with_lock(path, update):
        print("added")
PY
  )"; then
    if [[ "$out" == "added" ]]; then
      _agent_trust_log info "agent workspace trust ensured" \
        "agent=$agent" "cwd=$cwd" "target=$target_file"
    fi
  else
    _agent_trust_log warn "agent workspace trust failed" \
      "agent=$agent" "cwd=$cwd" "target=$target_file" "err=${out%%$'\n'*}"
  fi
}

ensure_claude_workspace_trust() {
  local cwd="${1:-${PWD:-}}"
  local target="${CLAUDE_CONFIG_DIR:+$CLAUDE_CONFIG_DIR/.claude.json}"
  target="${target:-$HOME/.claude.json}"
  _agent_trust_run_python claude "$target" "$cwd" claude
}

ensure_codex_workspace_trust() {
  local cwd="${1:-${PWD:-}}"
  local target="${CODEX_HOME:-$HOME/.codex}/config.toml"
  _agent_trust_run_python codex "$target" "$cwd" codex
}

ensure_agy_workspace_trust() {
  local cwd="${1:-${PWD:-}}"
  local target="${AGY_CONFIG_DIR:-$HOME/.gemini/antigravity-cli}/settings.json"
  _agent_trust_run_python agy "$target" "$cwd" agy
}
