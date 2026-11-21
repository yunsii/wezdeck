#!/usr/bin/env python3
"""Per-run observability for host-agent-invoke (stdlib only).

Subcommands (called by host-agent-invoke.sh when --run-dir is given):

  launch  --run-dir D --run-id R --backend B --mode M --cwd C --prompt-file P
          [--model X] [--effort X] [--add-dir X] [--resume ID] [--fork]
          [--extra FILE] [--sink-py FILE --sink-arg ARG] -- ARGV...
      Writes D/R.launch.json (immutable) and emits a run_start event.

  parse   --run-dir D --run-id R --backend B [--pid-file F] [--rc-file F]
          [--sink-py FILE --sink-arg ARG]
      Reads the CLI stdout stream on stdin, tees it to D/R.stream.jsonl,
      turns it into normalized events (session_init / tool / milestone /
      error / run_end), samples peak RSS of the CLI process tree, and writes
      the run record D/R.json at EOF.

Event sink: when --sink-py is given, that file is imported and
``sink_events(sink_arg, run_id, events)`` is called with batches of
``{"kind": str, "data": dict}``. Without a sink, events go to
D/R.events.jsonl. Sink failures never break the run (counted in the record).
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

TEXT_CAP = 400
MILESTONE_PREFIX = "进展："
ENV_KEYS = (
    "AI_AGENT",
    "MANAGED_AGENT_PROFILE",
    "CLAUDE_CODE_SESSION_ID",
    "TMUX_PANE",
    "TICKET_HEADLESS",
    "HOST_AGENT_HEADLESS",
    "AGENT_ATTENTION_SKIP",
)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def cap(text: Any, n: int = TEXT_CAP) -> str:
    s = "" if text is None else str(text)
    return s if len(s) <= n else s[: n - 1] + "…"


def est_tokens(text: str) -> int:
    # Rough: ~4 bytes/token for ASCII, ~1.5 chars/token for CJK. Labelled "est".
    ascii_n = sum(1 for ch in text if ord(ch) < 128)
    other = len(text) - ascii_n
    return int(ascii_n / 4 + other / 1.5)


class Sink:
    def __init__(self, run_dir: Path, run_id: str, sink_py: str | None, sink_arg: str | None):
        self.run_dir = run_dir
        self.run_id = run_id
        self.fn = None
        self.arg = sink_arg
        self.failures = 0
        self.buf: list[dict[str, Any]] = []
        self.last_flush = time.monotonic()
        self.lock = threading.Lock()
        if sink_py:
            try:
                spec = importlib.util.spec_from_file_location("run_observe_sink", sink_py)
                mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
                spec.loader.exec_module(mod)  # type: ignore[union-attr]
                self.fn = getattr(mod, "sink_events")
            except Exception as exc:  # noqa: BLE001
                self.failures += 1
                print(f"[run_observe] sink load failed: {exc}", file=sys.stderr)

    def emit(self, kind: str, data: dict[str, Any], *, flush: bool = False) -> None:
        with self.lock:
            self.buf.append({"kind": kind, "data": data, "ts": now_iso()})
        if flush or time.monotonic() - self.last_flush >= 1.0:
            self.flush()

    def flush(self) -> None:
        with self.lock:
            batch, self.buf = self.buf, []
            self.last_flush = time.monotonic()
        if not batch:
            return
        if self.fn is not None:
            try:
                self.fn(self.arg, self.run_id, batch)
                return
            except Exception as exc:  # noqa: BLE001
                self.failures += 1
                print(f"[run_observe] sink failed: {exc}", file=sys.stderr)
        path = self.run_dir / f"{self.run_id}.events.jsonl"
        with path.open("a", encoding="utf-8") as f:
            for ev in batch:
                f.write(json.dumps({"run": self.run_id, **ev}, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------- launch


def cmd_launch(ns: argparse.Namespace, argv: list[str]) -> int:
    run_dir = Path(ns.run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    prompt = Path(ns.prompt_file).read_text(encoding="utf-8", errors="replace")
    raw = prompt.encode("utf-8")
    base_sha = None
    try:
        base_sha = subprocess.run(
            ["git", "-C", ns.cwd, "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5, check=False,
        ).stdout.strip() or None
    except Exception:  # noqa: BLE001
        pass
    record: dict[str, Any] = {
        "v": 1,
        "run": ns.run_id,
        "ts": now_iso(),
        "invocation": {
            "backend": ns.backend,
            "mode": ns.mode,
            "model": ns.model or None,
            "effort": ns.effort or None,
            "cwd": ns.cwd,
            "add_dirs": [ns.add_dir] if ns.add_dir else [],
            "base_sha": base_sha,
            # prompt body is fed via stdin/--prompt-file; never inlined here
            "argv": [a for a in argv if a != "-"],
            "env_keys": sorted(k for k in ENV_KEYS if os.environ.get(k)),
            "resume": {"id": ns.resume, "fork": bool(ns.fork)} if ns.resume else None,
        },
        "prompt": {
            "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw),
            "est_tokens": est_tokens(prompt),
            "path": str(Path(ns.prompt_file).resolve()),
        },
        "origin": {
            "ai_agent": os.environ.get("AI_AGENT"),
            "session": os.environ.get("CLAUDE_CODE_SESSION_ID"),
            "tmux_pane": os.environ.get("TMUX_PANE"),
        },
    }
    if ns.extra and Path(ns.extra).is_file():
        try:
            extra = json.loads(Path(ns.extra).read_text(encoding="utf-8"))
            if isinstance(extra, dict):
                for k, v in extra.items():
                    if k == "prompt" and isinstance(v, dict):
                        record["prompt"].update(v)
                    else:
                        record[k] = v
        except json.JSONDecodeError as exc:
            record["extra_error"] = str(exc)
    (run_dir / f"{ns.run_id}.launch.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    sink = Sink(run_dir, ns.run_id, ns.sink_py, ns.sink_arg)
    session = record.get("session") or {}
    trigger = record.get("trigger") or {}
    sink.emit(
        "run_start",
        {
            "backend": ns.backend,
            "mode": ns.mode,
            "model": ns.model or None,
            "cwd": ns.cwd,
            "prompt_sha256": record["prompt"]["sha256"],
            "prompt_est_tokens": record["prompt"]["est_tokens"],
            "trigger": trigger.get("source"),
            "reuse": session.get("reuse") or ("resume" if ns.resume else "fresh"),
            "reuse_reason": session.get("reason"),
        },
        flush=True,
    )
    return 0


# ---------------------------------------------------------------- parse


def summarize_input(inp: Any) -> str:
    if not isinstance(inp, dict):
        return cap(inp, 160)
    for key in ("file_path", "path", "target_file", "command", "pattern", "url", "query", "notebook_path"):
        if inp.get(key):
            return cap(inp[key], 160)
    return cap(json.dumps(inp, ensure_ascii=False), 160)


class Parser:
    def __init__(self, backend: str, sink: Sink):
        self.backend = backend
        self.sink = sink
        self.rec: dict[str, Any] = {
            "session_id": None,
            "model": None,
            "cli_version": None,
            "turns": None,
            "cost_usd": None,
            "tokens": {"input": None, "cache_read": None, "cache_write": None, "output": None},
            "last_context_tokens": None,
            "cache_ttl": None,
            "tool_calls": 0,
            "denials": 0,
            "errors": 0,
            "unparsed": 0,
            "final_text": "",
        }
        self.cli_init: dict[str, Any] | None = None
        self.text_buf = ""
        self.grok_tools: list[str] | None = None
        self.codex_usage = {"input": 0, "cached": 0, "output": 0, "seen": False}

    # -- helpers
    def _text(self, chunk: str) -> None:
        self.text_buf += chunk
        while "\n" in self.text_buf:
            line, self.text_buf = self.text_buf.split("\n", 1)
            self._line(line)

    def _line(self, line: str) -> None:
        s = line.strip()
        if s.startswith(MILESTONE_PREFIX):
            self.sink.emit("milestone", {"text": cap(s[len(MILESTONE_PREFIX):].strip())})

    def _flush_text(self) -> None:
        if self.text_buf:
            self._line(self.text_buf)
            self.text_buf = ""

    def _tool(self, name: str, target: str) -> None:
        self.rec["tool_calls"] += 1
        self.sink.emit("tool", {"name": cap(name, 80), "target": target})

    def _usage(self, inp: Any, cread: Any, cwrite: Any, out: Any) -> None:
        t = self.rec["tokens"]
        t["input"], t["cache_read"], t["cache_write"], t["output"] = inp, cread, cwrite, out

    def _init(self, data: dict[str, Any]) -> None:
        if self.cli_init is None:
            self.cli_init = data
            self.sink.emit("session_init", data, flush=True)
        if data.get("session_id"):
            self.rec["session_id"] = data["session_id"]
        if data.get("model"):
            self.rec["model"] = data["model"]
        if data.get("cli_version"):
            self.rec["cli_version"] = data["cli_version"]

    # -- dispatch
    def feed(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            self.rec["unparsed"] += 1
            return
        if not isinstance(ev, dict):
            self.rec["unparsed"] += 1
            return
        getattr(self, f"_feed_{self.backend}", self._feed_unknown)(ev)

    def _feed_unknown(self, _ev: dict[str, Any]) -> None:
        self.rec["unparsed"] += 1

    def _feed_claude(self, ev: dict[str, Any]) -> None:
        t = ev.get("type")
        if t == "system" and ev.get("subtype") == "init":
            self._init({
                "session_id": ev.get("session_id"),
                "model": ev.get("model"),
                "cli_version": ev.get("claude_code_version"),
                "tools": [x if isinstance(x, str) else x.get("name") for x in ev.get("tools") or []],
                "mcp_servers": [m.get("name") if isinstance(m, dict) else m for m in ev.get("mcp_servers") or []],
                "permission_mode": ev.get("permissionMode"),
                "cwd": ev.get("cwd"),
            })
        elif t == "assistant":
            for block in (ev.get("message") or {}).get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    self._tool(block.get("name") or "?", summarize_input(block.get("input")))
                elif block.get("type") == "text":
                    self._text((block.get("text") or "") + "\n")
        elif t == "result":
            u = ev.get("usage") or {}
            self._usage(u.get("input_tokens"), u.get("cache_read_input_tokens"),
                        u.get("cache_creation_input_tokens"), u.get("output_tokens"))
            iters = u.get("iterations") or []
            if iters:
                last = iters[-1]
                self.rec["last_context_tokens"] = sum(
                    int(last.get(k) or 0) for k in
                    ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"))
            cc = u.get("cache_creation") or {}
            if cc.get("ephemeral_1h_input_tokens"):
                self.rec["cache_ttl"] = "1h"
            elif cc.get("ephemeral_5m_input_tokens"):
                self.rec["cache_ttl"] = "5m"
            self.rec["turns"] = ev.get("num_turns")
            self.rec["cost_usd"] = ev.get("total_cost_usd")
            self.rec["denials"] = len(ev.get("permission_denials") or [])
            if ev.get("session_id"):
                self.rec["session_id"] = ev["session_id"]
            if isinstance(ev.get("result"), str):
                self.rec["final_text"] = ev["result"]
            if ev.get("is_error"):
                self.rec["errors"] += 1
                self.sink.emit("error", {"where": "cli_result", "message": cap(ev.get("result") or ev.get("subtype"))})

    def _feed_codex(self, ev: dict[str, Any]) -> None:
        t = ev.get("type")
        if t == "thread.started":
            self._init({"session_id": ev.get("thread_id")})
        elif t == "item.completed":
            item = ev.get("item") or {}
            it = item.get("type")
            if it == "command_execution":
                self._tool("shell", cap(item.get("command"), 160))
            elif it == "file_change":
                paths = [c.get("path") for c in item.get("changes") or [] if isinstance(c, dict)]
                self._tool("edit", cap(", ".join(p for p in paths if p), 160))
            elif it == "mcp_tool_call":
                self._tool(f"{item.get('server')}.{item.get('tool')}", "")
            elif it == "web_search":
                self._tool("web_search", cap(item.get("query"), 160))
            elif it == "agent_message":
                txt = item.get("text") or ""
                self.rec["final_text"] = txt
                self._text(txt + "\n")
            elif it == "error":
                self.sink.emit("warning", {"where": "cli", "message": cap(item.get("message"))})
        elif t == "turn.completed":
            u = ev.get("usage") or {}
            cu = self.codex_usage
            cu["seen"] = True
            cu["input"] += int(u.get("input_tokens") or 0)
            cu["cached"] += int(u.get("cached_input_tokens") or 0)
            cu["output"] += int(u.get("output_tokens") or 0)
            self.rec["last_context_tokens"] = int(u.get("input_tokens") or 0) + int(u.get("output_tokens") or 0)
            # codex input_tokens includes cached tokens
            self._usage(cu["input"] - cu["cached"], cu["cached"], None, cu["output"])
        elif t in ("turn.failed", "error"):
            self.rec["errors"] += 1
            msg = ev.get("message") or (ev.get("error") or {}).get("message")
            self.sink.emit("error", {"where": f"cli_{t}", "message": cap(msg)})

    def _feed_grok(self, ev: dict[str, Any]) -> None:
        t = ev.get("type")
        if t == "available_commands":
            if self.grok_tools is None:
                self.grok_tools = list(ev.get("tools") or [])
        elif t == "text":
            chunk = ev.get("data") or ""
            self.rec["final_text"] += chunk
            self._text(chunk)
        elif t == "tool_call":
            self._tool(ev.get("toolName") or ev.get("title") or "?", summarize_input(ev.get("rawInput")))
        elif t == "tool_call_update":
            if ev.get("status") in ("failed", "rejected", "denied", "cancelled"):
                self.rec["denials"] += 1
        elif t == "usage":
            u = ev.get("usage") or {}
            self.rec["last_context_tokens"] = sum(
                int(u.get(k) or 0) for k in
                ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"))
        elif t == "end":
            u = ev.get("usage") or {}
            self._usage(u.get("input_tokens"), u.get("cache_read_input_tokens"),
                        u.get("cache_creation_input_tokens"), u.get("output_tokens"))
            self.rec["turns"] = ev.get("num_turns")
            self.rec["cost_usd"] = ev.get("total_cost_usd")
            self._init({
                "session_id": ev.get("sessionId"),
                "cwd": ev.get("cwd"),
                "tools": self.grok_tools or [],
            })
            if ev.get("stopReason") not in (None, "end_turn"):
                self.sink.emit("warning", {"where": "cli_end", "message": cap(ev.get("stopReason"))})
        elif t == "error":
            self.rec["errors"] += 1
            self.sink.emit("error", {"where": "cli", "message": cap(ev.get("message") or ev.get("data"))})

    def finish(self) -> None:
        self._flush_text()
        if self.backend == "grok" and self.cli_init is None and self.grok_tools is not None:
            self._init({"session_id": None, "tools": self.grok_tools})


def tree_rss_kb(root_pid: int) -> int:
    children: dict[int, list[int]] = {}
    rss: dict[int, int] = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        try:
            with open(f"/proc/{pid}/stat", encoding="utf-8") as f:
                stat = f.read()
            ppid = int(stat.rsplit(")", 1)[1].split()[1])
            with open(f"/proc/{pid}/statm", encoding="utf-8") as f:
                pages = int(f.read().split()[1])
        except (OSError, ValueError, IndexError):
            continue
        children.setdefault(ppid, []).append(pid)
        rss[pid] = pages * (os.sysconf("SC_PAGE_SIZE") // 1024)
    total, stack, seen = 0, [root_pid], set()
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        total += rss.get(pid, 0)
        stack.extend(children.get(pid, []))
    return total


class RssSampler(threading.Thread):
    def __init__(self, pid_file: str | None):
        super().__init__(daemon=True)
        self.pid_file = pid_file
        self.peak_kb = 0
        self.stop = threading.Event()

    def run(self) -> None:
        if not self.pid_file:
            return
        pid = None
        for _ in range(50):
            try:
                pid = int(Path(self.pid_file).read_text().strip())
                break
            except (OSError, ValueError):
                time.sleep(0.1)
        if pid is None:
            return
        while not self.stop.is_set():
            if not Path(f"/proc/{pid}").exists():
                break
            self.peak_kb = max(self.peak_kb, tree_rss_kb(pid))
            self.stop.wait(2.0)


def cache_hit_rate(tokens: dict[str, Any]) -> float | None:
    parts = [tokens.get(k) for k in ("input", "cache_read", "cache_write")]
    known = [int(p) for p in parts if p is not None]
    if tokens.get("cache_read") is None or not known or sum(known) == 0:
        return None
    return round(int(tokens["cache_read"]) / sum(known), 4)


def cmd_parse(ns: argparse.Namespace) -> int:
    run_dir = Path(ns.run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    sink = Sink(run_dir, ns.run_id, ns.sink_py, ns.sink_arg)
    parser = Parser(ns.backend, sink)
    sampler = RssSampler(ns.pid_file)
    sampler.start()
    started = time.time()
    stream_path = run_dir / f"{ns.run_id}.stream.jsonl"
    with stream_path.open("a", encoding="utf-8") as raw:
        for line in sys.stdin:
            raw.write(line)
            raw.flush()
            try:
                parser.feed(line)
            except Exception as exc:  # noqa: BLE001 - never kill the pipe
                parser.rec["unparsed"] += 1
                print(f"[run_observe] parse error: {exc}", file=sys.stderr)
    parser.finish()
    rc = None
    if ns.rc_file:
        for _ in range(100):
            try:
                rc = int(Path(ns.rc_file).read_text().strip())
                break
            except (OSError, ValueError):
                time.sleep(0.1)
    sampler.stop.set()
    sampler.join(timeout=3)

    launch: dict[str, Any] = {}
    lp = run_dir / f"{ns.run_id}.launch.json"
    if lp.is_file():
        try:
            launch = json.loads(lp.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            launch = {}
    rec = parser.rec
    tokens = rec["tokens"]
    session = dict(launch.get("session") or {})
    session.setdefault("reuse", "resume" if (launch.get("invocation") or {}).get("resume") else "fresh")
    session["id"] = rec["session_id"]
    record = {
        "v": 1,
        "run": ns.run_id,
        "backend": ns.backend,
        "mode": (launch.get("invocation") or {}).get("mode"),
        "model": rec["model"] or (launch.get("invocation") or {}).get("model"),
        "cli_version": rec["cli_version"],
        "session": session,
        "cli_init": parser.cli_init,
        "started_at": launch.get("ts"),
        "ended_at": now_iso(),
        "wall_ms": int((time.time() - started) * 1000),
        "turns": rec["turns"],
        "tokens": tokens,
        "last_context_tokens": rec["last_context_tokens"],
        "cache_ttl": rec["cache_ttl"],
        "cache_hit_rate": cache_hit_rate(tokens),
        "cost_usd": rec["cost_usd"],
        "tool_calls": rec["tool_calls"],
        "denials": rec["denials"],
        "errors": rec["errors"],
        "unparsed": rec["unparsed"],
        "rss_peak_mb": round(sampler.peak_kb / 1024, 1) if sampler.peak_kb else None,
        "exit": rc,
        "final_text_tail": cap(rec["final_text"][-TEXT_CAP:]) if rec["final_text"] else None,
        "sink_failures": sink.failures,
    }
    for k in ("ticket", "parent", "phase", "role", "queue_wait_ms", "trigger"):
        if k in launch:
            record[k] = launch[k]
    (run_dir / f"{ns.run_id}.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    if rec["final_text"]:
        # full final answer for callers that parse a JSON verdict (read mode
        # cannot write result files); retention prunes it with the stream
        (run_dir / f"{ns.run_id}.final.txt").write_text(rec["final_text"], encoding="utf-8")
    summary = {k: record[k] for k in (
        "backend", "model", "turns", "tokens", "cache_hit_rate", "cost_usd",
        "wall_ms", "tool_calls", "denials", "errors", "rss_peak_mb", "exit")}
    summary["session_id"] = rec["session_id"]
    summary["reuse"] = session.get("reuse")
    sink.emit("run_end", summary, flush=True)
    sink.flush()
    return 0


def main(argv: list[str]) -> int:
    extra_argv: list[str] = []
    if "--" in argv:
        i = argv.index("--")
        argv, extra_argv = argv[:i], argv[i + 1:]
    ap = argparse.ArgumentParser(prog="run_observe")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("launch", "parse"):
        p = sub.add_parser(name)
        p.add_argument("--run-dir", required=True)
        p.add_argument("--run-id", required=True)
        p.add_argument("--backend", required=True)
        p.add_argument("--sink-py")
        p.add_argument("--sink-arg")
        if name == "launch":
            p.add_argument("--mode", required=True)
            p.add_argument("--cwd", required=True)
            p.add_argument("--prompt-file", required=True)
            p.add_argument("--model", default="")
            p.add_argument("--effort", default="")
            p.add_argument("--add-dir", default="")
            p.add_argument("--resume", default="")
            p.add_argument("--fork", action="store_true")
            p.add_argument("--extra")
        else:
            p.add_argument("--pid-file")
            p.add_argument("--rc-file")
    ns = ap.parse_args(argv)
    if ns.cmd == "launch":
        return cmd_launch(ns, extra_argv)
    return cmd_parse(ns)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
