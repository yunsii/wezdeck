# Agent 统一架构（Phase 0–1）

个人控制面 **YunsClaw / OpenClaw** 的统一规划：原生能力保留、ACP 作接入、
人工轨 / Claw 轨分用、全员同一宪法与平台能力。

对用户主语言用 **人工 H\*** / **Claw C\***；括号内可附旧 A–E 代号。

## 一句话

```text
宪法 + 平台能力（L0 / skills / 脚本 / worktree / 台账 / 单写者）
        │
        ├─ 人工轨 ──► 原生 Agent（Grok CLI / Claude / Codex / IDE）
        └─ Claw 轨 ──► Main 编排（Main-Grok）
                         ├─ C1 Main 自写
                         ├─ C2 Handoff → 原生 CLI
                         └─ C3 ACP 接入 → Claude / Codex 后端
```

## 平面

| 平面 | 职责 | 禁止 |
| --- | --- | --- |
| **控制面 Main** | 飞书编排、台账、worktree、开发方式门闩、验收、错误闭环 | 假装自己是 Claude/Codex TUI；与工人双写 |
| **原生 Runtime** | `grok` / `claude` / `codex` 产品能力与 host 配置 | 被 ACP 排障静默改默认 |
| **ACP 接入** | 把 Claude/Codex **后端**挂进 Claw 轨 | 替换原生；写 `~/.codex` 顶层默认 |
| **质量面** | adversarial-review 等 | 与开发工人抢同一树写权限 |

## Grok 三分（勿混）

| 名称 | 是什么 | 用途 |
| --- | --- | --- |
| **Grok 原生** | 本机 `grok` CLI、`~/.grok/` | 人工轨直接用 |
| **Main-Grok** | `openclaw.json` → `grok-proxy` | 控制面编排 + C1 自写 |
| **Codex+Grok** | Codex 的 model/profile（host `-p grok` 或 ACP 隔离默认） | Codex **后端**的一种模型，不是 Grok 原生 |

## ACP = 接入层，不是第三套 Agent

```text
Claw 需要写码后端
  → ACP (acpx)
       → agentId=claude → Claude 运行时
       → agentId=codex  → Codex 运行时（隔离 CODEX_HOME）
```

- 无 `spawn grok`。
- ACP Codex **只**用 `~/.openclaw/acpx/codex-home/**`。
- 原生 `~/.codex` / `~/.claude` / `~/.grok` 是用户资产；排障默认不改 host 顶层 `model`/`auth`。

## 配置命名空间铁律

| 命名空间 | 路径 | 谁写 |
| --- | --- | --- |
| 原生 Grok | `~/.grok/**` | 用户 |
| 原生 Claude | `~/.claude/**` | 用户 |
| 原生 Codex | `~/.codex/**` | 用户（须显式确认才改） |
| ACP Codex | `~/.openclaw/acpx/codex-home/**` | OpenClaw / 排障 |
| Main | `~/.openclaw/openclaw.json` + workspace | OpenClaw |
| 审查 CLI | 调用时 `env -u CODEX_HOME` | 脚本；禁止指向 ACP home |

## 开发方式双轨

| 轨 | 方式 | 旧代号 | 谁写代码 | 后端/运行时 |
| --- | --- | --- | --- | --- |
| 人工 | **H1** 人直接开发 | A | 你 | IDE 等 |
| 人工 | **H2** 人 + 原生 Agent | A | 原生 CLI 为主 | Grok/Claude/Codex 原生 |
| Claw | **C1** Main 自写 | B | Main | Main-Grok |
| Claw | **C2** Handoff 原生 | C | 本机原生 CLI | 原生 *；Main **停笔** |
| Claw | **C3** ACP 后端 | E | ACP 工人 | ACP→claude 或 ACP→codex |
| — | ~~D CLI backend~~ | D | — | **禁用** |

### 用法可差，准则不可差

| 可有差异 | 必须统一 |
| --- | --- |
| 入口（终端 vs 飞书） | L0 宪法（闭环、单写者、可读、影响面…） |
| 模型是否 404 / degraded | 不装假绿；能力矩阵分栏 |
| host vs ACP 配置目录 | 命名空间不串改 |
| TUI 全文 vs 飞书摘要 | 验收 `pass\|fail\|not run\|re-run` |
| 工具集略有不同 | **skills / 脚本语义**同一套；安全红线同一套 |

## 能力矩阵（分栏，禁止混谈「通了」）

每条单独记：`pass | fail | not run | degraded`。

| 能力 | 含义 | 备注 |
| --- | --- | --- |
| `grok-native` | 本机 Grok CLI | 与 Main-Grok 不同 |
| `main-grok` | OpenClaw Main 模型 | 编排 + C1 |
| `claude-native` | 本机 Claude Code | H2 / C2 |
| `codex-native` | 本机 Codex + host 配置 | 默认模型属用户 |
| `acp-claude` | `/acp spawn claude` | C3 |
| `acp-codex` | `/acp spawn codex` | C3；隔离 CODEX_HOME |
| `review-claude` | 审查后端 claude | host CLI |
| `review-codex-gpt` | 审查 codex-gpt | host；代理无 GPT 时 degraded |
| `review-codex-grok` | 审查 codex-grok | host `-p grok` |

质量面默认推荐：`review-claude` × `review-codex-grok`。

## Claw 轨门闩（写任务）

1. 方案 + 初评  
2. **【开发方式】推荐卡**（含推荐/备选/限制）→ **用户确认**  
3. 再 create / 写码 / ACP spawn  
4. 自验 →（推荐）审查 →【结果】+ reclaim 询问  

详见 `workspace/AGENTS.md`、`workspace/skills/dev-task/SKILL.md`。

## 与旧文档关系

- 本文为 **L1 架构入口**；开发模式细节仍见 README「Development modes」。  
- 对用户优先 H/C 中文名；日志/兼容可保留 A–E。  
