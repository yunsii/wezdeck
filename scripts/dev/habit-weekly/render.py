#!/usr/bin/env python3
"""Render habit-report JSON into a stable Chinese weekly habit markdown report."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def _top(d: dict[str, Any] | None, n: int = 10) -> list[tuple[str, int]]:
    if not d:
        return []
    return sorted(d.items(), key=lambda kv: -int(kv[1]))[:n]


def _skill_label(name: str) -> str:
    if name.startswith("path:"):
        return f"{name[5:]}（路径推断）"
    return name


def render(report: dict[str, Any]) -> str:
    w = report.get("window") or {}
    start = w.get("start", "?")
    end = w.get("end", "?")
    conc = report.get("concurrency") or {}
    agents = report.get("agents") or {}
    hk = report.get("hotkeys") or {}
    providers = report.get("providers") or []

    max_r = conc.get("max_running", 0)
    avg_r = conc.get("avg_running", 0)
    daily = conc.get("daily_max_running") or {}
    raw = conc.get("raw_sid_max_running")
    edges = conc.get("provider_edge_counts") or {}
    slots = conc.get("max_running_slots") or []
    at = conc.get("max_running_at") or ""

    skills = _top(agents.get("skills"), 10)
    cli = _top(agents.get("cli"), 6)
    mcp = _top(agents.get("mcp"), 6)
    verify = agents.get("verify") or {}
    by_p = agents.get("by_provider") or {}

    alt_sum = int(hk.get("alt_l_sum") or 0)
    presses = int(hk.get("total_hotkey_presses") or 0)
    alt_pct = round(100.0 * alt_sum / presses, 1) if presses else 0.0
    alt_avg = hk.get("alt_l_avg_per_active_day", 0)
    daily_hk = hk.get("daily") or []
    top_hk = hk.get("top_hotkeys") or []

    busy = [d for d in daily_hk if int(d.get("alt_l") or 0) >= 200]
    light = [d for d in daily_hk if int(d.get("alt_l") or 0) < 50]

    # One-line BLUF
    cli0 = cli[0][0] if cli else "（无 CLI 信号）"
    skill0 = _skill_label(skills[0][0]) if skills else "（无 skill 信号）"
    bluf = (
        f"本周开发形态：多路 Agent 并行峰值 **{max_r}** 个 pane；"
        f"热键以 **Alt+l** 巡检为主（{alt_sum}/{presses}，{alt_pct}%）；"
        f"能力侧高频 **{cli0}** + skill **{skill0}**。"
    )

    lines: list[str] = []
    lines.append(f"# 开发习惯周报")
    lines.append("")
    lines.append(f"**窗口：** {start} → {end}")
    lines.append(f"**Providers：** {', '.join(providers) if providers else '—'}")
    lines.append(f"**生成：** `{report.get('generated_at', '')}`")
    lines.append("")
    lines.append("## 一句话结论")
    lines.append("")
    lines.append(bluf)
    lines.append("")

    # Concurrency
    lines.append("## Agent 并发")
    lines.append("")
    lines.append("| 指标 | 数值 |")
    lines.append("| --- | ---: |")
    lines.append(f"| max_running（pane+TTL） | **{max_r}** |")
    lines.append(f"| avg_running（含夜间） | {avg_r} |")
    lines.append(f"| max_active | {conc.get('max_active', 0)} |")
    lines.append(
        f"| unique_running session_id | {conc.get('unique_running_sessions', 0)} |"
    )
    if raw is not None:
        lines.append(f"| raw_sid_max（诊断，勿当体感） | {raw} |")
    lines.append("")
    if daily:
        lines.append("**每日峰值：** " + " · ".join(f"{d}={n}" for d, n in daily.items()))
        lines.append("")
    if at and slots:
        lines.append(f"**峰值时刻：** `{at}`")
        lines.append("")
        for s in slots:
            lines.append(
                f"- `{s.get('slot')}` · {s.get('provider')} · "
                f"`{s.get('git_branch')}` · age={s.get('age_s')}s"
            )
        lines.append("")
    if edges:
        total_e = sum(int(v) for v in edges.values()) or 1
        lines.append("**状态边 by provider：**")
        for k, v in sorted(edges.items(), key=lambda kv: -int(kv[1])):
            lines.append(f"- {k}: {v}（{100 * int(v) / total_e:.0f}%）")
        lines.append("")

    # Skills / CLI
    lines.append("## Skill / CLI / MCP")
    lines.append("")
    if skills:
        lines.append("### 高频 Skill")
        lines.append("")
        lines.append("| 次数 | Skill |")
        lines.append("| ---: | --- |")
        for name, c in skills:
            lines.append(f"| {c} | {_skill_label(name)} |")
        lines.append("")
    if cli:
        lines.append("### 高频 CLI")
        lines.append("")
        lines.append("| 次数 | CLI |")
        lines.append("| ---: | --- |")
        for name, c in cli:
            lines.append(f"| {c} | `{name}` |")
        lines.append("")
    if mcp:
        lines.append("### MCP")
        lines.append("")
        for name, c in mcp:
            lines.append(f"- {name}: {c}")
        lines.append("")

    if by_p:
        lines.append("### 分 Provider")
        lines.append("")
        lines.append("| | sessions | skills | cli |")
        lines.append("| --- | ---: | ---: | ---: |")
        for name, row in by_p.items():
            sc = sum(int(v) for v in (row.get("skills") or {}).values())
            cc = sum(int(v) for v in (row.get("cli") or {}).values())
            lines.append(
                f"| {name} | {row.get('sessions_scanned', 0)} | {sc} | {cc} |"
            )
        lines.append("")
        # one-line role
        roles = []
        if int(sum((by_p.get("claude") or {}).get("cli", {}).values())) > 0:
            roles.append("Claude=交付/验证主力")
        if int(sum((by_p.get("grok") or {}).get("skills", {}).values())) > 0:
            roles.append("Grok=工具仓/方法论 skill")
        if (by_p.get("codex") or {}).get("sessions_scanned", 0) and sum(
            (by_p.get("codex") or {}).get("cli", {}).values()
        ) == 0:
            roles.append("Codex=旁路/弱信号")
        if roles:
            lines.append("**分工读法：** " + "；".join(roles))
            lines.append("")

    # CDP
    if verify.get("cdp_calls") or verify.get("cdp_sessions"):
        lines.append("## CDP 验证 → 迭代")
        lines.append("")
        lines.append(
            f"- CDP 会话 **{verify.get('cdp_sessions', 0)}** · "
            f"调用 **{verify.get('cdp_calls', 0)}** · "
            f"验证后继续改的会话 **{verify.get('iterate_sessions', 0)}** · "
            f"迭代回合（启发式）**{verify.get('iterate_after_cdp', 0)}**"
        )
        lines.append("")

    # Hotkeys
    lines.append("## 热键调度")
    lines.append("")
    lines.append(
        f"本周热键 **{presses}** 次；其中 **Alt+l = {alt_sum}（{alt_pct}%）**；"
        f"活跃日均 Alt+l ≈ **{alt_avg}**。"
    )
    lines.append("")
    if daily_hk:
        lines.append("| 日期 | Alt+l | 占当日 | 总热键 |")
        lines.append("| --- | ---: | ---: | ---: |")
        for d in daily_hk:
            lines.append(
                f"| {d.get('day')} | {d.get('alt_l', 0)} | "
                f"{d.get('alt_l_share_pct', 0):.0f}% | {d.get('total_hotkeys', 0)} |"
            )
        lines.append("")
    if busy:
        lines.append(
            "**忙日：** "
            + " · ".join(f"{d['day']} Alt+l={d['alt_l']}" for d in busy)
        )
        lines.append("")
    if light:
        lines.append(
            "**轻量日：** "
            + " · ".join(f"{d['day']} Alt+l={d['alt_l']}" for d in light)
        )
        lines.append("")
    if top_hk:
        lines.append("### Top 热键")
        lines.append("")
        lines.append("| 次数 | id |")
        lines.append("| ---: | --- |")
        for row in top_hk[:10]:
            lines.append(f"| {row.get('count', 0)} | `{row.get('id')}` |")
        lines.append("")

    # Loop
    lines.append("## 工作环路（归纳）")
    lines.append("")
    lines.append("1. 铺开数个 Agent pane（峰值约 max_running）")
    lines.append("2. `Alt+l` 高频巡检 running")
    lines.append("3. 会话内 CLI/skill 交付与验证（见上表）")
    if verify.get("cdp_sessions"):
        lines.append("4. CDP 验收后多数会再改一轮")
    lines.append("5. `Alt+k` / 切仓 / `Alt+g` / `Alt+v` 收尾与换上下文")
    lines.append("")

    lines.append("## 数据边界")
    lines.append("")
    lines.append("- 并发：pane + 30m TTL；`raw_sid_max` 仅诊断")
    lines.append("- `avg_running` 含夜间空闲，看 daily_max / 忙日 Alt+l 更有用")
    lines.append("- Skill `路径推断` 可能与显式 Skill 工具略有重叠")
    lines.append("- Claude transcript 默认约 30 天清理；Codex `.jsonl.zst` 可能跳过")
    lines.append("- CDP→iterate 为同会话 ≤60m 启发式")
    lines.append("")

    lines.append("## 复现")
    lines.append("")
    lines.append("```bash")
    lines.append(
        f"scripts/dev/habit-weekly/run.sh --since {start} --until {end}"
    )
    lines.append(
        f"scripts/dev/habit-report.sh --days N   # 原始表；JSON 见同目录 .json"
    )
    lines.append("```")
    lines.append("")
    lines.append("---")
    lines.append("*由 habit-weekly skill 根据 habit-report JSON 渲染。*")
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", "-i", required=True, help="habit-report JSON path or -")
    ap.add_argument("--output", "-o", default="", help="write markdown here")
    args = ap.parse_args(argv)

    if args.input == "-":
        data = json.load(sys.stdin)
    else:
        data = json.loads(Path(args.input).read_text(encoding="utf-8"))

    md = render(data)
    if args.output:
        out = Path(args.output)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(md, encoding="utf-8")
        print(str(out), file=sys.stderr)
    else:
        sys.stdout.write(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
