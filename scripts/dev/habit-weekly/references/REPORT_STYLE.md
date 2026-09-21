# 开发习惯周报 · 文风与结构

给 Agent 组装终稿时用。数据来自 `habit-report --json`；本文件只管**怎么写人话**。

## 结构（固定，空段可省略整段）

1. 标题 + 窗口日期  
2. **一句话结论**（BLUF，必须有；有 WakaTime 时可夹一句总时长；可夹活跃时长中位 / goal）  
3. **关键指标**（结论后紧接；表列 KPI；详情列链到下文 `sec-*` 锚点，如 `sec-concurrency`）  
4. **WakaTime 时间投入**（无 key / 拉取失败则降级说明，不删整段标题）  
5. **Agent 并发**（pane+TTL；可提一句 raw_sid 虚高勿用）  
6. **会话形态**（活跃时长/片段/投喂分桶/图链/Goal 工期/改写分布/常用关键词；**禁止**把墙钟当主指标；含 **按端协议注入表**）  
7. **Token / 费用（分 agent · 分模型）**（Claude `cost-state.modelUsage` / Grok `usage.json` / Codex `last_token_usage`+`turn_context.model`；主读分端与分模型 USD + output/reasoning；`total` 含 cache 不作跨端主 KPI）  
8. **Rime 上屏 × 前台/pane-focus**（可选插件；`wezterm.agent.*` / `.shell`）  
9. **代码变更量**（可选插件 `git_churn`；排除规则见 `git-churn.json`）  
10. **Skill / CLI / MCP**（Skill/CLI Top 表；MCP 用 Server/工具表，禁止裸 `mcp: N`）  
11. **CDP 验证→迭代**（有数据才写）  
12. **热键调度**（Alt+l 为主；忙日/轻量日对照）  
13. **工作环路**（短流程图或 5 步列表）  
14. **数据边界**（固定注意点，可压缩）  
15. **复现命令**  
16. **本次提取的数据**（结尾必有）  
## 文风

- 简体中文；标识符/命令保持原文  
- 电报体：数字优先，少形容词  
- 禁止「赋能 / 闭环 / 拉通 / 对齐」空话  
- 并发只报 **pane-scoped max_running**；需要时括号注明 raw_sid_max 是诊断  
- Skill 表最多 10 行；CLI 最多 6 行  
- WakaTime 项目 / 语言最多 8 行；分类优先 Coding / AI Coding  
- 「path:xxx」可写成 `xxx（路径推断）`，不要假装都是显式 Skill 工具  

## 不要

- 不要把 raw_sid_max 写成体感并发  
- 不要用含整夜空闲的 avg_running 当白天负载主指标  
- 不要把 system prompt 里的 skill 目录刷屏当调用次数（插件已规避）  
- 用户主动 `/goal`、`/code-review` 等应出现在 Skill 表（slash/forked 已计入；`/clear` 等会话 chrome 已过滤）  
- 不要把会话墙钟（首末时间差）写成「持续工作多久」；resume / 多日续聊 / cwd 级 prompt_history 都会虚高  
- `/goal` 工期只引用 `goal_elapsed_*`，不要和普通会话活跃时长混成一个均值  
- user 字符含粘贴；主读 **user_chars**，可拆 **typed_chars** / **paste_chars**；协议注入进 `injected` **按 claude/grok/codex 分列**，不要把注入字符加回投喂  

- 不要编造窗口外没有的数字  
- 不要把 WakaTime 心跳时长当成 Agent pane 并发  
- 不要把跨端 raw `total_tokens` 当成「本周消耗」主 KPI（cache 虚高 + 计价不同）  
- Token 数字只引用 `agents.usage` / `by_provider.*.usage`；不要手算 message.usage 覆盖官方汇总  
- 不要在报告 JSON / 归档仓里写入 API key  
