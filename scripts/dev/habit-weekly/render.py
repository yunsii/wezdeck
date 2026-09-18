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
    sess = agents.get("session") or {}

    alt_sum = int(hk.get("alt_l_sum") or 0)
    presses = int(hk.get("total_hotkey_presses") or 0)
    alt_pct = round(100.0 * alt_sum / presses, 1) if presses else 0.0
    alt_avg = hk.get("alt_l_avg_per_active_day", 0)
    daily_hk = hk.get("daily") or []
    top_hk = hk.get("top_hotkeys") or []

    busy = [d for d in daily_hk if int(d.get("alt_l") or 0) >= 200]
    light = [d for d in daily_hk if int(d.get("alt_l") or 0) < 50]

    waka = report.get("wakatime") or {}
    waka_ok = bool(waka.get("ok"))
    waka_total = ((waka.get("totals") or {}).get("text") if waka_ok else "") or ""
    plugins_all = report.get("plugins") or {}
    rime = plugins_all.get("rime") or report.get("rime_commits") or {}
    git_churn = plugins_all.get("git_churn") or {}

    # One-line BLUF
    cli0 = cli[0][0] if cli else "（无 CLI 信号）"
    skill0 = _skill_label(skills[0][0]) if skills else "（无 skill 信号）"
    active_p50 = sess.get("active_minutes_p50")
    bluf_parts = [
        f"本周开发形态：多路 Agent 并行峰值 **{max_r}** 个 pane",
        f"热键以 **Alt+l** 巡检为主（{alt_sum}/{presses}，{alt_pct}%）",
        f"能力侧高频 **{cli0}** + skill **{skill0}**",
    ]
    if waka_ok and waka_total:
        bluf_parts.insert(1, f"WakaTime 合计 **{waka_total}**")
    if active_p50 is not None:
        bluf_parts.append(f"会话活跃时长中位 **{active_p50}** 分钟（非墙钟）")
    if sess.get("goal_completed"):
        bluf_parts.append(
            f"/goal 完成 **{sess.get('goal_completed')}** 次"
            f"（工期中位 {sess.get('goal_elapsed_minutes_p50')} 分钟）"
        )
    bluf = "；".join(bluf_parts) + "。"

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

    # Key metrics with in-doc jumps (anchors placed on detail sections below)
    lines.extend(
        _render_key_metrics(
            max_r=max_r,
            presses=presses,
            alt_sum=alt_sum,
            waka_ok=waka_ok,
            waka_total=waka_total,
            sess=sess,
            rime=rime,
            git_churn=git_churn,
            verify=verify,
            cli0=cli0,
            skill0=skill0,
        )
    )

    # WakaTime (macro time investment; optional)
    lines.append('<a id="sec-wakatime"></a>')
    lines.append("## WakaTime 时间投入")
    lines.append("")
    if not waka:
        lines.append("_未请求 WakaTime（`--no-wakatime`）。_")
        lines.append("")
    elif not waka_ok:
        err = waka.get("error") or "unknown"
        if err == "missing_api_key":
            lines.append(
                "_未配置 `WAKATIME_API_KEY`（建议 `~/.config/shell-env.d/wakatime.env`）。_"
            )
        else:
            lines.append(f"_WakaTime 拉取失败：`{err}`。_")
        lines.append("")
    else:
        lines.append(f"**合计：** {waka_total or '—'}")
        lines.append("")
        cats = waka.get("categories") or []
        if cats:
            lines.append(
                "**分类：** "
                + " · ".join(
                    f"{c.get('name')} {c.get('text')}"
                    f"（{c.get('percent', 0):.0f}%）"
                    for c in cats[:6]
                )
            )
            lines.append("")
        projects = waka.get("projects") or []
        if projects:
            lines.append("### Top 项目")
            lines.append("")
            lines.append("| 时长 | % | 项目 |")
            lines.append("| ---: | ---: | --- |")
            for row in projects[:8]:
                lines.append(
                    f"| {row.get('text', '')} | {row.get('percent', 0):.0f}% | "
                    f"`{row.get('name', '')}` |"
                )
            lines.append("")
        languages = waka.get("languages") or []
        if languages:
            lines.append("### Top 语言")
            lines.append("")
            lines.append(
                " · ".join(
                    f"{r.get('name')} {r.get('text')}（{r.get('percent', 0):.0f}%）"
                    for r in languages[:8]
                )
            )
            lines.append("")
        editors = waka.get("editors") or []
        if editors:
            lines.append(
                "**编辑器：** "
                + " · ".join(
                    f"{r.get('name')} {r.get('text')}" for r in editors[:6]
                )
            )
            lines.append("")
        daily_w = waka.get("daily") or []
        if daily_w:
            lines.append("| 日期 | 时长 |")
            lines.append("| --- | ---: |")
            for d in daily_w:
                lines.append(f"| {d.get('date', '')} | {d.get('text', '')} |")
            lines.append("")

    # Concurrency
    lines.append('<a id="sec-concurrency"></a>')
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

    # Session shape (active time / feed / media / goal)
    if sess.get("sessions_timed") or sess.get("user_turns") or sess.get("goal_completed"):
        lines.append('<a id="sec-session"></a>')
        lines.append("## 会话形态（活跃时长 / 投喂 / Goal）")
        lines.append("")
        lines.append(
            "持续时间用 **活跃时长**（消息间隔封顶 15 分钟）与 **工作片段**"
            "（空闲 >2 小时切开）；**不用**首末墙钟（resume / 多日续聊会虚高）。"
            "`/goal` 单独用 harness `elapsed_ms`。"
        )
        lines.append("")
        lines.append("| 指标 | 数值 |")
        lines.append("| --- | ---: |")
        lines.append(f"| user 轮次（已排除协议注入） | {sess.get('user_turns', 0)} |")
        lines.append(f"| user 字符合计 | {sess.get('user_chars', 0)} |")
        lines.append(
            f"| 其中约手写 / 代码围栏粘贴 | "
            f"{sess.get('typed_chars', 0)} / {sess.get('paste_chars', 0)} |"
        )
        excl_c = int(sess.get("excluded_feed_chars") or 0)
        excl_m = int(sess.get("excluded_feed_msgs") or 0)
        if excl_c or excl_m:
            lines.append(
                f"| 协议/Agent 注入合计（已从投喂剔除） | {excl_m} 条 / {excl_c} 字符 |"
            )
        lines.append(
            f"| 活跃时长合计 / P50 / P90（分钟） | "
            f"{sess.get('active_minutes_total')} / "
            f"{sess.get('active_minutes_p50')} / "
            f"{sess.get('active_minutes_p90')} |"
        )
        lines.append(
            f"| 墙钟 P50 / P90（诊断，勿当主指标） | "
            f"{sess.get('wall_minutes_p50_diag')} / "
            f"{sess.get('wall_minutes_p90_diag')} |"
        )
        lines.append(
            f"| 工作片段合计 · 多片段会话 | "
            f"{sess.get('segments_total')} · "
            f"{sess.get('multi_segment_sessions')} |"
        )
        lines.append(
            f"| 截图 · 含图会话 | "
            f"{sess.get('images', 0)} · {sess.get('sessions_with_image', 0)} |"
        )
        lines.append(
            f"| 链接 · 含链会话 | "
            f"{sess.get('urls', 0)} · {sess.get('sessions_with_url', 0)} |"
        )
        lines.append(f"| 超长粘贴条数（≥10k 字） | {sess.get('long_paste_msgs', 0)} |")
        lines.append("")
        buckets = sess.get("char_buckets") or {}
        if buckets:
            label = {
                "lt_200": "<200",
                "200_2k": "200–2k",
                "2k_10k": "2k–10k",
                "gt_10k": ">10k",
            }
            lines.append(
                "**投喂分桶：** "
                + " · ".join(
                    f"{label.get(k, k)}={v}"
                    for k, v in sorted(buckets.items(), key=lambda kv: kv[0])
                )
            )
            lines.append("")
        if sess.get("goal_completed"):
            glist = sess.get("goal_elapsed_minutes_list") or []
            lines.append(
                f"**Goal：** 完成 **{sess.get('goal_completed')}** 次；"
                f"工期合计 **{sess.get('goal_elapsed_minutes_total')}** 分钟；"
                f"中位 **{sess.get('goal_elapsed_minutes_p50')}** 分钟"
                + (f"；明细 {glist}" if glist else "")
            )
            lines.append("")
        rewrites = sess.get("rewrites") or {}
        if any(int(v or 0) for v in rewrites.values()):
            lines.append(
                "**同文件改写分布：** "
                + " · ".join(
                    f"{k}={v}"
                    for k, v in (
                        ("一次成稿", rewrites.get("once", 0)),
                        ("改 2 次", rewrites.get("twice", 0)),
                        ("改 3+ 次", rewrites.get("thrice_plus", 0)),
                    )
                )
            )
            lines.append("")
        route = sess.get("tool_route") or {}
        if route:
            lines.append(
                "**工具路由：** "
                + " · ".join(f"`{k}`={v}" for k, v in list(route.items())[:8])
            )
            lines.append("")

        kw = sess.get("keywords") or {}
        kw_top = kw.get("top") if isinstance(kw, dict) else None
        if kw_top:
            lines.append('<a id="sec-keywords"></a>')
            lines.append("### 常用关键词（去助词 · 同义合并）")
            lines.append("")
            lines.append(
                f"_引擎 `{kw.get('engine')}` · 词种 {kw.get('unique')} → "
                f"保留 {kw.get('kept_unique')}（min_count）_"
            )
            lines.append("")
            lines.append("| 次数 | 词 |")
            lines.append("| ---: | --- |")
            for item in kw_top[:30]:
                if not isinstance(item, dict):
                    continue
                lines.append(
                    f"| {item.get('count', 0)} | `{item.get('term')}` |"
                )
            lines.append("")
            lines.append(
                "_来源：清洗后的用户投喂（已排除协议注入）；"
                "同义词见 `~/.config/habit-weekly/keywords.json`。_"
            )
            lines.append("")

        # Protocol / agent injections on the user channel — per agent.
        inj = sess.get("injected") or {}
        if inj or any(
            (row.get("session") or {}).get("injected")
            for row in by_p.values()
            if isinstance(row, dict)
        ):
            lines.append("### User 通道上的协议/Agent 注入（按端）")
            lines.append("")
            lines.append(
                "这些内容出现在 user 角色里，但不是人的投喂；"
                "已从上方字数剔除。按 agent 对照可看谁在用户输入层灌了什么，"
                "方便复盘「输入侧」可优化点（少刷屏、少续写摘要、少 task 通知等）。"
            )
            lines.append("")
            lines.append("| Agent | 类型 | 条数 | 字符 |")
            lines.append("| --- | --- | ---: | ---: |")
            # Per-provider rows first (what the user asked for).
            for pname in ("claude", "grok", "codex"):
                row = by_p.get(pname) or {}
                pinj = (row.get("session") or {}).get("injected") or {}
                if not pinj:
                    continue
                for kind, meta in pinj.items():
                    if not isinstance(meta, dict):
                        continue
                    label = meta.get("label") or kind
                    lines.append(
                        f"| {pname} | {label} | "
                        f"{meta.get('msgs', 0)} | {meta.get('chars', 0)} |"
                    )
            # Also list any other providers present.
            for pname, row in by_p.items():
                if pname in ("claude", "grok", "codex"):
                    continue
                pinj = (row.get("session") or {}).get("injected") or {}
                for kind, meta in (pinj or {}).items():
                    if not isinstance(meta, dict):
                        continue
                    label = meta.get("label") or kind
                    lines.append(
                        f"| {pname} | {label} | "
                        f"{meta.get('msgs', 0)} | {meta.get('chars', 0)} |"
                    )
            lines.append("")
            if inj:
                lines.append(
                    "**合并 Top：** "
                    + " · ".join(
                        f"{(meta.get('label') or kind)} "
                        f"{meta.get('chars', 0)}字/{meta.get('msgs', 0)}条"
                        for kind, meta in list(inj.items())[:6]
                        if isinstance(meta, dict)
                    )
                )
                lines.append("")

    # Rime × foreground (optional plugin, auto-detect)
    if rime.get("commit_events") or rime.get("enabled") or rime.get("available"):
        lines.append('<a id="sec-rime"></a>')
        lines.append("## Rime 上屏 × 前台进程（可选插件）")
        lines.append("")
        lines.append(
            f"上屏事件 **{rime.get('commit_events', 0)}** · "
            f"字数 **{rime.get('commit_chars', 0)}**"
            "（只记字数，不落正文；与会话 `typed_chars` 对照）。"
        )
        lines.append("")
        by_fg = rime.get("by_foreground") or {}
        if by_fg:
            lines.append("| 前台进程桶 | 上屏字数 | 事件 |")
            lines.append("| --- | ---: | ---: |")
            for name, meta in by_fg.items():
                if not isinstance(meta, dict):
                    continue
                lines.append(
                    f"| `{name}` | {meta.get('chars', 0)} | {meta.get('events', 0)} |"
                )
            lines.append("")
        typed = int(sess.get("typed_chars") or 0)
        rime_chars = int(rime.get("commit_chars") or 0)
        if typed or rime_chars:
            lines.append(
                f"**对照会话投喂：** typed_chars={typed} · "
                f"rime_commit_chars={rime_chars}"
            )
            lines.append("")
        for note in rime.get("notes") or []:
            lines.append(f"- _{note}_")
        lines.append("")

    if git_churn.get("ok") and (
        git_churn.get("commits")
        or git_churn.get("insertions")
        or git_churn.get("repos_scanned")
    ):
        lines.append('<a id="sec-git-churn"></a>')
        lines.append("## 代码变更量（git churn）")
        lines.append("")
        lines.append(
            f"提交 **{git_churn.get('commits', 0)}** · "
            f"+{git_churn.get('insertions', 0)} / −{git_churn.get('deletions', 0)} 行 · "
            f"文件 **{git_churn.get('files', 0)}** · "
            f"有产出仓 **{git_churn.get('repos_with_activity', 0)}** / "
            f"扫描 **{git_churn.get('repos_scanned', 0)}**"
            + (
                f" · 路径排除命中 {git_churn.get('skipped_paths', 0)}"
                if git_churn.get("skipped_paths")
                else ""
            )
        )
        lines.append("")
        top = git_churn.get("top_repos") or []
        if top:
            lines.append("| 仓库 | 提交 | +行 | −行 | 文件 |")
            lines.append("| --- | ---: | ---: | ---: | ---: |")
            for row in top[:12]:
                lines.append(
                    f"| `{row.get('repo')}` | {row.get('commits', 0)} | "
                    f"{row.get('insertions', 0)} | {row.get('deletions', 0)} | "
                    f"{row.get('files', 0)} |"
                )
            lines.append("")
        cfg = git_churn.get("config_path")
        if cfg:
            lines.append(f"_排除规则见 `{cfg}`（`exclude_repos` / `exclude_repo_globs` / `exclude_path_globs`）。_")
            lines.append("")

    # Skills / CLI
    lines.append('<a id="sec-skills"></a>')
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
        lines.append('<a id="sec-cdp"></a>')
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
    lines.append('<a id="sec-hotkeys"></a>')
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
    lines.append(
        "- 会话时长：活跃时长（间隔封顶 15m）+ 片段（>2h 切开）；"
        "墙钟仅诊断；`/goal` 用 goal_updated.elapsed_ms"
    )
    lines.append("- Skill `路径推断` 可能与显式 Skill 工具略有重叠")
    lines.append("- Claude transcript 默认约 30 天清理；Codex `.jsonl.zst` 可能跳过")
    lines.append("- CDP→iterate 为同会话 ≤60m 启发式")
    lines.append(
        "- WakaTime 为编辑器心跳汇总，与 WezDeck Agent/热键口径不同；"
        "无 key 时本段降级，不阻断整报"
    )
    lines.append(
        "- Rime 上屏：OS foreground × tmux pane-focus 时间线 → "
        "`wezterm.agent.*` / `wezterm.shell`；只记字数/进程名/role，不落正文"
    )
    lines.append(
        "- git churn：工作机 auto；排除仓与生成目录见 "
        "`~/.config/habit-weekly/git-churn.json`；不落 commit message"
    )
    lines.append("")

    lines.append("## 复现")
    lines.append("")
    lines.append("```bash")
    lines.append(
        f"scripts/dev/habit-weekly/run.sh --since {start} --until {end} --write"
    )
    lines.append(
        f"scripts/dev/habit-weekly/run.sh --since {start} --until {end} "
        "--write --push   # 推送到配置的习惯归档仓"
    )
    lines.append(
        "scripts/dev/habit-report.sh --days N --wakatime   # 原始表；JSON 见同目录 .json"
    )
    lines.append("```")
    lines.append("")

    # Closing inventory: what this report actually extracted
    lines.extend(_render_data_inventory(report, agents, sess, waka, rime, git_churn, verify))

    lines.append("---")
    lines.append("*由 habit-weekly skill 根据 habit-report JSON 渲染。*")
    lines.append("")
    return "\n".join(lines)


