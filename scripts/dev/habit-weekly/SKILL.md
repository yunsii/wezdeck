---
name: habit-weekly
description: >
  Produce a stable personal development-habit weekly report from WezDeck
  observability: pane-scoped agent concurrency, Claude/Grok/Codex skills+slash+CLI+MCP,
  CDP verify→iterate, hotkey intensity (Alt+l etc.), optional WakaTime summaries,
  and optional push to a private habit archive repo. Use when the user says
  开发习惯周报 / 习惯周报 / habit weekly / 这周热键和 agent 习惯 / 出一份习惯数据报告.
  Prefer this over ad-hoc chat analysis once habit-report exists.
---

# Habit weekly（平台 skill — 开发习惯周报）

**Who runs:** the coding agent, **not** the human.  
**Never** ask the human to paste `habit-report.sh` as the primary path — load this skill and run the co-located runner.

数据收集器是 `scripts/dev/habit-report.sh`（插件化 Claude / Grok / Codex + 可选 WakaTime）。本 skill 负责：**定窗口 → 拉 JSON → 按固定模板渲染周报 →（可选）落盘 →（显式）推送到习惯归档仓**。

## When to load / run

| 用户意图 | 你做 |
| --- | --- |
| 开发习惯周报 / 习惯周报 / habit weekly | `run.sh`（默认本周迄今；默认含 WakaTime） |
| 上周习惯 / last week | `run.sh --week last` |
| 自定义区间 | `run.sh --since YYYY-MM-DD --until YYYY-MM-DD` |
| 只要原始 JSON | `run.sh --json-only` |
| 落盘归档（本机） | `run.sh --write`（再 `--stdout` 可同时打印正文） |
| 落盘并推送到私有习惯仓 | `run.sh --write --push`（`--push` 隐含 `--write`） |

**Skip / redirect:**

- 团队业务周报（commit / TAPD / 飞书）→ **coco-weekly-report**（不是本 skill）
- 只要某一天的时间线事件流 → `workflow-timeline.sh`
- 只要热键表、不要 Agent 段 → `habit-report.sh --no-hotkeys` 的反义词是 `--providers` 裁剪；仍可用本 skill 再口头删段

## Resolve TOOL_HOME

```text
1. $HABIT_WEEKLY_HOME
2. directory of this SKILL.md if run.sh is co-located
3. $HOME/.agents/skills/habit-weekly
4. $WEZDECK_ROOT/scripts/dev/habit-weekly
5. $HOME/github/wezterm-config/scripts/dev/habit-weekly
```

```bash
TOOL_HOME=…   # dir that contains run.sh
R="$TOOL_HOME/run.sh"
```

Install / refresh discovery:

```bash
./scripts/dev/link-platform-skills.sh
```

## Agent procedure

1. **定窗口**（用户没说则默认本周迄今 Mon→today）：
   - 本周 → `--week this`
   - 上周完整 Mon–Sun → `--week last`
   - 点名日期 → `--since` / `--until`
2. **跑收集 + 渲染**（优先 `--write` 落盘；用户要远端归档时再加 `--push`）：
   ```bash
   "$R" --week this --write
   ```
   或：
   ```bash
   "$R" --week last --write --push
   ```
3. **读** `references/REPORT_STYLE.md`，核对渲染稿是否需补一句人话结论（数字已被模板写好；只在环路归纳与分工上可加 1–2 句，**禁止改数字**）。
4. **汇报**：把 markdown 正文（或落盘路径 + 摘要）用简体中文交给用户。披露数据窗口、`max_running` 口径（pane+TTL）、WakaTime 是否成功。

## 报告固定结构

见 `references/REPORT_STYLE.md`。核心段：

1. 一句话结论  
2. WakaTime 时间投入（无 key 则降级说明）  
3. Agent 并发（pane+TTL；raw_sid 仅诊断）  
4. Skill / CLI / MCP + 分 provider  
5. CDP 验证→迭代（有则写）  
6. 热键调度（Alt+l 为主）  
7. 工作环路归纳  
8. 数据边界 + 复现命令  

## Options

| Flag | 作用 |
| --- | --- |
| `--week this\|last\|DATE` | 周窗口；DATE 取其所在周 Mon–Sun |
| `--since` / `--until` | 显式闭区间（优先于 `--week`） |
| `--providers csv` | 默认 `claude,grok,codex` |
| `--wakatime` / `--no-wakatime` | 默认开；关则跳过 WakaTime |
| `--write` | 写入 `$WSL_WORKFLOW_DIR/habit-weekly/habit-weekly-<since>_to_<until>.{md,json}` |
| `--push` | 隐含 `--write`；复制到归档仓 `reports/YYYY/` 并 `git commit` + `push`（显式，不偷偷推） |
| `--stdout` | 与 `--write` 联用时额外打印正文 |
| `--json-only` | 只吐 habit-report JSON |
| `--out-dir DIR` | 覆盖落盘目录 |

## Archive config

私有习惯仓（非 coco 业务周报）：

- 默认远程：`yunsii/wezdeck-habit-weekly`
- 本机偏好：`~/.config/habit-weekly/state.json` → `.archive.{repo,local_path,branch,push_json}`
- 环境覆盖：`HABIT_WEEKLY_ARCHIVE_REPO` / `HABIT_WEEKLY_ARCHIVE_PATH` / `HABIT_WEEKLY_ARCHIVE_BRANCH` / `HABIT_WEEKLY_PUSH_JSON`
- WakaTime key：`~/.config/shell-env.d/wakatime.env` 或已由 `runtime_env_load_managed` 加载的 `WAKATIME_API_KEY`

## Don't

- Don't 把 `raw_sid_max_running` 写成体感并发  
- Don't 用含整夜的 `avg_running` 当白天主指标  
- Don't 手改 JSON 里的计数再渲染  
- Don't 与 coco-weekly-report 混用（一个是习惯可观测，一个是业务交付周报）  
- Don't 在未要求时省略 `--push` 却声称已推远端；也不要在仅 `--write` 时 push  
- Don't 维护第二份 SKILL.md 正文（只允许 symlink）

## Related

- Collector: `scripts/dev/habit-report.sh` + `scripts/dev/habit_report/providers/` + `habit_report/wakatime.py`  
- Push: `scripts/dev/habit-weekly/push-archive.sh`  
- Docs: `docs/diagnostics.md` → Habit report  
- Link: `scripts/dev/link-platform-skills.sh`  
- Sibling timeline: `scripts/dev/workflow-timeline.sh`  
