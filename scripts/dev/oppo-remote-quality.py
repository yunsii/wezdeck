#!/usr/bin/env python3
"""OPPO 互联 (O+ Connect) remote-control link quality, reconstructed from the
vendor's own logs. No sampler needed: desktop_agent logs keep ~a week.

Signal source (host side, per remote session = one desktop_agent.*.log):

  [EncoderQualityCalc] limit=0(isdrop=D, Q), bandwidth=B(recv=R,F), fps=..,
      diff=..(..,..), L, crf(cqp)=a-->b, drop=X, send=Y, line=N
  [CSingleDesktop] Too few frames sent, drop X, send Y, fps 40
  keyboard event 0x.. 0|1

Field meanings are inferred from behaviour, not vendor docs:
  F  bytes sent but not yet acknowledged by the pad (in-flight backlog)
  L  estimated queueing delay in ms (~40 healthy; 2000-11000 when stuck)
  R  bytes acknowledged in the last tick (collapses to ~KB when stuck)
  drop>0 only ever appears while congested; a static screen logs
  "Too few frames" with drop=0, so that line alone is not a symptom.

A second is "congested" when an EncoderQualityCalc row has L >= LAG_MS or
isdrop=1, or a "Too few frames" row has drop>0. Congested seconds within
MERGE_GAP of each other form one episode.

Topology comes from rc-daemon-sdk*.log: own public/local IP and the pad's
public/local from "receive P2P request".

Docs: docs/oppo-remote-host-input.md#link-quality-probe
"""
from __future__ import annotations

import argparse
import datetime as dt
import ipaddress
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

LAG_MS = 1000
MERGE_GAP = 5  # seconds

TS = r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})"
RE_EQC = re.compile(
    TS + r".*\[EncoderQualityCalc\] limit=\d+\(isdrop=(\d), ([\d.]+)\), "
    r"bandwidth=(\d+)\(recv=(-?\d+),(-?\d+)\), fps=(-?\d+), "
    r"diff=-?\d+\(-?\d+,-?\d+\), (-?\d+), .*drop=(\d+), send=(\d+)"
)
RE_FEW = re.compile(TS + r".*Too few frames sent, drop (\d+), send (\d+)")
RE_KEY = re.compile(TS + r".*keyboard event 0x[0-9a-f]+ 0\b")
RE_ANY_TS = re.compile(TS)
RE_SELF = re.compile(TS + r".*receive public ip ([\d.]+):\d+, local ip ([\d.]+):\d+")
RE_PEER = re.compile(TS + r".*receive P2P request \(public ([\d.]+):\d+ local ([\d.]+):\d+\)")

SPARK = " ▁▂▃▄▅▆▇█"


def parse_ts(s: str) -> dt.datetime:
    return dt.datetime.strptime(s, "%Y-%m-%d %H:%M:%S.%f")


@dataclass
class Tick:
    t: dt.datetime
    lag_ms: int = 0
    inflight: int = 0
    quality: float = 1.0
    congested: bool = False


@dataclass
class Session:
    path: Path
    start: dt.datetime | None = None
    end: dt.datetime | None = None
    ticks: list[Tick] = field(default_factory=list)
    keys: list[dt.datetime] = field(default_factory=list)
    topo: str = "?"
    peer: str = ""

    @property
    def dur_s(self) -> float:
        if not self.start or not self.end:
            return 0.0
        return (self.end - self.start).total_seconds()


def parse_line(line: str) -> Tick | None:
    m = RE_EQC.search(line)
    if m:
        isdrop, q, _bw, _recv, inflight, _fps, lag, _drop, _send = m.groups()[1:]
        lag_i = int(lag)
        return Tick(
            t=parse_ts(m.group(1)),
            lag_ms=lag_i,
            inflight=int(inflight),
            quality=float(q),
            congested=lag_i >= LAG_MS or isdrop == "1",
        )
    m = RE_FEW.search(line)
    if m:
        return Tick(t=parse_ts(m.group(1)), congested=int(m.group(2)) > 0)
    return None


