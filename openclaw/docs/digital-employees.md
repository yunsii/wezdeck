# 数字员工三角（Dex / Bob / Scout）

个人控制面的 **三个 OpenClaw agent**。不是智能体群互聊。

| 短名 | agentId | 公开岗位（可开源表述） | Workspace（本机） |
| --- | --- | --- | --- |
| **Dex** | `main` | 开发编排 · C1/C2/C3 | `~/.openclaw/workspace` |
| **Bob** | `pm` | 项目管理数字员工（可适配） | `~/.openclaw/workspace-pm` |
| **Scout** | `radar` | 情报 / 雷达数字员工（可适配） | `~/.openclaw/workspace-radar` |

## 铁律：能力公开，细节私有

- **公开人设**（git 模板）：只写岗位能力、边界、风格。  
- **具体工作经验 / 客户与项目细节**：只进 **私有记忆** 或 **业务仓适配脚本**。  
- 详见 [`digital-employee-memory.md`](./digital-employee-memory.md)。

## 命名

| 层 | 写法 |
| --- | --- |
| 飞书/对人短名 | Dex · Bob · Scout |
| 配置 id | `main` · `pm` · `radar`（稳定） |


## 边界

```text
Dex  — 写码与确认；不收项目定时刷屏；不主动提 Scout
Bob  — 进度/优先级/跟催；不写业务代码；不主动提 Scout
Scout— 发现与摘要（主人自用）；不写代码、不排期
```

默认 **不做三角群聊**。协作由人转发或短结论。

## 飞书接入

操作手册：[`feishu-digital-employees.md`](./feishu-digital-employees.md)  
（只写接入与 open_id 技术点，不写业务细节。）

## 身份与模板路径

| 员工 | 公开模板（repo） | 本机 runtime |
| --- | --- | --- |
| Dex | `openclaw/workspace/` | `~/.openclaw/workspace` |
| Bob | `openclaw/workspace-pm/` | `~/.openclaw/workspace-pm` |
| Scout | `openclaw/workspace-radar/` | `~/.openclaw/workspace-radar` |

私有记忆：各 runtime 下 `memory/`（见 memory 文档）。

## 迁移清单

1. [x] `openclaw agents add pm|radar` + identity  
2. [x] 公开 AGENTS/IDENTITY 模板（无业务细节）  
3. [x] 飞书多账号 + bindings  
4. [x] 记忆分层说明 `digital-employee-memory.md`  
5. [ ] 业务仓宿主适配（cron/推送）与公开人设分离验收  
6. [ ] Scout 订阅源仅私有配置  

## CLI 速查

```bash
openclaw agents list
openclaw agents set-identity --agent main --name Dex --emoji "🛠️"
openclaw agents set-identity --agent pm --name Bob --emoji "📋"
openclaw agents set-identity --agent radar --name Scout --emoji "📡"
```
