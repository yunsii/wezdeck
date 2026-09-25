# Agent 交互说明（完整）

本机 OpenClaw 控制面下，**Agent 怎么和人对齐、怎么被脚本/飞书调用**。
与架构总览配合阅读：[`agent-architecture.md`](./agent-architecture.md)。

---

## 1. 一张图

```text
                    你（人）
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   交互 TUI      Headless CLI    飞书 DM
   (终端里聊)    (脚本一次跑完)   (Dex · Main)
        │             │             ├─ C1 Main-Grok 自写
        │             │             ├─ C2 Handoff → 你开 TUI
        │             │             ├─ C3 ACP → Claude/Codex 后端
        │             │             └─ 亦可调同一 skill：cross-repo-delegate
        │             ├─ 审查 / brainstorm（provider）
        │             └─ 跨仓工单（delegate run = Ticket-headless）
        └──────┬──────┘
               ▼
     host 原生 Agent 产品
     claude / codex / grok
     配置: ~/.claude  ~/.codex  ~/.grok
```

| 交互面 | 人是否在回路 | 典型用途 |
| --- | --- | --- |
| **TUI** | 是（多轮、可点权限） | 人工开发 H2、Handoff C2 |
| **Headless CLI** | 否（stdin/参数进，stdout/落盘出） | 对抗审查、**跨仓工单 worker**、自动化 |
| **Main（飞书）** | 是（聊飞书） | 编排、台账、小改 C1；**默认短回复**（AGENTS L0 飞书克制 + 精简结果卡） |
| **ACP** | 飞书编排，无本机 TUI | Claw 开发工人 C3（可 steer；≠ 工单票仓） |

---

## 2. 名词（不要混）