def load_session(path: Path) -> Session:
    s = Session(path=path)
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = RE_ANY_TS.search(line)
            if not m:
                continue
            t = parse_ts(m.group(1))
            if s.start is None:
                s.start = t
            s.end = t
            tick = parse_line(line)
            if tick:
                s.ticks.append(tick)
                continue
            if RE_KEY.search(line):
                s.keys.append(t)
    return s


def episodes(s: Session) -> list[tuple[dt.datetime, dt.datetime, int, int]]:
    """(start, end, worst_lag_ms, worst_inflight) per congested run."""
    out: list[list] = []
    for tk in s.ticks:
        if not tk.congested:
            continue
        if out and (tk.t - out[-1][1]).total_seconds() <= MERGE_GAP:
            ep = out[-1]
            ep[1] = tk.t
            ep[2] = max(ep[2], tk.lag_ms)
            ep[3] = max(ep[3], tk.inflight)
        else:
            out.append([tk.t, tk.t, tk.lag_ms, tk.inflight])
    return [tuple(e) for e in out]


def ep_seconds(eps) -> float:
    return sum((b - a).total_seconds() + 1 for a, b, *_ in eps)


def keys_in(s: Session, eps) -> int:
    n = 0
    for k in s.keys:
        for a, b, *_ in eps:
            if a <= k <= b + dt.timedelta(seconds=1):
                n += 1
                break
    return n


# --- topology --------------------------------------------------------------

def load_topology(log_dir: Path):
    """Sorted list of (t, kind, public, local); kind in self|peer."""
    rows = []
    for p in sorted(log_dir.glob("rc-daemon-sdk*.log")):
        with p.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                m = RE_SELF.search(line)
                if m:
                    rows.append((parse_ts(m.group(1)), "self", m.group(2), m.group(3)))
                    continue
                m = RE_PEER.search(line)
                if m:
                    rows.append((parse_ts(m.group(1)), "peer", m.group(2), m.group(3)))
    rows.sort()
    return rows


def same_lan(a: str, b: str) -> bool:
    # Own prefix is not in the sdk log; /22 matches this host's office LAN
    # and is conservative for common /24 home LANs.
    try:
        return ipaddress.ip_network(f"{a}/22", strict=False) == ipaddress.ip_network(
            f"{b}/22", strict=False
        )
    except ValueError:
        return False


def attach_topology(sessions: list[Session], topo) -> None:
    for s in sessions:
        if not s.start or not s.end:
            continue
        lo = s.start - dt.timedelta(minutes=2)
        me = next((r for r in reversed(topo) if r[1] == "self" and r[0] <= s.end), None)
        peer = next(
            (r for r in topo if r[1] == "peer" and lo <= r[0] <= s.end), None
        )
        if not peer:
            s.topo = "?"
            continue
        s.peer = f"{peer[3]} via {peer[2]}"
        if me and me[2] == peer[2] and same_lan(me[3], peer[3]):
            s.topo = "same-LAN"
        elif me and me[2] == peer[2]:
            s.topo = "same-WAN"
        else:
            s.topo = "cross-net"


# --- commands --------------------------------------------------------------

def list_sessions(log_dir: Path, days: float) -> list[Session]:
    cutoff = time.time() - days * 86400
    paths = sorted(
        p for p in log_dir.glob("desktop_agent.*.log") if p.stat().st_mtime >= cutoff
    )
    sessions = [load_session(p) for p in paths]
    sessions = [s for s in sessions if s.start]
    attach_topology(sessions, load_topology(log_dir))
    return sessions


def fmt_dur(sec: float) -> str:
    sec = int(sec)
    if sec >= 3600:
        return f"{sec // 3600}h{sec % 3600 // 60:02d}m"
    return f"{sec // 60}m{sec % 60:02d}s"


