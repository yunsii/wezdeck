#!/usr/bin/env python3
"""Host-side agent token output-rate report (Route B OTel + Route A transcript).

Reads:
  1. Route B (primary): rotated NDJSON written by `wezdeck-wsl otel`
     (~/.local/state/wezterm-runtime/logs/agent-token-rate.jsonl + .1..3)
  2. Route A (fallback): step-window timing from local transcripts — enabled by
     default for Agy (~/.gemini/antigravity-cli/brain/*/.system_generated/logs/
     transcript_full.jsonl) and optionally for Claude / Codex sessions that have
     no OTel samples in the window (`--transcript-all` or `--source transcript`).

Privacy: never prints prompts or message contents; only numeric timing/token
metrics and model/profile labels.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

DEFAULT_MIN_TOKENS = 20
DEFAULT_MIN_DURATION_MS = 200
MAX_STEP_DURATION_MS = 30 * 60 * 1000


def parse_iso_ms(ts: str | None) -> int | None:
    if not ts:
        return None
    s = str(ts).strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return None


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    xs = sorted(values)
    idx = int((len(xs) - 1) * p)
    return xs[max(0, min(idx, len(xs) - 1))]


def round1(v: float) -> float:
    return round(float(v), 1)


def iter_jsonl(path: Path):
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict):
                    yield obj
    except OSError:
        return


def load_otel_samples(
    log_path: Path, since_ms: int, until_ms: int | None
) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    candidates = [log_path]
    for i in range(1, 4):
        rot = Path(f"{log_path}.{i}")
        if rot.is_file():
            candidates.append(rot)
    for p in candidates:
        if not p.is_file():
            continue
        for row in iter_jsonl(p):
            ts_ms = int(row.get("ts_ms") or 0)
            if ts_ms <= 0:
                ts_ms = parse_iso_ms(row.get("ts")) or 0
            if ts_ms < since_ms:
                continue
            if until_ms is not None and ts_ms >= until_ms:
                continue
            out_tok = int(row.get("output_tokens") or 0)
            dur_ms = int(row.get("duration_ms") or 0)
            if out_tok <= 0 or dur_ms <= 0:
                continue
            tok_s = float(row.get("tok_per_s") or round1(out_tok / (dur_ms / 1000.0)))
            samples.append(
                {
                    "ts": str(row.get("ts") or ""),
                    "ts_ms": ts_ms,
                    "source": "otel",
                    "provider": str(row.get("provider") or "unknown"),
                    "profile": str(row.get("profile") or row.get("provider") or "unknown"),
                    "model": str(row.get("model") or "unknown"),
                    "session_id": str(row.get("session_id") or ""),
                    "output_tokens": out_tok,
                    "reasoning_tokens": int(row.get("reasoning_tokens") or 0),
                    "duration_ms": dur_ms,
                    "ttft_ms": int(row.get("ttft_ms") or 0),
                    "tok_per_s": tok_s,
                    "decode_tok_per_s": float(row.get("decode_tok_per_s") or 0.0),
                }
            )
    return samples


def scan_agy_transcripts(
    root: Path, since_ms: int, until_ms: int | None
) -> list[dict[str, Any]]:
    if not root.is_dir():
        return []
    since_sec = since_ms / 1000.0
    samples: list[dict[str, Any]] = []
    for path in root.glob("*/.system_generated/logs/transcript_full.jsonl"):
        try:
            if path.stat().st_mtime < since_sec:
                continue
        except OSError:
            continue
        sid = path.parents[2].name
        # pending = [start_ms, out_tok, model, remaining_tool_calls, last_tool_ms, last_tool_ts]
        pending: list[Any] | None = None

        def flush_pending() -> None:
            nonlocal pending
            if pending is None:
                return
            start_ms, out_tok, model, _rem, end_ms, end_ts = pending
            pending = None
            if end_ms is None or end_ms <= start_ms:
                return
            dur_ms = end_ms - start_ms
            if (
                0 < dur_ms <= MAX_STEP_DURATION_MS
                and out_tok > 0
                and end_ms >= since_ms
                and (until_ms is None or end_ms < until_ms)
            ):
                samples.append(
                    {
                        "ts": end_ts,
                        "ts_ms": end_ms,
                        "source": "transcript",
                        "provider": "agy",
                        "profile": "agy",
                        "model": model or "unknown",
                        "session_id": sid,
                        "output_tokens": out_tok,
                        "reasoning_tokens": 0,
                        "duration_ms": dur_ms,
                        "ttft_ms": 0,
                        "tok_per_s": round1(out_tok / (dur_ms / 1000.0)),
                        "decode_tok_per_s": 0.0,
                    }
                )

        for row in iter_jsonl(path):
            rtype = row.get("type")
            ts_str = str(row.get("created_at") or "")
            ts_ms = parse_iso_ms(ts_str)
            if pending is not None:
                if rtype == "GENERIC":
                    if ts_ms is not None and ts_ms > pending[0]:
                        pending[4] = ts_ms
                        pending[5] = ts_str
                    pending[3] -= 1
                    if pending[3] <= 0:
                        flush_pending()
                    continue
                flush_pending()
            if rtype == "PLANNER_RESPONSE" and ts_ms is not None:
                out_tok = int(row.get("output_tokens") or 0)
                tcs = row.get("tool_calls")
                tc_count = len(tcs) if isinstance(tcs, list) else 0
                if out_tok > 0 and tc_count > 0:
                    pending = [ts_ms, out_tok, str(row.get("model") or ""), tc_count, None, ""]
        flush_pending()
    return samples


def scan_claude_transcripts(
    root: Path, since_ms: int, until_ms: int | None, skip_sessions: set[str]
) -> list[dict[str, Any]]:
    if not root.is_dir():
        return []
    since_sec = since_ms / 1000.0
    samples: list[dict[str, Any]] = []
    for path in root.rglob("*.jsonl"):
        if "subagents" in path.parts or ".orphaned-" in path.name or ".superseded-" in path.name:
            continue
        sid = path.stem
        if sid in skip_sessions:
            continue
        try:
            if path.stat().st_mtime < since_sec:
                continue
        except OSError:
            continue
        step_start_ms: int | None = None
        last_msg_id = ""
        for row in iter_jsonl(path):
            rtype = row.get("type")
            ts_str = str(row.get("timestamp") or "")
            ts_ms = parse_iso_ms(ts_str)
            if rtype == "user" and ts_ms is not None:
                step_start_ms = ts_ms
                continue
            if rtype != "assistant" or ts_ms is None:
                continue
            msg = row.get("message")
            if not isinstance(msg, dict):
                continue
            mid = str(msg.get("id") or "")
            usage = msg.get("usage")
            if not isinstance(usage, dict) or (mid and mid == last_msg_id):
                continue
            last_msg_id = mid
            out_tok = int(usage.get("output_tokens") or 0)
            model = str(msg.get("model") or "")
            if (
                step_start_ms is not None
                and out_tok > 0
                and ts_ms > step_start_ms
                and not model.startswith("<")
            ):
                dur_ms = ts_ms - step_start_ms
                if (
                    dur_ms <= MAX_STEP_DURATION_MS
                    and ts_ms >= since_ms
                    and (until_ms is None or ts_ms < until_ms)
                ):
                    samples.append(
                        {
                            "ts": ts_str,
                            "ts_ms": ts_ms,
                            "source": "transcript",
                            "provider": "claude",
                            "profile": "claude",
                            "model": model or "unknown",
                            "session_id": sid,
                            "output_tokens": out_tok,
                            "reasoning_tokens": 0,
                            "duration_ms": dur_ms,
                            "ttft_ms": 0,
                            "tok_per_s": round1(out_tok / (dur_ms / 1000.0)),
                            "decode_tok_per_s": 0.0,
                        }
                    )
            step_start_ms = None
    return samples


def scan_codex_transcripts(
    root: Path, since_ms: int, until_ms: int | None, skip_sessions: set[str]
) -> list[dict[str, Any]]:
    if not root.is_dir():
        return []
    since_sec = since_ms / 1000.0
    samples: list[dict[str, Any]] = []
    for path in root.rglob("rollout-*.jsonl"):
        try:
            if path.stat().st_mtime < since_sec:
                continue
        except OSError:
            continue
        sid = path.stem
        step_start_ms: int | None = None
        model = ""
        for row in iter_jsonl(path):
            rtype = row.get("type")
            ts_str = str(row.get("timestamp") or "")
            ts_ms = parse_iso_ms(ts_str)
            pl = row.get("payload") if isinstance(row.get("payload"), dict) else {}
            if rtype == "session_meta":
                sid = str(pl.get("session_id") or pl.get("id") or sid)
                if sid in skip_sessions:
                    break
                continue
            if rtype == "turn_context" and pl.get("model"):
                model = str(pl.get("model"))
                continue
            ptype = pl.get("type")
            if rtype == "response_item" and (
                (ptype == "message" and pl.get("role") == "user")
                or ptype in {"function_call_output", "custom_tool_call_output"}
            ):
                if ts_ms is not None:
                    step_start_ms = ts_ms
                continue
            if rtype == "event_msg" and ptype == "token_count" and ts_ms is not None:
                info = pl.get("info") if isinstance(pl.get("info"), dict) else {}
                last_u = info.get("last_token_usage") if isinstance(info.get("last_token_usage"), dict) else {}
                out_tok = int(last_u.get("output_tokens") or 0)
                reason_tok = int(last_u.get("reasoning_output_tokens") or 0)
                if step_start_ms is not None and out_tok > 0 and ts_ms > step_start_ms:
                    dur_ms = ts_ms - step_start_ms
                    if (
                        dur_ms <= MAX_STEP_DURATION_MS
                        and ts_ms >= since_ms
                        and (until_ms is None or ts_ms < until_ms)
                    ):
                        samples.append(
                            {
                                "ts": ts_str,
                                "ts_ms": ts_ms,
                                "source": "transcript",
                                "provider": "codex",
                                "profile": "codex",
                                "model": model or "unknown",
                                "session_id": sid,
                                "output_tokens": out_tok,
                                "reasoning_tokens": reason_tok,
                                "duration_ms": dur_ms,
                                "ttft_ms": 0,
                                "tok_per_s": round1(out_tok / (dur_ms / 1000.0)),
                                "decode_tok_per_s": 0.0,
                            }
                        )
                step_start_ms = None
    return samples


def summarize_groups(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    buckets: dict[tuple[str, str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for s in samples:
        key = (s["provider"], s["profile"], s["model"], s["source"])
        buckets[key].append(s)
    rows: list[dict[str, Any]] = []
    for (provider, profile, model, source), items in buckets.items():
        rates = [float(x["tok_per_s"]) for x in items]
        dec_rates = [float(x["decode_tok_per_s"]) for x in items if float(x.get("decode_tok_per_s") or 0) > 0]
        durs_s = [float(x["duration_ms"]) / 1000.0 for x in items]
        ttfts = [float(x["ttft_ms"]) for x in items if int(x.get("ttft_ms") or 0) > 0]
        total_out = sum(int(x["output_tokens"]) for x in items)
        rows.append(
            {
                "provider": provider,
                "profile": profile,
                "model": model,
                "source": source,
                "n": len(items),
                "output_tokens": total_out,
                "p50_tok_s": round1(percentile(rates, 0.50)),
                "p95_tok_s": round1(percentile(rates, 0.95)),
                "mean_tok_s": round1(sum(rates) / len(rates)),
                "p50_decode_tok_s": round1(percentile(dec_rates, 0.50)) if dec_rates else None,
                "p50_dur_s": round1(percentile(durs_s, 0.50)),
                "p50_ttft_ms": int(round(percentile(ttfts, 0.50))) if ttfts else None,
            }
        )
    rows.sort(key=lambda r: (-r["n"], r["provider"], r["profile"], r["model"]))
    return rows


def print_summary_table(rows: list[dict[str, Any]], meta: dict[str, Any]) -> None:
    print(
        f"window={meta['window']}  otel_log={meta['log_path']}  "
        f"samples={meta['samples']} (filtered_noise={meta['filtered_noise']})"
    )
    if not rows:
        print("(no samples in window; run scripts/dev/install-otel-collector.sh or pass --transcript-all)")
        return
    print()
    hdr = (
        f"{'profile':<15} {'model':<26} {'src':<10} {'n':>4} {'out_tok':>9} "
        f"{'p50':>7} {'p95':>7} {'dec50':>7} {'dur50':>6} {'ttft50':>8}"
    )
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        dec = f"{r['p50_decode_tok_s']:>6.1f}" if r["p50_decode_tok_s"] is not None else "     -"
        ttft = f"{r['p50_ttft_ms']}ms" if r["p50_ttft_ms"] is not None else "-"
        print(
            f"{r['profile'][:15]:<15} {r['model'][:26]:<26} {r['source']:<10} "
            f"{r['n']:>4d} {r['output_tokens']:>9d} "
            f"{r['p50_tok_s']:>6.1f}  {r['p95_tok_s']:>6.1f}  {dec}  "
            f"{r['p50_dur_s']:>5.1f}s {ttft:>8}"
        )
    print("\nunit: p50/p95 = effective tok/s; dec50 = pure decode tok/s (excl. TTFT); dur50 = median step duration")


def cmd_live(status_path: Path, as_json: bool) -> int:
    if not status_path.is_file():
        if as_json:
            print(json.dumps({"running": False, "status_path": str(status_path)}))
        else:
            print(f"otel collector status not found: {status_path}")
            print("install with: scripts/dev/install-otel-collector.sh")
        return 1
    try:
        doc = json.loads(status_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"failed reading {status_path}: {exc}", file=sys.stderr)
        return 1
    now_ms = int(time.time() * 1000)
    age_s = max(0.0, (now_ms - int(doc.get("heartbeat_at_ms") or 0)) / 1000.0)
    fresh = age_s <= 90.0
    if as_json:
        doc["fresh"] = fresh
        doc["heartbeat_age_s"] = round1(age_s)
        print(json.dumps(doc, indent=2, ensure_ascii=False))
        return 0 if fresh else 1
    state = "running" if fresh else f"stale ({age_s:.0f}s ago)"
    print(
        f"collector={state}  listen=http://{doc.get('listen','?')}  pid={doc.get('pid','?')}  "
        f"received={doc.get('received_records',0)}  accepted={doc.get('accepted_samples',0)}"
    )
    sessions = doc.get("recent_sessions") or {}
    if not sessions:
        print("(no recent OTel sessions in last 2h)")
        return 0 if fresh else 1
    print()
    hdr = f"{'age':>6}  {'profile':<15} {'model':<26} {'last':>7} {'ewma':>7} {'out':>6} {'dur':>6} {'n':>3}  session"
    print(hdr)
    print("-" * len(hdr))
    items = sorted(sessions.items(), key=lambda kv: -int(kv[1].get("ts_ms") or 0))
    for sid, s in items:
        s_age = max(0, int((now_ms - int(s.get("ts_ms") or 0)) / 1000))
        age_txt = f"{s_age}s" if s_age < 120 else f"{s_age // 60}m"
        print(
            f"{age_txt:>6}  {str(s.get('profile','?'))[:15]:<15} "
            f"{str(s.get('model','?'))[:26]:<26} "
            f"{float(s.get('last_tok_per_s') or 0):>6.1f}  "
            f"{float(s.get('ewma_tok_per_s') or 0):>6.1f}  "
            f"{int(s.get('last_output_tokens') or 0):>6d} "
            f"{float(s.get('last_duration_ms') or 0)/1000.0:>5.1f}s "
            f"{int(s.get('samples') or 0):>3d}  {sid[:16]}"
        )
    return 0 if fresh else 1


def cmd_watch(log_path: Path, provider_filter: str, profile_filter: str) -> int:
    print(f"watching {log_path} (Ctrl+C to stop)...", flush=True)
    pos = log_path.stat().st_size if log_path.is_file() else 0
    try:
        while True:
            if not log_path.is_file():
                time.sleep(0.5)
                continue
            size = log_path.stat().st_size
            if size < pos:
                pos = 0
            if size > pos:
                with log_path.open("r", encoding="utf-8", errors="replace") as f:
                    f.seek(pos)
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            s = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if provider_filter and s.get("provider") != provider_filter:
                            continue
                        if profile_filter and s.get("profile") != profile_filter:
                            continue
                        ts = str(s.get("ts") or "")
                        hhmmss = ts[11:19] if len(ts) >= 19 else ts
                        dur_s = float(s.get("duration_ms") or 0) / 1000.0
                        ttft = f" ttft={s['ttft_ms']}ms" if s.get("ttft_ms") else ""
                        noisy = " [short]" if s.get("noisy") else ""
                        print(
                            f"{hhmmss}  {str(s.get('profile','?')):<14} "
                            f"{str(s.get('model','?')):<24} "
                            f"{int(s.get('output_tokens') or 0):>5d} tok / {dur_s:>5.1f}s = "
                            f"{float(s.get('tok_per_s') or 0):>6.1f} tok/s{ttft}{noisy}",
                            flush=True,
                        )
                    pos = f.tell()
            time.sleep(0.4)
    except KeyboardInterrupt:
        return 0


def main() -> int:
    home = Path.home()
    default_log = Path(
        os.environ.get(
            "WEZDECK_TOKEN_RATE_LOG",
            str(home / ".local" / "state" / "wezterm-runtime" / "logs" / "agent-token-rate.jsonl"),
        )
    )
    default_status = Path(
        os.environ.get(
            "WEZDECK_TOKEN_RATE_STATUS",
            str(home / ".local" / "state" / "wezterm-runtime" / "state" / "agent-token-rate" / "status.json"),
        )
    )

    ap = argparse.ArgumentParser(description="Host-side agent token output-rate report")
    ap.add_argument("--days", type=int, default=7, help="Lookback window in days (default: 7)")
    ap.add_argument("--today", action="store_true", help="Restrict to today (local date)")
    ap.add_argument("--raw", nargs="?", const="today", default=None, help="Print raw samples for today or YYYY-MM-DD")
    ap.add_argument("--live", action="store_true", help="Show collector status and recent session rates")
    ap.add_argument("--watch", action="store_true", help="Tail live OTel token-rate samples")
    ap.add_argument("--source", choices=["all", "otel", "transcript"], default="all")
    ap.add_argument("--transcript-all", action="store_true", help="Also scan Claude/Codex transcripts lacking OTel samples")
    ap.add_argument("--provider", default="", help="Filter by provider (claude|codex|grok|agy)")
    ap.add_argument("--profile", default="", help="Filter by profile (e.g. claude-kimi)")
    ap.add_argument("--model", default="", help="Filter by model substring")
    ap.add_argument("--min-tokens", type=int, default=DEFAULT_MIN_TOKENS)
    ap.add_argument("--min-duration-ms", type=int, default=DEFAULT_MIN_DURATION_MS)
    ap.add_argument("--all-samples", action="store_true", help="Include noisy short samples (<20 tok or <200ms)")
    ap.add_argument("--log", type=Path, default=default_log)
    ap.add_argument("--status", type=Path, default=default_status)
    ap.add_argument("--agy-root", type=Path, default=home / ".gemini" / "antigravity-cli" / "brain")
    ap.add_argument("--claude-root", type=Path, default=home / ".claude" / "projects")
    ap.add_argument(
        "--codex-root",
        type=Path,
        default=Path(os.environ.get("CODEX_HOME") or str(home / ".codex")) / "sessions",
    )
    ap.add_argument("--json", action="store_true", help="Emit JSON output")
    args = ap.parse_args()

    if args.live:
        return cmd_live(args.status, args.json)
    if args.watch:
        return cmd_watch(args.log, args.provider, args.profile)

    now = datetime.now().astimezone()
    until_ms: int | None = None
    if args.raw:
        if args.raw == "today":
            day_dt = now.replace(hour=0, minute=0, second=0, microsecond=0)
        elif args.raw == "yesterday":
            day_dt = (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        else:
            day_dt = datetime.strptime(args.raw, "%Y-%m-%d").replace(tzinfo=now.tzinfo)
        since_ms = int(day_dt.timestamp() * 1000)
        until_ms = int((day_dt + timedelta(days=1)).timestamp() * 1000)
        window_label = day_dt.strftime("%Y-%m-%d")
    elif args.today:
        day_dt = now.replace(hour=0, minute=0, second=0, microsecond=0)
        since_ms = int(day_dt.timestamp() * 1000)
        window_label = day_dt.strftime("%Y-%m-%d")
    else:
        since_ms = int((now - timedelta(days=max(1, args.days))).timestamp() * 1000)
        window_label = f"last-{max(1, args.days)}d"

    samples: list[dict[str, Any]] = []
    otel_sessions: set[str] = set()
    if args.source in {"all", "otel"}:
        otel_rows = load_otel_samples(args.log, since_ms, until_ms)
        samples.extend(otel_rows)
        otel_sessions = {r["session_id"] for r in otel_rows if r.get("session_id")}

    if args.source in {"all", "transcript"}:
        if not args.provider or args.provider == "agy":
            samples.extend(scan_agy_transcripts(args.agy_root, since_ms, until_ms))
        if args.transcript_all or args.source == "transcript":
            if not args.provider or args.provider == "claude":
                samples.extend(scan_claude_transcripts(args.claude_root, since_ms, until_ms, otel_sessions))
            if not args.provider or args.provider == "codex":
                samples.extend(scan_codex_transcripts(args.codex_root, since_ms, until_ms, otel_sessions))

    filtered: list[dict[str, Any]] = []
    filtered_noise = 0
    for s in samples:
        if args.provider and s["provider"] != args.provider:
            continue
        if args.profile and s["profile"] != args.profile:
            continue
        if args.model and args.model.lower() not in s["model"].lower():
            continue
        if not args.all_samples and (
            s["output_tokens"] < args.min_tokens or s["duration_ms"] < args.min_duration_ms
        ):
            filtered_noise += 1
            continue
        filtered.append(s)

    filtered.sort(key=lambda x: x["ts_ms"])

    if args.raw:
        if args.json:
            print(json.dumps({"window": window_label, "samples": filtered}, indent=2, ensure_ascii=False))
            return 0
        if not filtered:
            print(f"(no samples on {window_label})")
            return 0
        for s in filtered:
            ts = s["ts"][:19].replace("T", " ")
            dur_s = s["duration_ms"] / 1000.0
            ttft = f" ttft={s['ttft_ms']}ms" if s.get("ttft_ms") else ""
            print(
                f"{ts}  {s['source']:<10} {s['profile'][:14]:<14} {s['model'][:24]:<24} "
                f"{s['output_tokens']:>5d} tok / {dur_s:>5.1f}s = {s['tok_per_s']:>6.1f} tok/s{ttft}"
            )
        return 0

    rows = summarize_groups(filtered)
    meta = {
        "window": window_label,
        "log_path": str(args.log),
        "samples": len(filtered),
        "filtered_noise": filtered_noise,
    }
    if args.json:
        print(json.dumps({"meta": meta, "summary": rows}, indent=2, ensure_ascii=False))
    else:
        print_summary_table(rows, meta)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
