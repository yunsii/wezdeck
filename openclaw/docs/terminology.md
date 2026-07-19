# 术语与文档分层说明（OpenClaw / wezdeck）

目的：统一 **Claw / host / TUI / ACP / 宪法 / 知识库** 等说法，减少「同一词多义」。  
本文是 **维护用知识库**（可改、可扩），不是 always-on 系统提示全文。

相关：[`README.md`](./README.md)（文档地图）· [`agent-architecture.md`](./agent-architecture.md) · [`agent-interaction.md`](./agent-interaction.md) · `workspace/AGENTS.md` · `agent-profiles/v1/`

**读序（5 分钟）：** terminology → architecture → interaction → AGENTS L0 → skills 按需。详见 [`README.md`](./README.md)。
**数字员工三角：** Dex(`main`) / Bob(`pm`) / Scout(`radar`) — 见 [`digital-employees.md`](./digital-employees.md)。

---

## 0. 一句话地图

```text
人
 ├─ 飞书 ──► OpenClaw Gateway ──► Main agent（Claw 控制面）
 │                                    ├─ C1 自写（调 model API + 工具）
 │                                    ├─ C2 handoff → Host TUI
 │                                    └─ C3 ACP → Claude/Codex 后端
 │
 └─ 本机终端 ──► Host 原生 CLI（TUI / headless）
                      配置：~/.claude · ~/.codex · ~/.grok
                      纪律：agent-profiles（宪法 L0 共享 + Host L1）
```

---

## 1. 产品与控制面

| 术语 | 含义 | 不是 |
| --- | --- | --- |
| **OpenClaw** | 开源个人 AI 控制面产品/运行时（Gateway、agent loop、通道、工具） | 某一个 LLM 品牌 |
| **Gateway** | OpenClaw 守护进程：收消息、跑 agent、投递回复、工具与审批 | 飞书服务器本身 |
| **Main / Main agent** | 当前会话的主 agent（本机通常 `agent=main`） | Claude/Codex 进程 |
| **Main-Grok** | Main 使用的模型能力（配置里 provider+model，如 grok-4.5） | Grok 原生 CLI |
| **Claw / Claw 轨** | 经飞书/Main **编排** 的开发与任务轨（C1/C2/C3） | 一切 AI 活动的统称 |
| **人工轨** | 人不经 Main 写码，或仅用本机 TUI（H1/H2） | 「没有 agent」 |
| **Workspace** | Main 的工作区（常 symlink 到 `wezterm-config/openclaw/workspace`） | wezdeck 整个 git 仓 |
| **wezdeck** | 个人仓 `wezterm-config`（逻辑名）；OpenClaw 配置与技能的版本源之一 | OpenClaw 上游 npm 包 |

---

## 2. Host / TUI / Headless / ACP

| 术语 | 含义 | 典型入口 |
| --- | --- | --- |
| **Host** | 本机用户环境：shell、PATH、家目录配置 | Linux/WSL 上的 `claude`/`codex`/`grok` |
| **Host 配置** | `~/.claude` · `~/.codex` · `~/.grok` | 用户资产；**ACP 不得静默改默认** |
| **TUI** | 交互式终端 UI（多轮、可点权限） | `claude` / `codex` 交互模式 |
| **Headless CLI** | 非交互、一次跑完（stdin/参数 → stdout） | `claude -p` · `codex exec`；审查默认用此 |
| **ACP** | Agent Client Protocol：**接入层**，把外部 coding agent 挂进 Claw | `sessions_spawn(runtime=acp)` |
| **Claude-ACP / Codex-ACP** | 经 ACP 拉起的写码后端（全名） | 不是「又一个 Main」 |
| **Claude-TUI / Codex-TUI** | 本机原生交互 CLI（全名） | H2/C2 |
| **Codex-Grok-profile** | host `codex -p grok`（审查/手工常用） | ≠ Main-Grok ≠ Grok-native |
| **Grok-native** | 本机 `grok` CLI + `~/.grok` | ≠ Main-Grok |
| **ACP CODEX_HOME** | `~/.openclaw/acpx/codex-home`，仅 ACP Codex 隔离 | 禁止当审查默认 home |

**记忆口诀：**  
TUI/Headless = **Host 产品怎么跑**；ACP = **Claw 怎么接到 Host 产品**；Main = **OpenClaw 自己的 agent**。

---

## 3. 开发方式（轨 · 方式 · 写者）

| 术语 | 含义 |
| --- | --- |
| **轨** | 人工 / Claw（用户主语言） |
| **方式** | H1 人直接 · H2 原生 TUI · C1 Main 自写 · C2 Handoff · C3 ACP（旧 A–E 仅括号辅注） |
| **写者 / writer** | 实际改代码的一方（人 / Main / Claude-ACP / Codex-TUI…） |
| **单写者** | 同一 cwd 同时只允许一个写者（L0 核心） |
| **Handoff** | Main 停笔，把任务交给本机 TUI，并给续跑说明 |
| **推荐卡** | 动手前必发的开发方式抉择卡（全名后端） |

---

## 4. 仓库 · 分支 · Worktree

| 术语 | 含义 |
| --- | --- |
| **Primary** | 主 checkout（wezdeck 常为 `$HOME/github/wezterm-config`） |
| **主分支 / mainline** | `master` 或 `main` |
| **个人项目优先主分支** | **L0 VCS 核心**：个人仓默认主分支直开直推；并行/隔离才分支（L0-13） |
| **claw-\* worktree** | 隔离任务树：`dirname(primary)/.worktrees/<repo>/claw-…` |
| **Allowlist** | Main 允许写的仓根（wezdeck、团队仓等） |
| **Assisted-by trailer** | 提交脚注：`Assisted-by: OpenClaw (backend=…, model=…)`；Author 仍是主人 |