def _status_row(name: str, status: str, detail: str) -> str:
    return f"| {name} | {status} | {detail} |"


def _render_key_metrics(
    *,
    max_r: Any,
    presses: int,
    alt_sum: int,
    waka_ok: bool,
    waka_total: str,
    sess: dict,
    rime: dict,
    git_churn: dict,
    verify: dict,
    cli0: str,
    skill0: str,
) -> list[str]:
    """Compact KPI table right under BLUF; links jump to detail sections."""
    lines: list[str] = []
    lines.append('<a id="sec-key-metrics"></a>')
    lines.append("## 关键指标")
    lines.append("")
    lines.append("| 指标 | 数值 | 详情 |")
    lines.append("| --- | --- | --- |")

    def row(name: str, value: str, anchor: str) -> None:
        lines.append(f"| {name} | {value} | [查看](#{anchor}) |")

    row("Agent 并行峰值", f"**{max_r}** pane", "sec-concurrency")
    row("热键 / Alt+l", f"**{presses}** / **{alt_sum}**", "sec-hotkeys")
    if waka_ok and waka_total:
        row("WakaTime", f"**{waka_total}**", "sec-wakatime")

    if sess.get("user_turns") or sess.get("sessions_timed"):
        typed = sess.get("typed_chars")
        active = sess.get("active_minutes_p50")
        parts = []
        if active is not None:
            parts.append(f"活跃P50 **{active}** 分")
        if typed is not None:
            parts.append(f"typed **{typed}**")
        if sess.get("goal_completed"):
            parts.append(f"goal **{sess.get('goal_completed')}**")
        row("会话形态", " · ".join(parts) if parts else "有", "sec-session")
        kw_top = ((sess.get("keywords") or {}).get("top") or [])[:3]
        if kw_top:
            preview = "、".join(
                f"{x.get('term')}×{x.get('count')}"
                for x in kw_top
                if isinstance(x, dict)
            )
            row("常用关键词", preview or "有", "sec-keywords")

    if git_churn.get("ok") and (
        git_churn.get("commits") or git_churn.get("insertions")
    ):
        row(
            "代码变更",
            f"**{git_churn.get('commits', 0)}** 提交 · "
            f"+{git_churn.get('insertions', 0)}/−{git_churn.get('deletions', 0)}",
            "sec-git-churn",
        )

    if rime.get("commit_events"):
        buckets = list((rime.get("by_foreground") or {}).keys())[:4]
        row(
            "Rime 上屏",
            f"**{rime.get('commit_chars', 0)}** 字 · "
            f"{rime.get('commit_events', 0)} 次"
            + (f" · {', '.join(buckets)}" if buckets else ""),
            "sec-rime",
        )
    elif rime.get("enabled") or rime.get("available") or rime.get("detected"):
        row("Rime 上屏", "已启用 · 本窗口无事件", "sec-rime")

    row("高频能力", f"`{cli0}` · `{skill0}`", "sec-skills")

    if verify.get("cdp_sessions") or verify.get("cdp_calls"):
        row(
            "CDP 验证",
            f"会话 **{verify.get('cdp_sessions', 0)}** · "
            f"iterate **{verify.get('iterate_after_cdp', 0)}**",
            "sec-cdp",
        )

    row("数据覆盖清单", "各信号有/无/未启用", "sec-inventory")
    lines.append("")
    lines.append("_点击「查看」跳到下文对应章节。_")
    lines.append("")
    return lines