def summarize(s: Session) -> dict:
    eps = episodes(s)
    stall = ep_seconds(eps)
    return {
        "session": s.path.name,
        "start": s.start.isoformat(timespec="seconds"),
        "duration_s": int(s.dur_s),
        "topology": s.topo,
        "peer": s.peer,
        "keys": len(s.keys),
        "keys_in_stall": keys_in(s, eps),
        "episodes": len(eps),
        "stall_s": int(stall),
        "stall_pct": round(100 * stall / s.dur_s, 1) if s.dur_s else 0.0,
        "worst_lag_ms": max((e[2] for e in eps), default=0),
        "worst_inflight_kb": max((e[3] for e in eps), default=0) // 1024,
    }


def verdict(row: dict) -> str:
    if row["stall_pct"] >= 20 or row["worst_lag_ms"] >= 5000:
        return "BAD"
    if row["episodes"]:
        return "rough"
    return "ok"


def cmd_report(args, log_dir: Path) -> int:
    rows = [summarize(s) for s in list_sessions(log_dir, args.days)]
    if args.json:
        for r in rows:
            r["verdict"] = verdict(r)
            print(json.dumps(r, ensure_ascii=False))
        return 0
    if not rows:
        print(f"no desktop_agent sessions in the last {args.days}d under {log_dir}")
        return 0
    hdr = f"{'start':16} {'dur':>7} {'topology':9} {'keys':>5} {'stall':>11} {'eps':>3} {'worst lag':>9} {'inflight':>8} {'keys@stall':>10}  verdict"
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        print(
            f"{r['start'][:16].replace('T', ' '):16} {fmt_dur(r['duration_s']):>7} {r['topology']:9} "
            f"{r['keys']:>5} {r['stall_s']:>5}s {r['stall_pct']:>4.1f}% {r['episodes']:>3} "
            f"{r['worst_lag_ms'] / 1000:>8.1f}s {r['worst_inflight_kb']:>6}KB {r['keys_in_stall']:>10}  {verdict(r)}"
        )
    peers = sorted({(r["topology"], r["peer"]) for r in rows if r["peer"]})
    if peers:
        print()
        for topo, peer in peers:
            print(f"peer {peer} → {topo}")
    print(
        "\nstall = seconds with queue delay ≥1s or encoder dropping frames (network backlog);"
        "\nworst lag ≈ how far behind the pad's picture was. See docs/oppo-remote-host-input.md#link-quality-probe"
    )
    return 0


def pick_session(log_dir: Path, name: str | None) -> Session | None:
    paths = sorted(log_dir.glob("desktop_agent.*.log"))
    if name:
        paths = [p for p in paths if name in p.name]
    if not paths:
        return None
    s = load_session(paths[-1])
    attach_topology([s], load_topology(log_dir))
    return s