---

## 5. 质量与审查

| 术语 | 含义 |
| --- | --- |
| **对抗审查** | **多角色** find + refute（+ repro）；平台 skill + `run.sh` |
| **设计批判** | 单角色分析；**禁止**叫对抗审查 |
| **writer-aware 选路** | 按写码家族回避主审；策略 B |
| **SINGLE-MODEL** | 同后端两次对立角色；可做对抗审查但不可宣称跨模型 |
| **错误闭环** | 同轮 agent 可见失败：检测→自愈→验证→人话汇报 |
| **平台硬场景** | fallback 错误句、投递失败等；闭环 **覆盖不了**（见 `error-closed-loop-scope.md`） |

---

## 6. 宪法 · 法则分层 · 知识库（最重要）

### 6.1 文档类型

| 类型 | 作用 | 例子 | 改动策略 |
| --- | --- | --- | --- |
| **宪法 / L0 核心** | always-on 或 Default Posture 必守；**跨 Claw 与 Host 精神一致** | 单写者、个人主分支、Author/trailer、错误闭环、对抗多角色、密钥/force-push | 改一侧必须问/同步另一侧 |
| **L1 场景法则 · Claw** | 只约束飞书/Main 交互与编排 | 飞书克制、精简结果卡、台账、推荐卡、C3 前缀 | **不必**抄进 agent-profiles |
| **L1 场景法则 · Host** | 只约束本机 TUI/工具习惯 | permissions 分层、通用 tool-use 细节 | **不必**塞进飞书 always-on |
| **Skill（可执行规程）** | Agent **加载后执行**；人只下意图 | `adversarial-review` · `dev-task` · `error-closed-loop` | 改 skill 即改行为 |
| **Runner / 脚本** | 唯一实现细节 | `scripts/dev/adversarial-review/run.sh` | 一处实现，多处发现 |
| **知识库 / 说明文档** | 给人与 agent **查阅**；不默认进 always-on | 本文件、`agent-architecture.md`、`terminology.md`、`error-closed-loop-scope.md` | 可长、可表、可演进 |
| **实例规则** | 核心法则在某仓的落点 | wezdeck = 个人主分支实例；团队仓 = 团队偏隔离 | 实例可变，核心不改 |

### 6.2 宪法载体（写在哪）

| 载体 | 谁加载 | 内容重心 |
| --- | --- | --- |
| **`openclaw/workspace/AGENTS.md`** | OpenClaw Main（飞书） | L0 核心 + Claw L1 + 写任务清单 |
| **`agent-profiles/v1/en/AGENTS.md` + topics** | Host Claude/Codex（TUI 等） | L0 精神 + Host L1（permissions/vcs/validation…） |
| **Skills under workspace / repo `skills/`** | 按需 load | 怎么做（操作） |
| **`openclaw/docs/*`** | 查阅 | 为什么、边界、术语、架构 |

### 6.3 「写入宪法」vs「仅知识库」判据

| 写入 **L0 核心宪法** 若… | 仅 **知识库 / L1** 若… |
| --- | --- |
| 违反会跨任务造成事故或假成功 | 只影响一种交互面的体验 |
| Claw 与 Host **都应**遵守 | 只飞书或只 TUI 需要 |
| 需要 always-on 才能拦 | 按需打开 skill/文档即可 |
| 例：单写者、个人主分支、对抗定义 | 例：飞书字数预算、某脚本 flags 说明 |

### 6.4 同步义务（L0-17）

```text
改 L0 核心 → claw AGENTS 与 agent-profiles 精神同步
改 L1 Claw  → 只 claw（如飞书克制）
改 L1 Host  → 只 profiles（如 permissions-claude）
改知识库   → 不强制改 always-on
```

---

## 7. 模型与 Provider（易混）

| 术语 | 含义 |
| --- | --- |
| **Provider** | OpenClaw 配置里的供应商 id（如 `grok-proxy`）——路由/账号，不是模型官方名 |
| **Model** | 实际模型 id（如 `grok-4.5`） |
| **provider/model** | 运行时完整路由；git trailer **优先短 model**，不必绑 `*-proxy` 后缀 |
| **backend=main** | 写码/编排是 Main 内置 agent | ≠ Claude-ACP |

---

## 8. 通道与投递（简述）

| 术语 | 含义 |
| --- | --- |
| **Feishu / 飞书 DM** | Main 的主聊天面；默认 **短回复**（L1 Claw） |
| **textChunkLimit** | 通道硬切上限（如 4000）；**不是**写作目标 |
| **deliveryStatus** | 投递结果：delivered / partial / failed… |
| **Fallback 错误句** | 无正文时 Gateway 硬拼的错误 payload；**非** Main 自由文本 |

---

## 9. 推荐对外说法（交流用语）

| 想表达 | 建议说 |
| --- | --- |
| 飞书里的编排 agent | **Main** / **Claw · C1 Main-Grok** |
| 本机 Claude 交互 | **Claude-TUI** |
| 经 OpenClaw 拉起的 Claude | **Claude-ACP** |
| 本机 Codex + Grok 配置 | **Codex-Grok-profile**（审查）或 **Codex-TUI** |
| 纪律 always-on | **L0 核心** / **宪法** |
| 飞书怎么说话 | **L1 Claw（飞书克制）** |
| TUI 权限怎么配 | **L1 Host（agent-profiles）** |
| 查概念 | **知识库** `openclaw/docs/terminology.md` |
| 查怎么跑审查 | **Skill** `adversarial-review` |

---

## 10. 维护

- 新词：先判 **L0 / L1 / 知识库 / skill**，再落文件。  
- 重名禁止：同一概念固定一个「对外全名」。  
- 本文件更新不自动改 always-on；若词义变更触及 L0，须升宪法并同步 profiles。
