#!/usr/bin/env python3
"""Personal habit + agent-efficiency report (pluginized providers).

Core sections:
  1) Agent utilization — concurrent running from runtime.log
  2) Skills / MCP / CLI — Claude + Grok + Codex provider plugins
  3) CDP verify → iterate heuristic
  4) Hotkey intensity (secondary)

Examples are in scripts/dev/habit-report.sh.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# Allow `python3 scripts/dev/habit-report.py` without installing a package.
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from habit_report.concurrency import analyze_concurrency  # noqa: E402
from habit_report.hotkeys import (  # noqa: E402
    lifetime_intensity,
    list_wezterm_logs,
    scan_hotkey_window,
)
from habit_report.providers import available_providers, run_providers  # noqa: E402
from habit_report.plugins import (  # noqa: E402
    available_plugins,
    detect_enabled,
    run_plugins,
)
from habit_report.schema import merge_metrics  # noqa: E402
from habit_report.wakatime import fetch_summaries  # noqa: E402


def resolve_day(raw: str) -> date:
    if raw == "today":
        return date.today()
    if raw == "yesterday":
        return date.today() - timedelta(days=1)
    return date.fromisoformat(raw)


def fmt_counter(d: dict, *, limit: int = 12) -> list[str]:
    items = sorted(d.items(), key=lambda kv: -kv[1])[:limit]
    return [f"  {count:5d}  {name}" for name, count in items]


def format_table(report: dict) -> str:
    lines: list[str] = []
    w = report["window"]
    lines.append(
        f"habit-report  window={w['start']}→{w['end']}  "
        f"providers={','.join(report.get('providers') or [])}"
    )

    conc = report.get("concurrency") or {}
    lines.append("")
    lines.append(
        "## agent concurrency (pane-scoped + TTL; not raw session_id)"
    )
    lines.append(
        f"  max_running={conc.get('max_running', 0)}  "
        f"avg_running={conc.get('avg_running', 0)}  "
        f"max_active={conc.get('max_active', 0)}  "
        f"avg_active={conc.get('avg_active', 0)}  "
        f"unique_running_sids={conc.get('unique_running_sessions', 0)}  "
        f"ttl={conc.get('ttl_s', 1800)}s"
    )
    if conc.get("raw_sid_max_running") is not None:
        lines.append(
            f"  raw_sid_max_running={conc.get('raw_sid_max_running')}  "
            f"(diagnostic; zombie sids without done inflate this — "
            f"was the old '12')"
        )
    if conc.get("max_running_at"):
        lines.append(f"  max_running_at={conc['max_running_at']}")
        for slot in conc.get("max_running_slots") or []:
            lines.append(
                f"    {slot.get('slot')}  {slot.get('provider')}  "
                f"{slot.get('git_branch')}  age={slot.get('age_s')}s"
            )
    if conc.get("daily_max_running"):
        lines.append("  daily_max_running:")
        for day, n in conc["daily_max_running"].items():
            lines.append(f"    {day}  {n}")
    if conc.get("provider_edge_counts"):
        edges = " ".join(
            f"{k}={v}" for k, v in sorted(conc["provider_edge_counts"].items())
        )
        lines.append(f"  status_edges_by_provider: {edges}")

    agents = report.get("agents") or {}
    lines.append("")
    lines.append("## skills (merged)")
    lines.extend(fmt_counter(agents.get("skills") or {}) or ["  (none)"])
    lines.append("")
    lines.append("## mcp (merged)")
    lines.extend(fmt_counter(agents.get("mcp") or {}) or ["  (none)"])
    lines.append("")
    lines.append("## cli (merged: coco-cli / lark-cli / uxc / chrome-devtools / …)")
    lines.extend(fmt_counter(agents.get("cli") or {}) or ["  (none)"])

    verify = agents.get("verify") or {}
    lines.append("")
    lines.append("## cdp verify → iterate (heuristic)")
    lines.append(
        f"  cdp_sessions={verify.get('cdp_sessions', 0)}  "
        f"cdp_calls={verify.get('cdp_calls', 0)}  "
        f"iterate_sessions={verify.get('iterate_sessions', 0)}  "
        f"iterate_after_cdp={verify.get('iterate_after_cdp', 0)}"
    )

    sess = agents.get("session") or {}
    lines.append("")
    lines.append("## session (active time / feed / media — not wall clock)")
    lines.append(
        f"  user_turns={sess.get('user_turns', 0)}  "
        f"user_chars={sess.get('user_chars', 0)}  "
        f"images={sess.get('images', 0)}  urls={sess.get('urls', 0)}  "
        f"excluded_msgs={sess.get('excluded_feed_msgs', 0)}  "
        f"excluded_chars={sess.get('excluded_feed_chars', 0)}  "
        f"typed={sess.get('typed_chars', 0)}  paste={sess.get('paste_chars', 0)}"
    )
    inj = sess.get("injected") or {}
    if inj:
        lines.append(
            "  injected: "
            + " ".join(
                f"{k}={meta.get('chars', 0)}c/{meta.get('msgs', 0)}m"
                for k, meta in list(inj.items())[:8]
                if isinstance(meta, dict)
            )
        )
    lines.append(
        f"  active_min total={sess.get('active_minutes_total')}  "
        f"p50={sess.get('active_minutes_p50')}  "
        f"p90={sess.get('active_minutes_p90')}  "
        f"timed_sessions={sess.get('sessions_timed', 0)}"
    )
    lines.append(
        f"  wall_min p50_diag={sess.get('wall_minutes_p50_diag')}  "
        f"p90_diag={sess.get('wall_minutes_p90_diag')}  "
        f"(diagnostic; resume/goal inflate — do not use as BLUF)"
    )
    lines.append(
        f"  segments_total={sess.get('segments_total')}  "
        f"multi_segment_sessions={sess.get('multi_segment_sessions')}  "
        f"long_paste_msgs={sess.get('long_paste_msgs', 0)}"
    )
    buckets = sess.get("char_buckets") or {}
    if buckets:
        lines.append(
            "  char_buckets: "
            + " ".join(f"{k}={v}" for k, v in sorted(buckets.items()))
        )
    goal_n = sess.get("goal_completed") or 0
    if goal_n:
        lines.append(
            f"  goal_completed={goal_n}  "
            f"goal_elapsed_min total={sess.get('goal_elapsed_minutes_total')}  "
            f"p50={sess.get('goal_elapsed_minutes_p50')}  "
            f"list={sess.get('goal_elapsed_minutes_list')}"
        )
    rewrites = sess.get("rewrites") or {}
    if any(int(v) for v in rewrites.values()):
        lines.append(
            "  rewrites: "
            + " ".join(f"{k}={v}" for k, v in rewrites.items())
        )
    route = sess.get("tool_route") or {}
    if route:
        lines.append(
            "  tool_route: "
            + " ".join(f"{k}={v}" for k, v in list(route.items())[:8])
        )

    lines.append("")
    lines.append("## per provider")
    for name, row in (agents.get("by_provider") or {}).items():
        lines.append(
            f"  [{name}] sessions={row.get('sessions_scanned', 0)}  "
            f"files={row.get('files_scanned', 0)}  "
            f"skills={sum((row.get('skills') or {}).values())}  "
            f"cli={sum((row.get('cli') or {}).values())}  "
            f"mcp={sum((row.get('mcp') or {}).values())}"
        )
        top_skills = sorted(
            (row.get("skills") or {}).items(), key=lambda kv: -kv[1]
        )[:5]
        if top_skills:
            lines.append(
                "    skills: "
                + ", ".join(f"{n}={c}" for n, c in top_skills)
            )
        top_cli = sorted(
            (row.get("cli") or {}).items(), key=lambda kv: -kv[1]
        )[:5]
        if top_cli:
            lines.append(
                "    cli: " + ", ".join(f"{n}={c}" for n, c in top_cli)
            )
        for note in row.get("notes") or []:
            lines.append(f"    note: {note}")
        for err in row.get("errors") or []:
            lines.append(f"    err: {err}")

    hk = report.get("hotkeys") or {}
    lines.append("")
    lines.append("## hotkeys (secondary; wezterm.log pressed)")
    lines.append(
        f"  presses={hk.get('total_hotkey_presses', 0)}  "
        f"Alt+l sum={hk.get('alt_l_sum', 0)}  "
        f"Alt+l avg/active_day={hk.get('alt_l_avg_per_active_day', 0)}"
    )
    lines.append(
        "day         Alt+l  share  Alt+k  Ctrl+v  Alt+v  Alt+w  Alt+c  all"
    )
    for d in hk.get("daily") or []:
        p = d.get("peers") or {}
        lines.append(
            f"{d['day']}  {d.get('alt_l', 0):5d}  {d.get('alt_l_share_pct', 0):4.0f}%  "
            f"{p.get('attention.jump-done', 0):5d}  "
            f"{p.get('clipboard.paste-smart', 0):6d}  "
            f"{p.get('vscode.open-current-dir', 0):5d}  "
            f"{p.get('workspace.switch-work', 0):5d}  "
            f"{p.get('workspace.switch-config', 0):5d}  "
            f"{d.get('total_hotkeys', 0):4d}"
        )

    life = report.get("lifetime") or []
    if life:
        lines.append("")
        lines.append("## lifetime hotkey intensity (count/days_observed)")
        for row in life[:10]:
            lines.append(
                f"  {row['per_day']:7.1f}/d  n={row['count']:5d}  "
                f"days={row['days_observed']:5.1f}  {row['id']}"
            )

    plugins = report.get("plugins") or {}
    rime = plugins.get("rime") or report.get("rime_commits") or {}
    if rime and (rime.get("commit_events") or rime.get("enabled") or rime.get("available")):
        lines.append("")
        lines.append("## rime commits × host.foreground (optional plugin)")
        lines.append(
            f"  events={rime.get('commit_events', 0)}  "
            f"chars={rime.get('commit_chars', 0)}  "
            f"detected={rime.get('detected', rime.get('available'))}"
        )
        by_fg = rime.get("by_foreground") or {}
        if by_fg:
            lines.append("  by_foreground:")
            for name, meta in by_fg.items():
                if isinstance(meta, dict):
                    lines.append(
                        f"    {name}: chars={meta.get('chars', 0)}  "
                        f"events={meta.get('events', 0)}"
                    )
        for note in rime.get("notes") or []:
            lines.append(f"  note: {note}")

    churn = plugins.get("git_churn") or {}
    if churn and churn.get("ok"):
        lines.append("")
        lines.append("## git churn (optional plugin)")
        lines.append(
            f"  commits={churn.get('commits', 0)}  "
            f"+{churn.get('insertions', 0)}/-{churn.get('deletions', 0)}  "
            f"files={churn.get('files', 0)}  "
            f"repos={churn.get('repos_with_activity', 0)}/"
            f"{churn.get('repos_scanned', 0)}  "
            f"skipped_paths={churn.get('skipped_paths', 0)}"
        )
        for row in (churn.get("top_repos") or [])[:8]:
            lines.append(
                f"  {row.get('repo')}: "
                f"+{row.get('insertions', 0)}/-{row.get('deletions', 0)}  "
                f"c={row.get('commits', 0)}  f={row.get('files', 0)}"
            )
        if churn.get("config_path"):
            lines.append(f"  config={churn.get('config_path')}")

    for note in report.get("notes") or []:
        lines.append(f"note: {note}")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--end", default="today")
    ap.add_argument(
        "--providers",
        default="claude,grok,codex",
        help=f"comma list; available={','.join(available_providers())}",
    )
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--no-lifetime", action="store_true")
    ap.add_argument("--no-hotkeys", action="store_true")
    ap.add_argument(
        "--wakatime",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="include WakaTime summaries for the same window (default: off)",
    )
    ap.add_argument("--wezterm-log", default="")
    ap.add_argument("--runtime-log", default="")
    ap.add_argument("--usage-json", default="")
    ap.add_argument("--claude-root", default="")
    ap.add_argument("--grok-root", default="")
    ap.add_argument("--codex-root", default="")
    ap.add_argument("--paths-only", action="store_true")
    ap.add_argument(
        "--plugins",
        default="auto",
        help=(
            "optional collectors: auto (detect), off, all, or comma names "
            f"(available={','.join(available_plugins()) or 'none'})"
        ),
    )
    # Compat alias
    ap.add_argument(
        "--rime-commits",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="deprecated: use --plugins auto|off|rime",
    )
    args = ap.parse_args(argv)

    if args.days < 1:
        print("habit-report: --days must be >= 1", file=sys.stderr)
        return 2
    end_day = resolve_day(args.end)
    start_day = end_day - timedelta(days=args.days - 1)
    providers = [p.strip() for p in args.providers.split(",") if p.strip()]

    wezterm_log = Path(args.wezterm_log) if args.wezterm_log else Path()
    runtime_log = Path(args.runtime_log) if args.runtime_log else Path()
    usage_json = Path(args.usage_json) if args.usage_json else None
    roots = {
        "claude": Path(args.claude_root) if args.claude_root else None,
        "grok": Path(args.grok_root) if args.grok_root else None,
        "codex": Path(args.codex_root) if args.codex_root else None,
    }

    if args.paths_only:
        payload = {
            "window": {"start": start_day.isoformat(), "end": end_day.isoformat()},
            "providers": providers,
            "wezterm_log": str(wezterm_log) if args.wezterm_log else None,
            "wezterm_logs": [str(p) for p in list_wezterm_logs(wezterm_log)]
            if args.wezterm_log
            else [],
            "runtime_log": str(runtime_log) if args.runtime_log else None,
            "usage_json": str(usage_json) if usage_json else None,
            "roots": {k: str(v) if v else None for k, v in roots.items()},
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    provider_rows = run_providers(
        providers, start=start_day, end=end_day, roots=roots
    )
    agents = merge_metrics(provider_rows)

    concurrency: dict = {}
    if args.runtime_log and runtime_log.is_file():
        concurrency = analyze_concurrency(
            runtime_log, start=start_day, end=end_day
        )

    hotkeys: dict = {}
    if not args.no_hotkeys and args.wezterm_log:
        logs = list_wezterm_logs(wezterm_log)
        if logs:
            hotkeys = scan_hotkey_window(logs, start_day, end_day)

    lifetime: list = []
    if not args.no_lifetime and usage_json and usage_json.is_file():
        lifetime = lifetime_intensity(usage_json)

    report = {
        "schema_version": 2,
        "generated_at": datetime.now(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "window": {"start": start_day.isoformat(), "end": end_day.isoformat()},
        "providers": providers,
        "concurrency": concurrency,
        "agents": agents,
        "hotkeys": hotkeys,
        "lifetime": lifetime,
        "notes": [
            "Providers are pluggable under scripts/dev/habit_report/providers/.",
            "Skill/MCP/CLI is the primary habit signal; hotkeys are secondary.",
            "CDP verify→iterate is a same-session heuristic (≤60m after chrome-devtools).",
        ],
    }

    if args.wakatime:
        report["wakatime"] = fetch_summaries(start_day, end_day)
        if not report["wakatime"].get("ok"):
            report.setdefault("notes", []).append(
                f"WakaTime unavailable: {report['wakatime'].get('error')}"
            )

    plugin_mode = (args.plugins or "auto").strip().lower()
    if args.rime_commits is False:
        plugin_mode = "off"
    elif args.rime_commits is True and plugin_mode == "auto":
        plugin_mode = "auto"

    plugin_names: list[str] | None = None
    if plugin_mode in {"auto", "off", "all"}:
        mode = plugin_mode
    else:
        mode = "all"
        plugin_names = [p.strip() for p in plugin_mode.split(",") if p.strip()]

    plugins_out = run_plugins(
        start=start_day, end=end_day, names=plugin_names, mode=mode
    )
    report["plugins"] = plugins_out
    # Back-compat key for weekly render / older consumers
    if "rime" in plugins_out:
        report["rime_commits"] = plugins_out["rime"]
        if plugins_out["rime"].get("commit_events"):
            report.setdefault("notes", []).append(
                "Rime plugin: commit chars × host.foreground "
                "(OS process buckets; agent-pane split TBD)."
            )
    elif mode == "auto":
        detected = detect_enabled()
        if detected:
            report.setdefault("notes", []).append(
                f"optional plugins detected: {', '.join(detected)}"
            )

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        sys.stdout.write(format_table(report))
        waka = report.get("wakatime") or {}
        if waka:
            sys.stdout.write("\n## wakatime\n")
            if waka.get("ok"):
                totals = waka.get("totals") or {}
                sys.stdout.write(
                    f"  total={totals.get('text', '?')}  "
                    f"projects={len(waka.get('projects') or [])}  "
                    f"languages={len(waka.get('languages') or [])}\n"
                )
            else:
                sys.stdout.write(f"  error={waka.get('error')}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
