# 数字员工三角（Dex / Bob / Scout）

个人控制面的 **三个 OpenClaw agent**，不是智能体群互聊。

| 短名 | agentId | 职责 | Workspace（本机） |
| --- | --- | --- | --- |
| **Dex** | `main` | 开发编排 · C1/C2/C3 | `~/.openclaw/workspace` |
| **Bob** | `pm` | 项目管理 · 进度推送 | `~/.openclaw/workspace-pm` |
| **Scout** | `radar` | 情报 · RSS/找资源/摘要 | `~/.openclaw/workspace-radar` |

## 命名

| 层 | 写法 |
| --- | --- |
| 飞书/对人短名 | Dex · Bob · Scout |
| 描述 | Yuns 的开发/项目/情报助手 |
| 配置 id | `main` · `pm` · `radar`（稳定，不随昵称改） |

历史品牌 **YunsClaw** 可仍作 Feishu 应用名；对内开发员工称 **Dex**。

## 边界

```text
Dex  — 写码与确认；不收项目/情报定时刷屏
Bob  — 项目与工作推送；不写业务代码
Scout— 发现与摘要；不写代码、不排期
```

协作：Scout 线索 → 人确认 → Bob 建项/催办 → Dex 落地。  
默认 **不做三角群聊**；需要时人转发或一条短结论。

## 路由现状与下一步

- Gateway 已注册三 agent（`openclaw agents list`）。
- 当前飞书 **仍可能默认进 main**（无 per-peer 绑定或第二应用时）。
- **落地推送隔离** 任选：
  1. **推荐先做：** cron `agentId=pm|radar` + `delivery` 指向 **独立会话/群**（不指 Dex 主会话）
  2. 或为 Bob/Scout 建 **独立 Feishu 应用/账号** 再 `agents bind`
  3. 或 peer 级 bindings（按官方 multi-agent 文档）

## 身份文件

各 workspace 的 `IDENTITY.md` + 精简 `AGENTS.md`：

- Dex: `~/.openclaw/workspace/IDENTITY.md`（开发宪法仍以现有 `AGENTS.md` L0 为准）
- Bob: `~/.openclaw/workspace-pm/`
- Scout: `~/.openclaw/workspace-radar/`

Repo 知识库副本：本文 + `terminology.md` 读序可链到本文。

## 迁移清单

1. [x] `openclaw agents add pm|radar`
2. [x] IDENTITY / AGENTS 草稿
3. [x] `set-identity` 写入 runtime
4. [ ] 业务仓定时推送 → `pm` + 非 main 投递
5. [ ] Scout RSS 日摘要 cron（可后做）
6. [ ] 飞书展示名/第二入口（可选）

## CLI 速查

```bash
openclaw agents list
openclaw agents set-identity --agent main --name Dex --emoji "🛠️"
openclaw agents set-identity --agent pm --name Bob --emoji "📋"
openclaw agents set-identity --agent radar --name Scout --emoji "📡"
```
