"""Render work focus and existing git churn sections of the habit report."""

from __future__ import annotations

from typing import Any


AREA_LABELS = {
    "web": "Web 界面",
    "relay": "WSL relay / 会话服务",
    "runtime": "Windows Runtime",
    "terminal": "终端配置",
    "automation": "脚本与技能",
    "docs": "文档",
    "other": "其他",
}


def render_git_sections(
    git_churn: dict[str, Any], work_focus: dict[str, Any]
) -> list[str]:
    lines: list[str] = []
    if work_focus.get("ok") and work_focus.get("commits"):
        total = int(work_focus["commits"])
        web_related = int(work_focus.get("web_related") or 0)
        lines.extend([
            '<a id="sec-work-focus"></a>',
            "## 工作重心（WezDeck）",
            "",
            f"本仓非合并提交 **{total}** 个，触及 Web 界面或宿主服务的 "
            f"**{web_related}** 个（{web_related / total:.0%}）。",
            "",
            "| 领域 | 触及提交 |",
            "| --- | ---: |",
        ])
        for area, count in sorted(
            (work_focus.get("areas") or {}).items(), key=lambda row: -row[1]
        ):
            lines.append(f"| {AREA_LABELS.get(area, area)} | {count} |")
        lines.extend([
            "",
            "领域可重叠；此处仅说明工作分布，不把提交数当效率分数。",
            "",
        ])

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
    return lines
