#!/usr/bin/env python3
"""wezdeck-plugin — list / enable / disable / doctor / install / run plugins.

  list                      every discovered plugin, enabled state, contributions
  enable|disable <id>...    edit wezterm-x/local/plugins.json, then recompile
  doctor [<id>...]          files, producer check, status freshness per plugin
  install|uninstall <id>    run the plugin's producer.install / uninstall
  run <id> <cli> [args...]  exec one of the plugin's declared CLIs

enable / disable recompile the registry immediately, which is all agent
providers (review / habit) need; right-status badges reach WezTerm on the next
`sync-runtime.sh` (pass --sync to run it). Docs: docs/plugin-architecture.md
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import plugins_compile as pc  # noqa: E402


class Ctx:
    def __init__(self, repo: Path):
        self.repo = repo
        self.local_cfg = Path(os.environ.get("WEZDECK_PLUGIN_LOCAL_CONFIG") or repo / "wezterm-x/local/plugins.json")
        self.out_dir = Path(os.environ.get("WEZDECK_PLUGIN_OUT_DIR") or repo / "wezterm-x/plugins")
        ext = os.environ.get("WEZDECK_PLUGIN_DIR") or str(Path.home() / ".config/wezdeck/plugins")
        self.ext_dir = Path(ext)
        # WSL-side path of the Windows runtime state dir, for doctor freshness.
        self.state_dir = os.environ.get("WEZDECK_RUNTIME_STATE_DIR", "")

    def compile(self, write: bool = True):
        out = self.out_dir if write else Path(tempfile.mkdtemp(prefix="wezdeck-plugin-"))
        return pc.compile_plugins(self.repo, self.ext_dir, self.local_cfg, out)

    def plugins(self) -> list[dict]:
        reg, errs = self.compile(write=False)
        for e in errs:
            print(f"error: {e}", file=sys.stderr)
        return reg["plugins"]

    def find(self, pid: str) -> dict:
        for p in self.plugins():
            if p["id"] == pid:
                return p
        sys.exit(f"wezdeck-plugin: unknown plugin {pid!r} (see `list`)")


def cmd_list(ctx: Ctx, args) -> int:
    rows = ctx.plugins()
    if args.json:
        print(json.dumps([{k: p[k] for k in ("id", "kind", "source", "enabled")} for p in rows], indent=2))
        return 0
    print(f"{'id':16} {'kind':13} {'source':8} {'state':8} contributes")
    for p in sorted(rows, key=lambda p: (p["kind"], p["id"])):
        m = p["manifest"]
        parts = []
        if "badge" in m:
            parts.append(f"badge@{m['badge']['order']}")
        if "producer" in m:
            parts.append("producer")
        if m.get("cli"):
            parts.append("cli:" + ",".join(m["cli"]))
        if "agent" in m:
            parts.append("agent:" + ",".join(m["agent"]))
        print(f"{p['id']:16} {p['kind']:13} {p['source']:8} {'on' if p['enabled'] else 'off':8} {' '.join(parts)}")
    print(f"\nlocal config: {ctx.local_cfg}{'' if ctx.local_cfg.exists() else ' (absent: defaults)'}")
    return 0


def edit_local(ctx: Ctx, ids: list[str], enable: bool) -> None:
    known = {p["id"]: p for p in ctx.plugins()}
    for pid in ids:
        if pid not in known:
            sys.exit(f"wezdeck-plugin: unknown plugin {pid!r} (see `list`)")
    cfg = json.loads(ctx.local_cfg.read_text(encoding="utf-8")) if ctx.local_cfg.exists() else {}
    disabled, enabled = list(cfg.get("disabled", [])), list(cfg.get("enabled", []))
    for pid in ids:
        default_on = known[pid]["manifest"].get("default_enabled", True) and known[pid]["source"] != "contrib"
        disabled = [x for x in disabled if x != pid]
        enabled = [x for x in enabled if x != pid]
        if enable and not default_on:
            enabled.append(pid)
        if not enable:
            disabled.append(pid)
    for key, val in (("disabled", disabled), ("enabled", enabled)):
        if val:
            cfg[key] = sorted(set(val))
        else:
            cfg.pop(key, None)
    ctx.local_cfg.parent.mkdir(parents=True, exist_ok=True)
    pc.write_atomic(ctx.local_cfg, json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")


def cmd_toggle(ctx: Ctx, args, enable: bool) -> int:
    edit_local(ctx, args.ids, enable)
    reg, errs = ctx.compile(write=True)
    if errs:
        for e in errs:
            print(f"error: {e}", file=sys.stderr)
        return 1
    state = {p["id"]: p["enabled"] for p in reg["plugins"]}
    for pid in args.ids:
        print(f"{pid}: {'enabled' if state[pid] else 'disabled'}")
        p = next(x for x in reg["plugins"] if x["id"] == pid)
        if not enable and "producer" in p["manifest"]:
            print(f"  note: its background producer keeps running; stop it with `wezdeck-plugin.sh uninstall {pid}`")
    if args.sync:
        return subprocess.call([str(ctx.repo / "skills/wezdeck-runtime-ops/scripts/sync-runtime.sh")])
    print("registry recompiled (agent providers apply now); run skills/wezdeck-runtime-ops/scripts/sync-runtime.sh to update WezTerm badges")
    return 0


def plugin_file(p: dict, rel: str) -> Path:
    return (Path(p["dir"]) / rel.split()[0]).resolve()


def run_hook(p: dict, cmd: str) -> int:
    parts = cmd.split()
    return subprocess.call([str(plugin_file(p, parts[0]))] + parts[1:])


def cmd_doctor(ctx: Ctx, args) -> int:
    reg, errs = ctx.compile(write=False)
    worst = 0
    for e in errs:
        print(f"FAIL  compile  {e}")
        worst = 2
    rows = [p for p in reg["plugins"] if not args.ids or p["id"] in args.ids]
    for p in rows:
        if not p["enabled"]:
            print(f"off   {p['id']}")
            continue
        m = p["manifest"]
        notes, level = [], 0
        for name, rel in (m.get("cli") or {}).items():
            f = plugin_file(p, rel)
            if not os.access(f, os.X_OK):
                notes.append(f"cli {name} not executable: {f}")
                level = max(level, 2)
        if "producer" in m and "check" in m["producer"]:
            rc = subprocess.call(
                [str(plugin_file(p, m["producer"]["check"]))] + m["producer"]["check"].split()[1:],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if rc != 0:
                notes.append(f"producer check exited {rc}")
                level = max(level, 2)
            else:
                notes.append("producer check ok")
        badge = p.get("badge")
        if badge and ctx.state_dir:
            sf = str(badge["config"].get("state_file", "")).replace("${runtime_state_dir}", ctx.state_dir)
            timeout = badge["config"].get("heartbeat_timeout_ms")
            if sf and Path(sf).is_file():
                try:
                    hb = json.loads(Path(sf).read_text(encoding="utf-8")).get("heartbeat_at_ms")
                    age = time.time() * 1000 - float(hb)
                    if timeout and age > timeout:
                        notes.append(f"status stale {age / 1000:.0f}s > {timeout / 1000:.0f}s (badge shows ?/nothing)")
                        level = max(level, 1)
                    else:
                        notes.append(f"status fresh ({age / 1000:.0f}s)")
                except (ValueError, TypeError, OSError):
                    notes.append(f"status unreadable: {sf}")
                    level = max(level, 1)
            elif sf:
                notes.append("status not published yet")
                level = max(level, 1)
        for k, f in p.get("agent_files", {}).items():
            if not Path(f).is_file():
                notes.append(f"{k} missing: {f}")
                level = max(level, 2)
            else:
                notes.append(f"{k} ok")
        tag = ("ok  ", "WARN", "FAIL")[level]
        print(f"{tag}  {p['id']:16} {'; '.join(notes) or 'nothing to check'}")
        worst = max(worst, level)
    return 1 if worst == 2 else 0


def cmd_producer(ctx: Ctx, args, key: str) -> int:
    p = ctx.find(args.id)
    prod = p["manifest"].get("producer") or {}
    if key not in prod:
        sys.exit(f"wezdeck-plugin: {args.id} declares no producer.{key}")
    return run_hook(p, prod[key])


def cmd_run(ctx: Ctx, args) -> int:
    p = ctx.find(args.id)
    cli = p["manifest"].get("cli") or {}
    if args.cli not in cli:
        sys.exit(f"wezdeck-plugin: {args.id} has no cli {args.cli!r} (has: {', '.join(cli) or '-'})")
    f = plugin_file(p, cli[args.cli])
    os.execv(str(f), [str(f)] + args.args)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="wezdeck-plugin.sh", description=__doc__.split("\n")[0])
    ap.add_argument("--repo", required=True)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("list"); s.add_argument("--json", action="store_true")
    for name in ("enable", "disable"):
        s = sub.add_parser(name); s.add_argument("ids", nargs="+"); s.add_argument("--sync", action="store_true")
    s = sub.add_parser("doctor"); s.add_argument("ids", nargs="*")
    for name in ("install", "uninstall"):
        s = sub.add_parser(name); s.add_argument("id")
    s = sub.add_parser("run"); s.add_argument("id"); s.add_argument("cli"); s.add_argument("args", nargs=argparse.REMAINDER)
    args = ap.parse_args()
    ctx = Ctx(Path(args.repo))
    if args.cmd == "list":
        return cmd_list(ctx, args)
    if args.cmd in ("enable", "disable"):
        return cmd_toggle(ctx, args, args.cmd == "enable")
    if args.cmd == "doctor":
        return cmd_doctor(ctx, args)
    if args.cmd in ("install", "uninstall"):
        return cmd_producer(ctx, args, args.cmd)
    return cmd_run(ctx, args)


if __name__ == "__main__":
    sys.exit(main())