def _render_data_inventory(
    report: dict,
    agents: dict,
    sess: dict,
    waka: dict,
    rime: dict,
    git_churn: dict,
    verify: dict,
) -> list[str]:
    """Terminal section: which signals this run actually used."""
    lines: list[str] = []
    lines.append('<a id="sec-inventory"></a>')
    lines.append("## 本次提取的数据")
    lines.append("")
    lines.append(
        "本表只列**这一次报告实际采到并写入**的信号；未启用 / 窗口内无事件会标明。"
    )
    lines.append("")
    lines.append("| 数据 | 状态 | 摘要 |")
    lines.append("| --- | --- | --- |")

    rows: list[tuple[str, str, str]] = []

    # Window
    win = report.get("window") or {}
    start = win.get("start") or report.get("start")
    end = win.get("end") or report.get("end")
    rows.append(
        (
            "时间窗口",
            "有" if start and end else "缺字段",
            f"`{start}` → `{end}`",
        )
    )

    # Concurrency
    conc = report.get("concurrency") or {}
    if conc.get("max_running") is not None or conc.get("transitions"):
        rows.append(
            (
                "Agent 并发（attention.log）",
                "有",
                f"max_running={conc.get('max_running')} · "
                f"transitions={conc.get('transitions')} · "
                f"unique_sessions={conc.get('unique_running_sessions')}",
            )
        )
    else:
        rows.append(
            (
                "Agent 并发（attention.log）",
                "无/失败",
                str(conc.get("error") or "—"),
            )
        )

    # Hotkeys
    hk = report.get("hotkeys") or {}
    presses = int(hk.get("total_hotkey_presses") or 0)
    alt_l = int(hk.get("alt_l_sum") or 0)
    if presses:
        rows.append(
            (
                "热键（wezterm.log）",
                "有",
                f"presses={presses} · Alt+l={alt_l} · "
                f"active_days={hk.get('active_days')}",
            )
        )
    else:
        rows.append(("热键（wezterm.log）", "窗口内无事件", "—"))

    # Providers
    by_p = agents.get("by_provider") or {}
    for pname in ("claude", "grok", "codex"):
        row = by_p.get(pname) or {}
        sess_n = row.get("sessions_scanned") or 0
        if sess_n or row.get("files_scanned"):
            rows.append(
                (
                    f"Agent 转录 · {pname}",
                    "有",
                    f"sessions={sess_n} · files={row.get('files_scanned', 0)} · "
                    f"skills={len(row.get('skills') or {})} · "
                    f"cli={sum((row.get('cli') or {}).values())}",
                )
            )
        else:
            rows.append((f"Agent 转录 · {pname}", "窗口内无/未扫到", "—"))

    # Session metrics
    if sess.get("user_turns") or sess.get("sessions_timed"):
        rows.append(
            (
                "会话形态（投喂/活跃时长/注入）",
                "有",
                f"turns={sess.get('user_turns')} · "
                f"user_chars={sess.get('user_chars')} · "
                f"typed={sess.get('typed_chars')} · "
                f"注入条数={sess.get('excluded_feed_msgs')} · "
                f"goal={sess.get('goal_completed')}",
            )
        )
    else:
        rows.append(("会话形态（投喂/活跃时长/注入）", "无", "—"))

    if sess.get("injected"):
        kinds = ", ".join(list((sess.get("injected") or {}).keys())[:6])
        rows.append(
            (
                "协议/Agent 注入分型",
                "有",
                f"kinds={len(sess.get('injected') or {})}（{kinds}…）"
                if len(sess.get("injected") or {}) > 6
                else f"kinds={len(sess.get('injected') or {})}（{kinds}）",
            )
        )

    kw = sess.get("keywords") or {}
    if isinstance(kw, dict) and kw.get("top"):
        top3 = ", ".join(
            f"{x.get('term')}×{x.get('count')}"
            for x in (kw.get("top") or [])[:5]
            if isinstance(x, dict)
        )
        rows.append(
            (
                "常用关键词（jieba+停用词+同义）",
                "有",
                f"engine={kw.get('engine')} · unique={kw.get('unique')} · top={top3}",
            )
        )
    else:
        rows.append(("常用关键词（jieba+停用词+同义）", "无/未产出", "—"))

    # CDP
    if verify.get("cdp_sessions") or verify.get("cdp_calls"):
        rows.append(
            (
                "CDP verify→iterate",
                "有",
                f"sessions={verify.get('cdp_sessions')} · "
                f"calls={verify.get('cdp_calls')} · "
                f"iterate={verify.get('iterate_after_cdp')}",
            )
        )
    else:
        rows.append(("CDP verify→iterate", "窗口内无事件", "—"))

    # WakaTime
    if waka.get("ok"):
        tot = (waka.get("totals") or {}).get("text") or waka.get("totals")
        rows.append(("WakaTime", "有", f"total={tot}"))
    elif waka.get("error"):
        rows.append(("WakaTime", "失败/未配置", str(waka.get("error"))[:80]))
    else:
        rows.append(("WakaTime", "未请求", "—"))

    # Rime plugin
    if rime.get("commit_events"):
        rows.append(
            (
                "Rime 上屏 × foreground/pane-focus",
                "有",
                f"events={rime.get('commit_events')} · "
                f"chars={rime.get('commit_chars')} · "
                f"buckets={list((rime.get('by_foreground') or {}).keys())} · "
                f"pane_edges={rime.get('pane_focus_edges', 0)}",
            )
        )
    elif rime.get("enabled") or rime.get("available") or rime.get("detected"):
        rows.append(
            (
                "Rime 上屏 × foreground/pane-focus",
                "已启用·窗口内无事件",
                "计数器/log 在，但本窗口无上屏记录",
            )
        )
    else:
        rows.append(
            ("Rime 上屏 × foreground/pane-focus", "未启用", "未检测到计数器/log")
        )

    # git churn
    if git_churn.get("ok") and (
        git_churn.get("commits") or git_churn.get("insertions")
    ):
        rows.append(
            (
                "git churn（多仓 numstat）",
                "有",
                f"commits={git_churn.get('commits')} · "
                f"+{git_churn.get('insertions')}/−{git_churn.get('deletions')} · "
                f"repos={git_churn.get('repos_with_activity')}/"
                f"{git_churn.get('repos_scanned')}",
            )
        )
    elif git_churn.get("ok") or git_churn.get("detected"):
        rows.append(
            (
                "git churn（多仓 numstat）",
                "已启用·窗口内无产出",
                f"scanned={git_churn.get('repos_scanned', 0)}",
            )
        )
    else:
        rows.append(("git churn（多仓 numstat）", "未启用", "非 work 机或无配置"))

    # Optional plugins inventory
    plugins = report.get("plugins") or {}
    if plugins:
        rows.append(
            (
                "可选插件集合",
                "有",
                ", ".join(sorted(plugins.keys())) or "—",
            )
        )

    for name, status, detail in rows:
        lines.append(_status_row(name, status, detail.replace("|", "/")))

    lines.append("")
    return lines


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
