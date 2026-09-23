# Agent 调度架构（执行通道）

知识库：**人工轨 / 跨仓工单 / OpenClaw 控制面** 如何选型并起工人。  
不是 skill 步骤书；可执行手续仍在各 skill / `run.sh`。  
本文是 **平台级** 调度总览，不属于 OpenClaw 私产（OpenClaw 专用细节见 `openclaw/docs/`）。

相关：

- [`architecture.md`](./architecture.md)（WezDeck 运行时边界）
- [`adversarial-review.md`](./adversarial-review.md)（Review-headless）
- [`../openclaw/docs/agent-architecture.md`](../openclaw/docs/agent-architecture.md)（Claw 双轨 / ACP / Grok 三分）
- [`../openclaw/docs/agent-interaction.md`](../openclaw/docs/agent-interaction.md)（TUI / headless / 飞书用法）
- [`../openclaw/docs/terminology.md`](../openclaw/docs/terminology.md) §2

---

## 1. 一句话

```text
选型者（人 · Host TUI agent · OpenClaw Main）
  ├─ 人工 H1 / H2 TUI          → IDE 或 agent-launcher 原生 CLI
  ├─ Claw C1 Main自写          → Gateway 内嵌 Main-Grok
  ├─ Claw C2 Handoff           → brief 后人手开 TUI
  ├─ Claw C3 ACP               → sessions_spawn / acpx → claude|codex
  ├─ Ticket-headless           → cross-repo-delegate → host-agent-invoke (write)
  └─ Review-headless           → adversarial-review / fanout → provider __invoke (read)
```

**后端全名**回答「哪个产品/配置」；**执行通道**回答「怎么起进程」。二者正交。

---

## 2. 执行通道（现行）

| 通道 | 调度者 | Transport | 后端 | 状态/契约 | Attention |
| --- | --- | --- | --- | --- | --- |
| **Handoff/TUI** | 人（H2 / C2 brief 后） | 交互 CLI | Claude/Codex/Grok-native | pane / resume | **参与** Alt+/ |
| **Main自写** | OpenClaw Gateway Main | 内嵌模型 | Main-Grok | 飞书会话 + git | 不进 Alt+/ 工人徽章 |
| **ACP** | Main `/acp` · `sessions_spawn` | acpx | Claude-ACP / Codex-ACP（无 grok spawn） | ACP session；可 steer/cancel | SKIP（`OPENCLAW_ACP` 等） |
| **Ticket-headless** | 任意 agent 跑 `delegate`（Host TUI 或 Main） | host headless | claude/codex/grok | `~/.agent/tickets/` + result JSON | SKIP（`DELEGATE_HEADLESS`） |
| **Review-headless** | adversarial-review / brainstorm | host headless | 同上（provider 插件） | stdout JSON / out 目录 | SKIP |

票仓 **单源**：`scripts/dev/cross-repo-delegate/` → `~/.agent/tickets/`。  
**禁止**另建 OpenClaw 私有票库。

---

## 3. 已统一 vs 刻意不合

### 已统一 / 已落地

| 层 | 真相 |
| --- | --- |
| 票仓 + skill | 同一 `cross-repo-delegate`；OpenClaw workspace 仅链接 |
| Ticket host CLI 起法 | `scripts/dev/host-agent-invoke/`（`read`\|`write`）；工单 research/implement 走 **`write`**（结果文件契约） |
| Attention 语义 | 委托工人 `AGENT_ATTENTION_SKIP`；不写 Alt+/ ●/▲ |
| 单写者 / CODEX_HOME | host 审查/工单 `env -u CODEX_HOME`；ACP Codex 仅用 `~/.openclaw/acpx/codex-home` |

### 刻意不合（死线）

| 双轨 | 政策 |
| --- | --- |
| **ACP ↛ headless 自动 failover** | **Out of policy**。选型表显式选择；禁止无披露的暗桥。 |
| ACP ↔ Ticket-headless | 可 steer 长会话 ≠ 工单 phase hop；不合 runtime |
| `agent-launcher` ↔ 工人 | 交互 resume/徽章 ≠ headless；工人永不默认挂 pane |
| 票状态机 ↔ ACP session | status/owner/phase 只活在票仓 |

### Host headless 收敛状态

| 消费者 | 模式 | 入口 |
| --- | --- | --- |
| Ticket-headless | `write` | `cross-repo-delegate` → `host_agent_invoke_run` |
| Review-headless | `read` | `providers/*.sh` `__invoke` → `host_agent_invoke_run --capture` |
| agent-fanout | `read`（经 provider） | 同上 |

对外 `run_agent` / `fanout_*` API 不变；CLI flags / attention / CODEX_HOME 单源在 `host-agent-invoke`。

---

## 4. 怎么选通道

Host TUI / OpenClaw 推荐卡须同时写 **轨 + 执行通道 + 后端全名**（Claw：`openclaw/workspace/AGENTS.md` / `dev-task`）。