def cmd_timeline(args, log_dir: Path) -> int:
    s = pick_session(log_dir, args.session)
    if not s or not s.start:
        print("no matching session", file=sys.stderr)
        return 1
    row = summarize(s)
    print(f"{s.path.name}  {row['topology']}  peer {s.peer or '?'}  dur {fmt_dur(s.dur_s)}  verdict {verdict(row)}")
    eps = episodes(s)
    bucket = dt.timedelta(seconds=args.bucket)
    t = s.start.replace(microsecond=0)
    print(f"\n{'time':8} {'max lag':>8} {'stall':>5} {'keys':>4}  lag (█ = ≥8s)")
    while t <= s.end:
        u = t + bucket
        lag = max((tk.lag_ms for tk in s.ticks if t <= tk.t < u), default=0)
        stall = sum(
            1 for tk in s.ticks if t <= tk.t < u and tk.congested
        )
        keys = sum(1 for k in s.keys if t <= k < u)
        bar = SPARK[min(8, lag // 1000)] * 1 if lag else " "
        mark = "#" * min(stall, 30)
        print(f"{t:%H:%M:%S} {lag / 1000:>7.1f}s {stall:>5} {keys:>4}  {bar} {mark}")
        t = u
    print(f"\nepisodes: {len(eps)}")
    for a, b, lag, infl in eps:
        print(f"  {a:%H:%M:%S}–{b:%H:%M:%S}  {(b - a).total_seconds() + 1:>4.0f}s  lag {lag / 1000:.1f}s  inflight {infl // 1024}KB")
    return 0


def cmd_watch(args, log_dir: Path) -> int:
    """Follow the newest desktop_agent log; print one line per state change."""
    cur: Path | None = None
    fh = None
    state = None
    last_bad: dt.datetime | None = None
    worst = 0
    print(f"watching {log_dir}/desktop_agent.*.log (Ctrl-C to stop)", flush=True)
    try:
        while True:
            paths = sorted(log_dir.glob("desktop_agent.*.log"))
            if paths and paths[-1] != cur:
                cur = paths[-1]
                if fh:
                    fh.close()
                fh = cur.open(encoding="utf-8", errors="replace")
                fh.seek(0, os.SEEK_END)
                print(f"{dt.datetime.now():%H:%M:%S} session {cur.name}", flush=True)
                state = None
            line = fh.readline() if fh else ""
            if not line:
                if state == "stall" and last_bad and (dt.datetime.now() - last_bad).total_seconds() > MERGE_GAP:
                    print(f"{dt.datetime.now():%H:%M:%S} OK     recovered (worst lag {worst / 1000:.1f}s)", flush=True)
                    state, worst = "ok", 0
                time.sleep(0.5)
                continue
            if args.keys and RE_KEY.search(line):
                m = RE_ANY_TS.search(line)
                print(f"{m.group(1)[11:19]} key    {'(during stall)' if state == 'stall' else ''}", flush=True)
            tk = parse_line(line)
            if not tk:
                continue
            if tk.congested:
                last_bad = dt.datetime.now()
                worst = max(worst, tk.lag_ms)
                if state != "stall":
                    detail = f"lag {tk.lag_ms / 1000:.1f}s inflight {tk.inflight // 1024}KB" if tk.lag_ms else "encoder dropping frames"
                    print(f"{tk.t:%H:%M:%S} STALL  {detail}", flush=True)
                    state = "stall"
                elif tk.lag_ms >= 2 * max(LAG_MS, 1) and tk.lag_ms >= worst:
                    print(f"{tk.t:%H:%M:%S} STALL  worse: lag {tk.lag_ms / 1000:.1f}s inflight {tk.inflight // 1024}KB", flush=True)
            elif tk.lag_ms and tk.lag_ms < LAG_MS and state == "stall":
                print(f"{tk.t:%H:%M:%S} OK     recovered (worst lag {worst / 1000:.1f}s)", flush=True)
                state, worst = "ok", 0
            elif state is None:
                state = "ok"
    except KeyboardInterrupt:
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--log-dir", required=True)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("report", help="one row per remote session")
    r.add_argument("--days", type=float, default=7)
    r.add_argument("--json", action="store_true")
    t = sub.add_parser("timeline", help="per-bucket lag for one session (default: newest)")
    t.add_argument("session", nargs="?", help="substring of desktop_agent log name, e.g. 20261121-0859")
    t.add_argument("--bucket", type=int, default=60, help="seconds per row (default 60)")
    w = sub.add_parser("watch", help="live STALL/OK transitions for the current session")
    w.add_argument("--keys", action="store_true", help="also print each key press")
    args = ap.parse_args()
    log_dir = Path(args.log_dir)
    if not log_dir.is_dir():
        print(f"log dir not found: {log_dir}", file=sys.stderr)
        return 1
    return {"report": cmd_report, "timeline": cmd_timeline, "watch": cmd_watch}[args.cmd](args, log_dir)


if __name__ == "__main__":
    sys.exit(main())
