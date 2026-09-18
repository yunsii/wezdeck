"""Aggregate weekly git churn across local repos (configurable excludes).

Config (first found):
  1) $HABIT_GIT_CHURN_CONFIG
  2) ~/.config/habit-weekly/git-churn.json
  3) built-in defaults (see git_churn.example.json)

Privacy: counts only — no commit messages / diffs in the payload.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, timedelta
from fnmatch import fnmatch
from pathlib import Path
from typing import Any

_DEFAULT_ROOTS = ["~/work", "~/github"]
_DEFAULT_EXCLUDE_REPOS = [
    "wezdeck-habit-weekly",
    "wezterm",  # upstream clone; keep wezterm-config (this product repo)
    "fe1",
    "management-operations",
    "operations",
    "operations-monkey",
    "ci-infra",
    "infra",
    "dev-ops-mcp-server",
    "platform-core-tech-weekly",
    "weekly-report",
    "team-stat",
    "members-stat",
    "coco-web-infra",
]
_DEFAULT_EXCLUDE_REPO_GLOBS = [
    "*ops*",
    "*infra*",
    "*weekly*",
    "*habit*",
    "*admin*",
    "management-*",
    "*dotfile*",
]
_DEFAULT_EXCLUDE_PATH_GLOBS = [
    "vendor/**",
    "node_modules/**",
    "dist/**",
    "build/**",
    ".next/**",
    ".turbo/**",
    "coverage/**",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "Cargo.lock",
    "go.sum",
    "*.min.js",
    "*.min.css",
    "**/*.generated.*",
    "**/__generated__/**",
]


@dataclass
class ChurnConfig:
    enabled: str = "auto"  # auto | on | off
    roots: list[str] = field(default_factory=lambda: list(_DEFAULT_ROOTS))
    authors: list[str] = field(default_factory=list)
    exclude_repos: list[str] = field(
        default_factory=lambda: list(_DEFAULT_EXCLUDE_REPOS)
    )
    exclude_repo_globs: list[str] = field(
        default_factory=lambda: list(_DEFAULT_EXCLUDE_REPO_GLOBS)
    )
    exclude_path_globs: list[str] = field(
        default_factory=lambda: list(_DEFAULT_EXCLUDE_PATH_GLOBS)
    )
    max_depth: int = 2
    include_worktrees: bool = False
    top_repos: int = 12
    config_path: str | None = None


def config_candidates() -> list[Path]:
    out: list[Path] = []
    env = os.environ.get("HABIT_GIT_CHURN_CONFIG", "").strip()
    if env:
        out.append(Path(env).expanduser())
    out.append(Path.home() / ".config/habit-weekly/git-churn.json")
    return out


def load_config() -> ChurnConfig:
    cfg = ChurnConfig()
    for path in config_candidates():
        if not path.is_file():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(raw, dict):
            continue
        cfg.config_path = str(path)
        if isinstance(raw.get("enabled"), str):
            cfg.enabled = raw["enabled"].strip().lower() or "auto"
        if isinstance(raw.get("roots"), list):
            cfg.roots = [str(x) for x in raw["roots"] if str(x).strip()]
        if isinstance(raw.get("authors"), list):
            cfg.authors = [str(x) for x in raw["authors"] if str(x).strip()]
        if isinstance(raw.get("exclude_repos"), list):
            cfg.exclude_repos = [str(x) for x in raw["exclude_repos"]]
        if isinstance(raw.get("exclude_repo_globs"), list):
            cfg.exclude_repo_globs = [str(x) for x in raw["exclude_repo_globs"]]
        if isinstance(raw.get("exclude_path_globs"), list):
            cfg.exclude_path_globs = [str(x) for x in raw["exclude_path_globs"]]
        if isinstance(raw.get("max_depth"), int) and raw["max_depth"] >= 1:
            cfg.max_depth = int(raw["max_depth"])
        if isinstance(raw.get("include_worktrees"), bool):
            cfg.include_worktrees = raw["include_worktrees"]
        if isinstance(raw.get("top_repos"), int) and raw["top_repos"] >= 1:
            cfg.top_repos = int(raw["top_repos"])
        break
    return cfg


def device_profile_is_work() -> bool:
    env = os.environ.get("WEZDECK_DEVICE_PROFILE", "").strip().lower()
    if env == "work":
        return True
    candidates = [
        Path(__file__).resolve().parents[3] / "wezterm-x/local/constants.lua",
        Path.home() / "github/wezterm-config/wezterm-x/local/constants.lua",
        Path.home() / "github/wezdeck/wezterm-x/local/constants.lua",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if re.search(r"device_profile\s*=\s*['\"]work['\"]", text):
            return True
    return False


def _expand_roots(roots: list[str]) -> list[Path]:
    out: list[Path] = []
    for raw in roots:
        p = Path(raw).expanduser()
        if p.is_dir():
            out.append(p.resolve())
    return out


def _repo_excluded(name: str, cfg: ChurnConfig) -> bool:
    if name in cfg.exclude_repos:
        return True
    for pat in cfg.exclude_repo_globs:
        if fnmatch(name, pat):
            return True
    return False


def _path_excluded(rel: str, cfg: ChurnConfig) -> bool:
    from pathlib import PurePosixPath

    path = rel.replace("\\", "/")
    pure = PurePosixPath(path)
    name = pure.name
    for pat in cfg.exclude_path_globs:
        if fnmatch(path, pat) or fnmatch(name, pat):
            return True
        try:
            if pure.match(pat) or pure.match("**/" + pat.lstrip("/")):
                return True
        except ValueError:
            pass
        # Directory markers: node_modules, vendor, .next, …
        core = pat.replace("**/", "").replace("/**", "").strip("*").strip("/")
        if core and "*" not in core and "/" not in core and core in pure.parts:
            return True
    return False


def _is_git_repo(path: Path) -> bool:
    git = path / ".git"
    return git.is_dir() or git.is_file()


def discover_repos(cfg: ChurnConfig) -> list[Path]:
    found: list[Path] = []
    seen: set[Path] = set()

    def add(p: Path) -> None:
        try:
            rp = p.resolve()
        except OSError:
            return
        if rp in seen:
            return
        if not _is_git_repo(rp):
            return
        if _repo_excluded(rp.name, cfg):
            return
        seen.add(rp)
        found.append(rp)

    for root in _expand_roots(cfg.roots):
        add(root)  # root itself may be a repo
        if cfg.max_depth < 1:
            continue
        try:
            children = list(root.iterdir())
        except OSError:
            continue
        for child in children:
            if not child.is_dir():
                continue
            if child.name.startswith("."):
                if child.name == ".worktrees" and cfg.include_worktrees:
                    # one more level under .worktrees/<repo>/...
                    try:
                        for wt in child.iterdir():
                            if wt.is_dir():
                                add(wt)
                                if cfg.max_depth >= 3:
                                    for nested in wt.iterdir():
                                        if nested.is_dir():
                                            add(nested)
                    except OSError:
                        pass
                continue
            add(child)
            if cfg.max_depth >= 2:
                try:
                    for nested in child.iterdir():
                        if nested.is_dir() and not nested.name.startswith("."):
                            add(nested)
                except OSError:
                    pass
    return sorted(found, key=lambda p: p.name.lower())


def _default_authors() -> list[str]:
    out: list[str] = []
    for key in ("user.email", "user.name"):
        try:
            val = subprocess.check_output(
                ["git", "config", "--global", "--get", key],
                text=True,
                stderr=subprocess.DEVNULL,
            ).strip()
        except (OSError, subprocess.CalledProcessError):
            val = ""
        if val:
            out.append(val)
    return out


def _git_numstat(
    repo: Path,
    *,
    start: date,
    end: date,
    authors: list[str],
    cfg: ChurnConfig,
) -> dict[str, Any]:
    since = start.isoformat()
    until = (end + timedelta(days=1)).isoformat()
    cmd = [
        "git",
        "-C",
        str(repo),
        "log",
        f"--since={since}",
        f"--until={until}",
        "--numstat",
        "--pretty=tformat:COMMIT %H",
    ]
    for a in authors:
        cmd.append(f"--author={a}")
    try:
        raw = subprocess.check_output(
            cmd, text=True, stderr=subprocess.DEVNULL, timeout=60
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return {
            "repo": repo.name,
            "path": str(repo),
            "commits": 0,
            "insertions": 0,
            "deletions": 0,
            "files": 0,
            "skipped_paths": 0,
            "error": "git_log_failed",
        }

    commits = 0
    insertions = 0
    deletions = 0
    files: set[str] = set()
    skipped = 0
    for line in raw.splitlines():
        if line.startswith("COMMIT "):
            commits += 1
            continue
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        ins_s, del_s, path = parts[0], parts[1], parts[2]
        # renames: old => new
        if " => " in path:
            path = path.split(" => ", 1)[-1].strip("{}")
        if _path_excluded(path, cfg):
            skipped += 1
            continue
        if ins_s == "-" or del_s == "-":
            # binary
            files.add(path)
            continue
        try:
            insertions += int(ins_s)
            deletions += int(del_s)
        except ValueError:
            continue
        files.add(path)

    return {
        "repo": repo.name,
        "path": str(repo),
        "commits": commits,
        "insertions": insertions,
        "deletions": deletions,
        "files": len(files),
        "skipped_paths": skipped,
    }


def collect_git_churn(*, start: date, end: date, cfg: ChurnConfig | None = None) -> dict[str, Any]:
    cfg = cfg or load_config()
    authors = list(cfg.authors) or _default_authors()
    repos = discover_repos(cfg)
    per_repo: list[dict[str, Any]] = []
    total = Counter()
    excluded_names = sorted(set(cfg.exclude_repos))

    for repo in repos:
        row = _git_numstat(repo, start=start, end=end, authors=authors, cfg=cfg)
        if row.get("commits") or row.get("insertions") or row.get("deletions"):
            per_repo.append(row)
            total["commits"] += int(row.get("commits") or 0)
            total["insertions"] += int(row.get("insertions") or 0)
            total["deletions"] += int(row.get("deletions") or 0)
            total["files"] += int(row.get("files") or 0)
            total["skipped_paths"] += int(row.get("skipped_paths") or 0)

    per_repo.sort(
        key=lambda r: -(int(r.get("insertions") or 0) + int(r.get("deletions") or 0))
    )
    top_n = per_repo[: cfg.top_repos]

    return {
        "ok": True,
        "enabled": True,
        "window": {"start": start.isoformat(), "end": end.isoformat()},
        "authors": authors,
        "repos_scanned": len(repos),
        "repos_with_activity": len(per_repo),
        "commits": int(total["commits"]),
        "insertions": int(total["insertions"]),
        "deletions": int(total["deletions"]),
        "files": int(total["files"]),
        "skipped_paths": int(total["skipped_paths"]),
        "top_repos": top_n,
        "config_path": cfg.config_path,
        "exclude_repos": excluded_names,
        "exclude_repo_globs": list(cfg.exclude_repo_globs),
        "exclude_path_globs": list(cfg.exclude_path_globs),
        "notes": [
            "Counts from git log --numstat for configured authors; "
            "exclude_repos / exclude_repo_globs / exclude_path_globs are configurable "
            "via ~/.config/habit-weekly/git-churn.json",
            "Docs/ops/infra-style repos excluded by default on work machines",
        ],
    }


def ensure_default_config() -> Path | None:
    """Write example config to ~/.config/habit-weekly/git-churn.json if missing."""
    dest = Path.home() / ".config/habit-weekly/git-churn.json"
    if dest.is_file():
        return dest
    example = Path(__file__).with_name("git_churn.example.json")
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        if example.is_file():
            dest.write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
        else:
            dest.write_text(
                json.dumps(
                    {
                        "enabled": "auto",
                        "roots": _DEFAULT_ROOTS,
                        "exclude_repos": _DEFAULT_EXCLUDE_REPOS,
                        "exclude_repo_globs": _DEFAULT_EXCLUDE_REPO_GLOBS,
                        "exclude_path_globs": _DEFAULT_EXCLUDE_PATH_GLOBS,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
        return dest
    except OSError:
        return None