| 信号 | 选 |
| --- | --- |
| 人要盯全程 / 深改 | **Handoff/TUI** |
| 飞书边聊边改、要 steer/cancel | **ACP** |
| 跨仓契约、只交票 / 主会话认领改 / 明确委托工人 | **Ticket**（同一 skill；见下表三模式） |
| 同意图必须同时改 2+ 仓（共享类型 / 契约共改） | **战术多目录挂载**（产品能力；见 [Ticket vs multi-dir](#ticket-vs-multi-dir-mount)） |
| 小且清、Main 自己写 | **Main自写** |
| 多角色找茬 / 发散 | **Review-headless**（非写码工人） |

### cross-repo-delegate 三模式（票仓内）

| 模式 | 命令 | 开发者 | Attention |
| --- | --- | --- | --- |
| **1. 主会话创建工单** | `create`（无 `--run`） | 尚未开发；票进 inbox | 无工人 |
| **2. 主会话认领并开发** | `claim` → 当前 TUI/cwd 改码 | `owner=human`；**禁止**自动 worktree/worker | 主会话参与 Alt+/ |
| **3. 主会话建单并委托开发** | `create --run` / `run --phase auto` | headless worker + `delegate-*` worktree | SKIP（`DELEGATE_HEADLESS`） |

**硬规则：** `claim` ≠ `run`。TUI 认领后由主会话开发；只有用户明确要「委托 / 后台 / 派工人」才走 Mode 3。Session lease 下 `run` / `reply --continue` / `watch` 不会抢租约（除非 `run --steal`）。  
Mode 2 的 `--to .` / `--from .` 按 **主 worktree 根** 解析 allowlist（`git rev-parse --git-common-dir`）：在 `…/.worktrees/<repo>/<slug>` 里认领等于在主仓认领，不会把 slug basename 当成仓库名。

### Ticket vs multi-dir mount

**站位政策：**跨仓委托 / 认领 / 挑战假设 / 关单 → **票仓协议**（`cross-repo-delegate`）。  
厂商「多目录挂载」（Claude `--add-dir`、Codex multi-folder、Cursor multi-root 等）是 **同意图共改时的战术手段**，补不了所有权、契约与审计。

**更多可见文件 ≠ 更好的跨仓上下文。** 委托类工作要的是：目标仓会话加载本仓 `AGENTS.md` / `CLAUDE.md`、单写者 lease、可复盘的 `observed`/`assumed` 与 challenge 线程。源仓会话挂进目标仓目录后，常带着源仓世界观写目标仓，并冲掉 Git/PR 所有权边界。

| 信号 | 选 |
| --- | --- |
| 跨仓委托、异步交接、只交意图、要 challenge / reply | **Ticket**（Mode 1–3） |
| 一次语义变更必须同时落 2+ 仓（共享类型 rename、契约共改） | **战术多目录挂载**；做完即拆，不常驻 |
| 建票前只核对目标仓现状 | **只读**挂载或读目标仓；**写**仍落目标仓会话（Mode 2）或 Mode 3 worker |
| 源仓 agent「为了上下文」直接改 allowlist 目标仓当常驻协同 | **Out of policy** |

#### 厂商能力快照（约 2026-09；战术选型参考）

| 产品 | 直接跨仓能做什么 | 对委托类工作的缺口 |
| --- | --- | --- |
| **Claude Code** | `--add-dir` / `additionalDirectories` 读写邻仓；可选加载对方 `CLAUDE.md`；云端 Projects 可按仓开 thread + PR | 仍有主 cwd；挂载默认不加载对方仓规；无票状态机 |
| **Codex** | multi-folder 跨目录读写；CLI 早有 `--add-dir`；同仓 worktree 并行强 | **一个 primary Git root**：PR / `AGENTS.md` / skill 发现绑主 folder；次仓无对等交付面 |
| **Grok Build** | 单 workspace / `repo_root`；memory 按仓；subagent worktree 同仓隔离 | 无原生多根挂载；跨仓靠本调度层 |
| **Cursor** | multi-root：一会话挂多仓、意图不断裂 | multi-root 下 worktree / cloud agent 受限 |

行业共性：产品强化「看得见、改得动多目录」；**跨仓所有权与契约交接**仍由本仓票协议承担。

#### 刻意不合（补充）

| 双轨 | 政策 |
| --- | --- |
| 多目录挂载 ↛ 票仓状态机 | 挂载会话 **不** 替代 `submitted`/`challenge`/`close`；禁止另建第二票库 |
| 源仓 TUI 常驻写目标仓 | 目标仓开发走 Mode 2（本仓 cwd）或 Mode 3（目标 `delegate-*` worktree） |
| 「上下文更好」作绕过理由 | 紧耦合同意图共改才用战术挂载；委托 / 异步仍走票 |

手续与触发词：[`scripts/dev/cross-repo-delegate/SKILL.md`](../scripts/dev/cross-repo-delegate/SKILL.md)。

---

## 5. Host-headless 调用面（实现指针）

```text
scripts/dev/host-agent-invoke/lib/host-agent-invoke.sh
  host_agent_invoke_run --backend … --mode read|write --cwd … --prompt-file …
```

| mode | 用途 | 典型 flags |
| --- | --- | --- |
| `write` | 工单 research/implement（须写 `.delegate/*-result.json`） | claude `bypassPermissions`；codex `--full-auto`；grok `--always-approve` |
| `read` | 审查类（默认非写） | claude `plan` + Read/Grep/Glob；codex `read-only` sandbox |

Mock：`HOST_AGENT_INVOKE_MOCK=1` + `HOST_AGENT_INVOKE_TRACE`（JSONL）。  
工单 offline：`delegate … --mock` 仍走该面再写假 result（见 `cross-repo-delegate/test.sh`）。

Ticket 状态机 / phase-view / apply **留在** `cross-repo-delegate/lib/worker.sh`，不塞进 invoke 库。

---

## 6. 相关入口

| 路径 | 角色 |
| --- | --- |
| `scripts/dev/host-agent-invoke/` | 共享 host headless invoke |
| `scripts/dev/cross-repo-delegate/` | 票 + Ticket-headless worker |
| `scripts/dev/adversarial-review/` | Review-headless（provider，迁移延期） |
| `scripts/dev/agent-fanout/` | 多 backend 并行（依赖 provider） |
| `scripts/runtime/agent-launcher.sh` | **仅**交互 TUI |
| `openclaw/scripts/patch-acpx-attention-skip.sh` | ACP attention skip（OpenClaw 侧） |