构成层（Model / Harness / Agent session / Backend / Control plane）以
[`terminology.md` §2](./terminology.md#2-model--harness--agent--backend核心分层)
为准。本节只列 **交互全名**。

| 全名 | 是什么 | 交互 |
| --- | --- | --- |
| **Grok-native** | 本机 `grok`（官方：coding agent） | 多为交互 CLI/TUI |
| **Main-Grok** | OpenClaw Main 模型 | 飞书会话 |
| **Claude-TUI** | 本机 `claude` **交互会话** | 终端多轮 |
| **Claude-host-headless** | 本机 `claude -p`… | 无界面批处理 |
| **Codex-TUI** | 本机 `codex` 交互 | 终端多轮 |
| **Codex-host-headless** | 本机 `codex exec`… | 无界面批处理 |
| **Codex-Grok-profile** | host `codex -p grok`（TUI 或 exec） | 模型走 Grok |
| **Claude-ACP / Codex-ACP** | OpenClaw ACP 接入的 **backend** | 飞书/C3 编排，非 host TUI |

历史文档里「审查用 Claude-TUI」= **host 上 Claude 产品**；实现是 **headless**（`claude -p`），不是让你盯着 TUI 点 Allow。

---

## 3. 三种「调用形态」对比

### 3.1 交互 TUI

```bash
cd /path/to/claw-or-project
claude          # 进入交互
codex           # 进入交互
codex -p grok   # 交互 + Grok profile
```

- 配置：host `~/.claude` / `~/.codex` / agent-profiles  
- 权限：逐步 Allow/Deny（产品 UI）  
- 适合：你要深度改代码、看全程轨迹  

### 3.2 Headless CLI（无交互批处理）

```bash
# 模式：一次 prompt → 模型跑 → 打印结果 → 退出
claude -p "用一句话解释本目录 README 做什么"
codex exec "List the top-level files and stop"
```

- **没有**聊天界面；适合脚本 / `run.sh` / CI 感编排  
- 权限靠**启动参数**预置（只读工具、sandbox），不是弹窗  
- 对抗审查默认走这条（多角色 = 多次 headless 调用）  

### 3.3 ACP（接入层，不是第三套产品）

```text
飞书 → Main → sessions_spawn(runtime=acp, agentId=claude|codex)
            → acpx → 后端进程
```

- Codex-ACP 用 **隔离** `~/.openclaw/acpx/codex-home`（可默认 Grok 保通）  
- **不改** host `~/.codex` 默认  
- **不得写入 WezDeck 交互式注意力徽章**（`Alt+/` · ●/▲）：C3 是委托工人。`emit.sh` 认 `AGENT_ATTENTION_SKIP` / `OPENCLAW_ACP` / `OPENCLAW_ACPX_LEASE_ID`；生成式 wrapper 用 `openclaw/scripts/patch-acpx-attention-skip.sh`（`@openclaw/acpx` 重生成后重跑）  
- 适合：人离开终端、飞书驱动多文件开发（C3）  
- **默认不用于**对抗审查（质量面与开发面分离）  

---

## 4. 和开发方式（轨）的对应

| 轨 / 通道 | 主交互 | Agent / 入口 |
| --- | --- | --- |
| H1 人直接 | IDE | 无或旁路 |
| H2 原生 Agent | **TUI** | Claude-TUI / Codex-TUI / Grok-native |
| C1 Main 自写 | 飞书 | Main-Grok |
| C2 Handoff | 飞书 brief → 你开 **TUI** | 同上 host 原生 |
| C3 ACP | 飞书 | Claude-ACP / Codex-ACP |
| **Ticket-headless** | 飞书/TUI 编排 → `delegate run` | Claude/Codex/Grok **host headless**（票在 `~/.agent/tickets/`） |
| 对抗审查 | **Headless CLI** 多角色 | Claude-host + Codex-Grok-profile（等） |

**执行通道（与「后端全名」正交）：** 推荐卡除写 Claude-ACP / Codex-TUI 等全名外，还要写清通道是 **ACP**、**Ticket-headless**、还是 **Handoff/TUI**。同一后端产品可以走不同通道（例如 Claude-ACP ≠ Claude-host-headless 工单工人）。

---

## 5. Headless CLI 学习示例

以下命令可在本机直接试（需已登录/配置好对应 CLI）。  
**安全提示：** 示例偏只读；写文件示例请在临时目录做。

### 5.1 Claude headless（`claude -p` / `--print`）

```bash
# 最简：非交互问一句
claude -p "Reply with exactly: hello-headless"

# JSON 输出（便于脚本解析）
claude -p --output-format json "Reply with exactly: ok" | head -c 500

# 管道喂长输入（审查常用：stdin = diff + prompt）
printf '%s\n' "Summarize this diff in one sentence:" "$(git diff HEAD~1)" \
  | claude -p --output-format json

# 偏只读（对抗审查 find 类似；工具白名单因版本而异）
claude -p --output-format json \
  --permission-mode plan \
  --allowed-tools Read Grep Glob \
  "List TypeScript files under src/ if any; if none say none."
```

对抗审查里（`provider.sh`）等价思路：

```bash
# 伪代码：prompt 文件 + 业务输入拼在一起，再 -p
cat prompts/critic.md
printf '\n=== INPUT ===\n'
git diff HEAD~1
# | claude -p --output-format json --permission-mode plan --allowed-tools Read Grep Glob
```

### 5.2 Codex headless（`codex exec`）

```bash
# 最简：非交互
codex exec "Reply with exactly: hello-codex-headless"

# 从 stdin 读 prompt（`-`）
printf '%s\n' "Reply with exactly: from-stdin" | codex exec -

# JSON 事件流（脚本解析用）
codex exec --json "Reply with exactly: ok" | head -c 800

# 只读沙箱（审查 refute/find 常用）
codex exec --json --sandbox read-only \
  "Do not modify files. Name one file in the current directory."

# Grok profile + 模型（本机代理；审查 grok）
# 使用 host 配置：不要 export CODEX_HOME 到 ACP 目录
env -u CODEX_HOME codex exec --json --sandbox read-only \
  -p grok -m grok-4.5 \
  "Reply with exactly: grok-headless"

# 管道 + profile（与 provider.sh 同构）
printf '%s\n' "Summarize stdin in 5 words:" "lorem ipsum dolor" \
  | env -u CODEX_HOME codex exec --json --sandbox read-only -p grok -m grok-4.5 -
```

### 5.3 临时目录小实验（可写）

```bash
SMOKE=$(mktemp -d)
cd "$SMOKE"
git init -q
echo 'print("hi")' > app.py
git add app.py && git -c user.email=t@t -c user.name=t commit -q -m init

# Codex headless 写一个标记文件（workspace-write）
codex exec --sandbox workspace-write \
  "Create smoke-ok.txt containing exactly: headless-ok. Nothing else."

cat smoke-ok.txt   # 期望: headless-ok
```

### 5.4 对抗审查（多角色 = 多次 headless）

```bash
# 仓库内
cd /path/to/wezdeck   # 或 claw worktree

# 跨模型（推荐）
skills/adversarial-review/run.sh HEAD~1 \
  --reviewer claude --refuter grok --mode strict

# 同能力多角色（SINGLE-MODEL，仍跑 find+refute）
skills/adversarial-review/run.sh HEAD~1 \
  --reviewer claude --refuter claude --mode strict

# 只看计划、不调模型
skills/adversarial-review/run.sh HEAD~1 --dry-run \
  --reviewer claude --refuter grok
```

每次 gate = 一次 headless 调用（不同 prompt 立场），不是开两个 TUI 窗口。

### 5.5 探测本机路径（全名表）

```bash
./openclaw/scripts/agent-matrix-status.sh
```

---

## 6. 何时用哪种交互 / 执行通道

平台级选型表、统一 vs 刻意不合、`host-agent-invoke` 读写分档：见
[`../../docs/agent-scheduling.md`](../../docs/agent-scheduling.md)（**不**在 openclaw 私产下）。

Claw 侧速查：

| 你想… | 用 |
| --- | --- |
| 飞书边聊边改、要 steer / cancel | **ACP C3** |
| 跨仓契约 / research→implement | **Ticket-headless**（同一 skill `cross-repo-delegate`；票仓协议，多目录挂载仅战术，见平台 `#ticket-vs-multi-dir-mount`） |
| 飞书小改、编排台账 | **Main 飞书**（C1） |
| 人盯全程 | **TUI**（H2/C2） |

禁止：另建 OpenClaw 私有票库；ACP↛headless 无披露自动 failover。

---

## 7. 配置与安全（短）

| 路径 | 谁用 |
| --- | --- |
| `~/.claude` | Claude TUI + headless |
| `~/.codex` | Codex TUI + headless；**审查必须 env -u CODEX_HOME** |
| `~/.grok` | Grok-native |
| `~/.openclaw/acpx/codex-home` | **仅 Codex-ACP** |
| `~/.openclaw/openclaw.json` | Main-Grok 等 |

- 审查/ headless 写码：注意 sandbox / permission-mode，避免无脑 bypass。  
- wezdeck 验收后可直接合 `master`（见 AGENTS L0-13/19）。  

---

## 8. 相关入口

| 文档/脚本 | 内容 |
| --- | --- |
| `agent-architecture.md` | 双轨、ACP、Grok 三分 |
| [`../../docs/agent-scheduling.md`](../../docs/agent-scheduling.md) | 平台执行通道调度总览 |
| `terminology.md` | 术语与宪法/知识库分层 |
| `error-closed-loop-scope.md` | 错误闭环覆盖范围 vs OpenClaw 平台边界 |
| `docs/adversarial-review.md` | 三门与披露 |
| `scripts/dev/host-agent-invoke/` | 共享 host headless invoke（工单 write · 审查 read） |
| `skills/adversarial-review/` | 审查 headless（provider → host-agent-invoke） |
| `skills/cross-repo-delegate/` | 跨仓工单 + Ticket-headless worker |
| `openclaw/scripts/agent-matrix-status.sh` | 本机能力快照 |
| `workspace/AGENTS.md` | L0、推荐卡、C3 宪法前缀 |
