#!/usr/bin/env python3
"""Compile WezDeck plugins into generated registries.

Inputs
  <repo>/wezterm-x/plugins/<id>/plugin.json        built-in plugins
  $WEZDECK_PLUGIN_DIR/<id>/plugin.json             machine plugins
                                                   (default ~/.config/wezdeck/plugins)
  <repo>/wezterm-x/local/plugins.json              {"disabled": [...], "enabled": [...],
                                                    "config": {id: {...}}}
Outputs (gitignored, under <repo>/wezterm-x/plugins/)
  registry.generated.json   every discovered plugin + enabled flag (CLIs read)
  registry.generated.lua    enabled plugins with a badge (WezTerm reads)
  .external/<id>/           copy of each enabled machine plugin, so sync ships
                            its Lua to the Windows runtime tree

Exit 1 with one line per violation when any plugin is invalid — sync runs
this before publication, so a bad plugin never reaches the live runtime.
Docs: docs/plugin-architecture.md
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
KNOWN_KEYS = {"$comment", "id", "name", "kind", "default_enabled", "requires",
              "badge", "producer", "cli", "agent", "docs"}
HOSTS = {"hybrid-wsl", "posix"}


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def discover(builtin_dir: Path, external_dir: Path | None) -> list[tuple[str, Path, dict | None, str]]:
    """(source, plugin_dir, manifest or None, parse_error)."""
    out = []
    for source, root in (("builtin", builtin_dir), ("external", external_dir)):
        if not root or not root.is_dir():
            continue
        for d in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")):
            mf = d / "plugin.json"
            if not mf.is_file():
                continue
            try:
                out.append((source, d, load_json(mf), ""))
            except (OSError, ValueError) as exc:
                out.append((source, d, None, f"{mf}: invalid JSON: {exc}"))
    return out


def validate(source: str, d: Path, m: dict) -> list[str]:
    errs: list[str] = []
    where = f"{source}:{d.name}"
    pid = m.get("id")
    if not isinstance(pid, str) or not ID_RE.match(pid):
        errs.append(f"{where}: id must match [a-z0-9-]+ (got {pid!r})")
    elif pid != d.name:
        errs.append(f"{where}: id {pid!r} must equal directory name {d.name!r}")
    unknown = set(m) - KNOWN_KEYS
    if unknown:
        errs.append(f"{where}: unknown keys {sorted(unknown)}")
    req = m.get("requires", {})
    hosts = req.get("host", []) if isinstance(req, dict) else None
    if hosts is None or not isinstance(hosts, list) or set(hosts) - HOSTS:
        errs.append(f"{where}: requires.host must be a subset of {sorted(HOSTS)}")

    def need_file(rel, what):
        if not isinstance(rel, str) or not rel:
            errs.append(f"{where}: {what} must be a relative path")
        elif not (d / rel).is_file():
            errs.append(f"{where}: {what} {rel!r} not found")

    badge = m.get("badge")
    if badge is not None:
        if not isinstance(badge, dict):
            errs.append(f"{where}: badge must be an object")
        else:
            need_file(badge.get("module"), "badge.module")
            if not isinstance(badge.get("order"), int):
                errs.append(f"{where}: badge.order must be an integer")
            if not isinstance(badge.get("config", {}), dict):
                errs.append(f"{where}: badge.config must be an object")
    producer = m.get("producer")
    if producer is not None:
        if not isinstance(producer, dict) or "install" not in producer:
            errs.append(f"{where}: producer needs an install command")
        else:
            for k in ("install", "check", "uninstall"):
                if k in producer:
                    need_file(str(producer[k]).split()[0], f"producer.{k}")
    cli = m.get("cli", {})
    if not isinstance(cli, dict):
        errs.append(f"{where}: cli must be an object of name → relative path")
    else:
        for name, rel in cli.items():
            if not ID_RE.match(name):
                errs.append(f"{where}: cli name {name!r} must match [a-z0-9-]+")
            need_file(rel, f"cli.{name}")
    agent = m.get("agent")
    if agent is not None:
        if not isinstance(agent, dict):
            errs.append(f"{where}: agent must be an object")
        else:
            for k, rel in agent.items():
                need_file(rel, f"agent.{k}")
    if "docs" in m:
        need_file(m["docs"], "docs")
    # Observability (design stance #3): background work must be visible.
    if producer is not None and badge is None and not cli:
        errs.append(f"{where}: a producer needs a badge or a cli — blind background work is rejected")
    return errs


def lua_literal(v, indent=0) -> str:
    pad = "  " * indent
    if v is None:
        return "nil"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)  # JSON string escapes are valid Lua
    if isinstance(v, list):
        if not v:
            return "{}"
        inner = ",\n".join(pad + "  " + lua_literal(x, indent + 1) for x in v)
        return "{\n" + inner + ",\n" + pad + "}"
    if isinstance(v, dict):
        if not v:
            return "{}"
        items = []
        for k in sorted(v):
            key = k if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", k) else "[" + json.dumps(k) + "]"
            items.append(pad + "  " + key + " = " + lua_literal(v[k], indent + 1))
        return "{\n" + ",\n".join(items) + ",\n" + pad + "}"
    raise TypeError(f"cannot encode {type(v)}")


def compile_plugins(repo: Path, external_dir: Path | None, local_cfg_path: Path, out_dir: Path) -> tuple[dict, list[str]]:
    builtin_dir = repo / "wezterm-x" / "plugins"
    local = load_json(local_cfg_path) if local_cfg_path.is_file() else {}
    disabled = set(local.get("disabled", []))
    force_on = set(local.get("enabled", []))
    overrides = local.get("config", {})

    errors: list[str] = []
    plugins = []
    seen: dict[str, str] = {}
    for source, d, m, perr in discover(builtin_dir, external_dir):
        if perr:
            errors.append(perr)
            continue
        errs = validate(source, d, m)
        pid = m.get("id", d.name)
        if pid in seen:
            errs.append(f"{source}:{d.name}: duplicate id {pid!r} (also {seen[pid]})")
        seen[pid] = f"{source}:{d.name}"
        if errs:
            errors.extend(errs)
            continue
        enabled = (m.get("default_enabled", True) or pid in force_on) and pid not in disabled
        rel_dir = f"plugins/{pid}" if source == "builtin" else f"plugins/.external/{pid}"
        entry = {
            "id": pid,
            "name": m.get("name", pid),
            "kind": m.get("kind", ""),
            "source": source,
            "enabled": enabled,
            "dir": str(d),
            "runtime_dir": rel_dir,
            "requires_host": m.get("requires", {}).get("host", []),
            "manifest": m,
        }
        if "badge" in m:
            cfg = dict(m["badge"].get("config", {}))
            cfg.update(overrides.get(pid, {}))
            entry["badge"] = {"module": m["badge"]["module"], "order": m["badge"]["order"], "config": cfg}
        plugins.append(entry)

    for unknown in sorted((disabled | force_on | set(overrides)) - set(seen)):
        errors.append(f"local/plugins.json: unknown plugin id {unknown!r}")

    orders: dict[int, str] = {}
    for p in plugins:
        if p["enabled"] and "badge" in p:
            o = p["badge"]["order"]
            if o in orders:
                errors.append(f"badge.order {o} used by both {orders[o]!r} and {p['id']!r}")
            orders[o] = p["id"]

    registry = {"version": 1, "plugins": plugins}
    if errors:
        return registry, errors

    out_dir.mkdir(parents=True, exist_ok=True)
    ext_root = out_dir / ".external"
    if ext_root.exists():
        shutil.rmtree(ext_root)
    for p in plugins:
        if p["source"] == "external" and p["enabled"]:
            shutil.copytree(p["dir"], ext_root / p["id"])

    write_atomic(out_dir / "registry.generated.json", json.dumps(registry, ensure_ascii=False, indent=2) + "\n")
    badges = sorted(
        ({"id": p["id"], "dir": p["runtime_dir"], "requires_host": p["requires_host"], **p["badge"]}
         for p in plugins if p["enabled"] and "badge" in p),
        key=lambda b: b["order"],
    )
    lua = ("-- Generated by scripts/runtime/render-plugins.sh — do not edit.\n"
           "-- Enabled plugins that contribute a right-status badge, in render order.\n"
           "return " + lua_literal({"version": 1, "badges": badges}) + "\n")
    write_atomic(out_dir / "registry.generated.lua", lua)
    return registry, []


def write_atomic(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--repo", required=True)
    ap.add_argument("--external-dir", default=os.environ.get("WEZDECK_PLUGIN_DIR") or str(Path.home() / ".config/wezdeck/plugins"))
    ap.add_argument("--local-config", default="")
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()
    repo = Path(a.repo)
    local_cfg = Path(a.local_config) if a.local_config else repo / "wezterm-x/local/plugins.json"
    out_dir = Path(a.out_dir) if a.out_dir else repo / "wezterm-x/plugins"
    ext = Path(a.external_dir) if a.external_dir else None
    try:
        registry, errors = compile_plugins(repo, ext, local_cfg, out_dir)
    except (OSError, ValueError) as exc:
        print(f"render-plugins: {exc}", file=sys.stderr)
        return 1
    if errors:
        for e in errors:
            print(f"render-plugins: {e}", file=sys.stderr)
        return 1
    if not a.quiet:
        on = [p["id"] for p in registry["plugins"] if p["enabled"]]
        off = [p["id"] for p in registry["plugins"] if not p["enabled"]]
        print(f"render-plugins: enabled={','.join(on) or '-'} disabled={','.join(off) or '-'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
