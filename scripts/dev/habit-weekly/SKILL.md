---
name: habit-weekly
description: >
  Produce a stable personal development-habit weekly report from WezDeck
  observability: pane-scoped agent concurrency, Claude/Grok/Codex skills+slash+CLI+MCP,
  CDP verify→iterate, hotkey intensity (Alt+l etc.), optional WakaTime summaries,
  and optional push to a private habit archive repo. Default window is the previous
  complete Mon–Sun (not the in-progress week). Use when the user says
  开发习惯周报 / 习惯周报 / habit weekly / 这周热键和 agent 习惯 / 出一份习惯数据报告.
  Prefer this over ad-hoc chat analysis once habit-report exists.
---

# Habit weekly（仓库内 skill — 开发习惯周报）

**Who runs:** the coding agent, **not** the human.  
**Never** ask the human to paste `habit-report.sh` as the primary path — load this skill and run the co-located runner.

**Scope:** WezDeck 仓库内 skill（`scripts/dev/habit-weekly/`）。由 `AGENTS.md` 路由加载；**不**经 `link-platform-skills.sh` 同步到 `~/.agents/skills` / `~/.claude/skills`（依赖本仓 `habit-report.sh`，用户级软链会把 `repo_root` 算错）。

数据收集器是 `scripts/dev/habit-report.sh`（插件化 Claude / Grok / Codex + 可选 WakaTime）。本 skill 负责：**定窗口 → 拉 JSON → 按固定模板渲染周报 →（可选）落盘 →（显式）推送到习惯归档仓**。

## When to load / run

| 用户意图 | 你做 |
| --- | --- |
| 开发习惯周报 / 习惯周报 / habit weekly | `run.sh`（**默认上一完整 Mon–Sun**；默认含 WakaTime） |
| 上周习惯 / last week | `run.sh` 或 `run.sh --week last`（与默认相同） |
| 本周迄今 / this week | `run.sh --week this`（Mon→today，未完结周） |
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
1. $HABIT_WEEKLY_HOME（显式覆盖）
2. $WEZTERM_REPO/scripts/dev/habit-weekly（本机主仓）
3. 本 SKILL.md 同目录（scripts/dev/habit-weekly，run.sh 共存）
4. $WEZDECK_ROOT/scripts/dev/habit-weekly
```

```bash
TOOL_HOME="${HABIT_WEEKLY_HOME:-$WEZTERM_REPO/scripts/dev/habit-weekly}"
R="$TOOL_HOME/run.sh"
```

`run.sh` 用 `pwd -P` 解析自身目录，并以 `$WEZTERM_REPO`（若含 `scripts/dev/habit-report.sh`）优先定仓库根。不要从 `~/.agents/skills/habit-weekly` 启动。

## Agent procedure

1. **定窗口**（用户没说则默认**上一完整 Mon–Sun**；未完结周须显式 `--week this`）：
   - 默认 / 上周完整周 → 不传或 `--week last`
   - 本周迄今（未完结）→ `--week this`
   - 点名日期 → `--since` / `--until`，或 `--week YYYY-MM-DD`（取该日所在周 Mon–Sun）
2. **跑收集 + 渲染**（优先 `--write` 落盘；用户要远端归档时再加 `--push`）：
   ```bash
   "$R" --write --push
   ```
   仅本机落盘：
   ```bash
   "$R" --write
   ```
   未完结本周（少用）：
   ```bash
   "$R" --week this --write
   ```
3. **读** `references/REPORT_STYLE.md`，核对渲染稿是否需补一句人话结论（数字已被模板写好；只在环路归纳与分工上可加 1–2 句，**禁止改数字**）。
4. **汇报**：把 markdown 正文（或落盘路径 + 摘要）用简体中文交给用户。披露数据窗口、`max_running` 口径（pane+TTL）、WakaTime 是否成功。

## 报告固定结构

见 `references/REPORT_STYLE.md`。核心段：

1. 一句话结论  
2. WakaTime 时间投入（无 key 则降级说明）  
3. Agent 并发（pane+TTL；raw_sid 仅诊断）  
4. Skill / CLI / MCP + 分 provider  
5. Token / 费用（分 agent · 分模型；Claude `cost-state` / Grok `usage.json` / Codex `last_token_usage`）  
6. CDP 验证→迭代（有则写）  
7. 热键调度（Alt+l 为主）  
8. 工作环路归纳  
9. 数据边界 + 复现命令  

## Options

| Flag | 作用 |
| --- | --- |
| `--week this\|last\|DATE` | 默认 `last`（完整 Mon–Sun）；`this`=Mon→today；DATE 取其所在周 Mon–Sun |
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
- Don't 把本 skill 链进 `~/.agents/skills` / `link-platform-skills.sh`（仓库内专用）

## Related

- Collector: `scripts/dev/habit-report.sh` + `scripts/dev/habit_report/providers/` + `habit_report/wakatime.py`  
- Push: `scripts/dev/habit-weekly/push-archive.sh`  
- Docs: `docs/diagnostics.md` → Habit report  
- Sibling timeline: `scripts/dev/workflow-timeline.sh`  
