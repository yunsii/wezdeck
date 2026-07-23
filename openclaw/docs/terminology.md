# 术语与文档分层说明（OpenClaw / wezdeck）

目的：统一 **Claw / host / TUI / ACP / 宪法 / 知识库**，以及 **Model / Harness / Agent / Backend** 等说法，减少「同一词多义」。  
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

**构成口诀（与下节对照）：**  
`Model` 在 `Runtime/Harness` 里跑 → 得到 `Agent session`；被调度时再贴 `Backend` 标签（关系，非层）。  
OpenClaw 整体 = **控制面**；只对 Main 充当其 runtime。

---

## 1. 产品与控制面

| 术语 | 含义 | 不是 |
| --- | --- | --- |
| **OpenClaw** | 开源个人 AI **控制面**（Gateway、Main agent loop、通道、策略、编排） | 某一个 LLM 品牌；也 **不是** Claude/Codex 级 coding agent 的同义名 |
| **Gateway** | OpenClaw 守护进程：收消息、跑 agent、投递回复、工具与审批 | 飞书服务器本身 |
| **Main / Main agent** | 当前会话的主 agent（本机通常 `agent=main`） | Claude/Codex 进程 |
| **Main-Grok** | Main 使用的模型能力（配置里 provider+model，如 grok-4.5） | Grok 原生 CLI |
| **Claw / Claw 轨** | 经飞书/Main **编排** 的开发与任务轨（C1/C2/C3） | 一切 AI 活动的统称 |
| **人工轨** | 人不经 Main 写码，或仅用本机 TUI（H1/H2） | 「没有 agent」 |
| **Workspace** | Main 的工作区（常 symlink 到 `wezterm-config/openclaw/workspace`） | wezdeck 整个 git 仓 |
| **wezdeck** | 个人仓 `wezterm-config`（逻辑名）；OpenClaw 配置与技能的版本源之一 | OpenClaw 上游 npm 包 |

OpenClaw 与 harness 的关系见 [§2.4](#24-openclaw-算-harness-吗)。

---

## 2. Model · Harness · Agent · Backend（核心分层）

本节是 **概念标准**（知识库）。社区与官方用语不完全同名，下表固定 **本仓对外/对内怎么说**。

### 2.1 构成（竖轴）与关系（横轴）

**不要**把四者压成一条「Model → Harness → Agent → Backend」积木栈。  
Backend **不是** 比 Agent 更高的一层实体。

#### 构成（composition）

```text
Model              权重 / API / 路由 id（脑）
    │ 被谁调用
    ▼
Runtime / Harness  tools · auth · FS · permissions · session · hooks（手脚 + 规矩）
    │ 跑出谁
    ▼
Agent session      一次有身份的会话：Main / Claude-TUI 窗 / Codex-ACP 工人 / Scout
```

产品（Claude Code / Codex / Grok Build / OpenClaw Main）= 上述的 **打包**，不是再插进竖轴的第四层。

社区流行公式 **Agent ≈ Model + Harness** 与本竖轴同向：没有工具环就没有可调度的 coding agent 实例。

#### 关系（perspective）— Backend

```text
调用方（Main / run.sh / 人）
        │ 调度
        ▼
   「Backend」标签  ──►  指向某个 Agent session（+ 其 Runtime + Model）
```

同一进程：对人可以是「当前 agent」，对 Main/审查脚本是「backend」。换调用方，标签变，实体不变。

### 2.2 术语表

| 术语 | 含义 | 不是 | 本仓例子 |
| --- | --- | --- | --- |
| **Model** | 实际模型 id / 路由目标 | 整个 CLI 产品 | `grok-4.5`、Codex 默认 GPT、Main 的 provider/model |
| **Runtime / Harness** | 模型之外的脚手架：工具循环、权限、沙箱、FS、auth、session、hooks | 单独的「会话角色」；也 **不是** 官方产品主称 | Claude Code / Codex / Grok Build **内部** runtime；Main 在 Gateway 上的 agent loop |
| **Coding agent（产品）** | 官方与用户对 **整包** 的称呼（Model + Harness + 默认 prompt/skills） | harness 工程黑话的同义词 | Claude Code、Codex、Grok Build（`grok` CLI） |
| **Agent session** | 一次有身份的运行（会写码或编排） | 裸 model id | Claude-TUI 窗、Codex-ACP 工人、Main 飞书会话、Scout |
| **Backend** | **调用方视角**下的「干活后端」——关系标签 | 构成栈上的新层 | C3 `agentId=claude`；review alias `grok`；trailer `backend=main` |
| **Control plane** | 编排多方 session、通道、策略的系统 | coding agent 产品的同义替换 | **OpenClaw**（Gateway + Main 编排） |

### 2.3 谁约束谁（动词）

| 说法 | 对不对 |
| --- | --- |
| Agent session **使用** harness 提供的工具 | ✅ |
| Harness **约束** session（权限、沙箱、allowlist） | ✅ |
| Session **操作 / 控制** harness（改权限模型、换外壳） | ❌ 一般不行 |
| 人 / 控制面 **配置** harness 或 **调度** session | ✅ |
| Model 提议 tool call → Harness 执行/拒绝/要人批 → 结果回灌 | ✅ 标准环 |

口诀：**Harness 是外壳与规矩；Agent session 是壳里跑着的那次会话；Backend 是别人怎么称呼它。**

### 2.4 OpenClaw 算 harness 吗？

| 说法 | 准不准 |
| --- | --- |
| OpenClaw = **个人 AI 控制面** | ✅ **主称** |
| OpenClaw **对 Main** 提供 runtime（会话、工具、审批、投递） | ✅ 可说「Main 跑在 OpenClaw runtime 上」 |
| OpenClaw = Claude/Codex 的 harness | ❌ 否；C3 时它们各自仍用自家 tools/auth/FS |
| OpenClaw = 「又一个 Claude Code 级 coding harness」 | ❌ 否 |

```text
飞书 → Gateway（控制面）
         ├─ Main session  … OpenClaw 充当其 Runtime
         └─ C3 ACP → Claude/Codex 进程 … 仍是对方产品的 Harness
```

ACP 栈里「harness = 被接入 coding 进程的 tools/auth/FS」时，指的是 **工人进程一侧**，不是把整个 OpenClaw 改名叫 harness。详见仓库 `openclaw/README.md` ACP 小节。

### 2.5 官方 vs 社区 vs 本仓

| 来源 | 常见说法 | 本仓怎么用 |
| --- | --- | --- |
| **Claude Code / Codex / Grok Build 官方** | 主称 **coding agent** / *agentic coding tool* | 对外：coding agent 产品；全名 Claude-TUI / Codex-TUI / Grok-native |
| **社区 / 工程博文** | Agent = Model + Harness；常把 Claude Code 等 **叫作 harness** | 写架构、拆零件时用 Runtime/Harness；**不**替代产品主称 |
| **本仓第三义** | *bench harness*（压测/测量夹具） | 仅性能/测试文档；与 agent harness **同词不同义** |
| **OpenAI「harness engineering」等** | 有时指 agent 友好的工程环境（repo/CI/约定） | 不与 coding harness 混谈 |

### 2.6 会话盒子（一眼图）

```text
┌──────────── Agent session（身份：Claude-TUI / Main / …）────────────┐
│  prompt · 记忆 · cwd · 角色                                         │
│  ┌──────── Runtime / harness ────────────────────────────────────┐  │
│  │ tools · auth · FS · permissions · hooks · session store       │  │
│  │              ▲                                                │  │
│  │              │ calls                                          │  │
│  │         Model (id / route)                                    │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
         ▲
         │ 若被调度：调用方贴「Backend」标签（不改变盒子）
```

### 2.7 禁止混谈（速查）

| 禁止 | 应说 |
| --- | --- |
| 「OpenClaw 就是 coding harness」 | OpenClaw **控制面**；Main 有 runtime |
| 「审查 backend 等于 ACP harness id」 | review alias ≠ ACP `agentId` 语义混谈（见 `docs/adversarial-review.md`） |
| 「Grok 三分随便互换」 | Grok-native / Main-Grok / Codex-Grok-profile 分栏 |
| 裸词 `claude` 当唯一指称 | 全名：Claude-TUI / Claude-ACP / Claude-host-headless |

---

## 3. Host / TUI / Headless / ACP

| 术语 | 含义 | 典型入口 |
| --- | --- | --- |
| **Host** | 本机用户环境：shell、PATH、家目录配置 | Linux/WSL 上的 `claude`/`codex`/`grok` |
| **Host 配置** | `~/.claude` · `~/.codex` · `~/.grok` | 用户资产；**ACP 不得静默改默认** |
| **TUI** | 交互式终端 UI（多轮、可点权限） | `claude` / `codex` 交互模式 |
| **Headless CLI** | 非交互、一次跑完（stdin/参数 → stdout） | `claude -p` · `codex exec`；审查默认用此 |
| **ACP** | Agent Client Protocol：**接入层**，把外部 coding agent 挂进 Claw | `sessions_spawn(runtime=acp)` |
| **Claude-ACP / Codex-ACP** | 经 ACP 拉起的写码 **backend**（全名） | 不是「又一个 Main」；工人侧仍用各自 harness |
| **Claude-TUI / Codex-TUI** | 本机原生交互 CLI（全名） | H2/C2；官方意义上的 coding agent 产品会话 |
| **Codex-Grok-profile** | host `codex -p grok`（审查/手工常用） | ≠ Main-Grok ≠ Grok-native |
| **Grok-native** | 本机 `grok` CLI + `~/.grok` | ≠ Main-Grok |
| **ACP CODEX_HOME** | `~/.openclaw/acpx/codex-home`，仅 ACP Codex 隔离 | 禁止当审查默认 home |

**记忆口诀：**  
TUI/Headless = **Host 产品怎么跑**；ACP = **Claw 怎么接到 Host 产品**；Main = **OpenClaw 自己的 agent**；构成细节见 [§2](#2-model--harness--agent--backend核心分层)。

---

## 4. 开发方式（轨 · 方式 · 写者）

| 术语 | 含义 |
| --- | --- |
| **轨** | 人工 / Claw（用户主语言） |
| **方式** | H1 人直接 · H2 原生 TUI · C1 Main 自写 · C2 Handoff · C3 ACP（旧 A–E 仅括号辅注） |
| **写者 / writer** | 实际改代码的一方（人 / Main / Claude-ACP / Codex-TUI…）——即某 Agent session 或人 |
| **单写者** | 同一 cwd 同时只允许一个写者（L0 核心） |
| **Handoff** | Main 停笔，把任务交给本机 TUI，并给续跑说明 |
| **推荐卡** | 动手前必发的开发方式抉择卡（**全名** backend / 写者） |

---

## 5. 仓库 · 分支 · Worktree

| 术语 | 含义 |
| --- | --- |
| **Primary** | 主 checkout（wezdeck 常为 `$HOME/github/wezterm-config`） |
| **主分支 / mainline** | `master` 或 `main` |
| **个人项目优先主分支** | **L0 VCS 核心**：个人仓默认主分支直开直推；并行/隔离才分支（L0-13） |
| **claw-\* worktree** | 隔离任务树：`dirname(primary)/.worktrees/<repo>/claw-…` |
| **Allowlist** | Main 允许写的仓根（wezdeck、团队仓等） |
| **Assisted-by trailer** | 提交脚注：`Assisted-by: OpenClaw (backend=…, model=…)`；Author 仍是主人 |

---

## 6. 质量与审查

| 术语 | 含义 |
| --- | --- |
| **对抗审查** | **多角色** find + refute（+ repro）；平台 skill + `run.sh` |
| **设计批判** | 单角色分析；**禁止**叫对抗审查 |
| **writer-aware 选路** | 按写码家族回避主审；策略 B |
| **SINGLE-MODEL** | 同后端两次对立角色；可做对抗审查但不可宣称跨模型 |
| **Review backend** | 审查脚本视角的 backend 别名（`claude` / `codex` / `grok`）——**不是** OpenClaw ACP harness id |
| **错误闭环** | 同轮 agent 可见失败：检测→自愈→验证→人话汇报 |
| **平台硬场景** | fallback 错误句、投递失败等；闭环 **覆盖不了**（见 `error-closed-loop-scope.md`） |

---

## 7. 宪法 · 法则分层 · 知识库（最重要）

### 7.1 文档类型

| 类型 | 作用 | 例子 | 改动策略 |
| --- | --- | --- | --- |
| **宪法 / L0 核心** | always-on 或 Default Posture 必守；**跨 Claw 与 Host 精神一致** | 单写者、个人主分支、Author/trailer、错误闭环、对抗多角色、密钥/force-push | 改一侧必须问/同步另一侧 |
| **L1 场景法则 · Claw** | 只约束飞书/Main 交互与编排 | 飞书克制、精简结果卡、台账、推荐卡、C3 前缀 | **不必**抄进 agent-profiles |
| **L1 场景法则 · Host** | 只约束本机 TUI/工具习惯 | permissions 分层、通用 tool-use 细节 | **不必**塞进飞书 always-on |
| **Skill（可执行规程）** | Agent **加载后执行**；人只下意图 | `adversarial-review` · `dev-task` · `error-closed-loop` | 改 skill 即改行为 |
| **Runner / 脚本** | 唯一实现细节 | `scripts/dev/adversarial-review/run.sh` | 一处实现，多处发现 |
| **知识库 / 说明文档** | 给人与 agent **查阅**；不默认进 always-on | 本文件、`agent-architecture.md`、`terminology.md`、`error-closed-loop-scope.md` | 可长、可表、可演进 |
| **实例规则** | 核心原则在某仓的落点 | wezdeck = 个人主分支实例；团队仓 = 团队偏隔离 | 实例可变，核心不改 |

### 7.2 宪法载体（写在哪）

| 载体 | 谁加载 | 内容重心 |
| --- | --- | --- |
| **`openclaw/workspace/AGENTS.md`** | OpenClaw Main（飞书） | L0 核心 + Claw L1 + 写任务清单 |
| **`agent-profiles/v1/en/AGENTS.md` + topics** | Host Claude/Codex（TUI 等） | L0 精神 + Host L1（permissions/vcs/validation…） |
| **Skills under workspace / repo `skills/`** | 按需 load | 怎么做（操作） |
| **`openclaw/docs/*`** | 查阅 | 为什么、边界、术语、架构 |

### 7.3 「写入宪法」vs「仅知识库」判据

| 写入 **L0 核心宪法** 若… | 仅 **知识库 / L1** 若… |
| --- | --- |
| 违反会跨任务造成事故或假成功 | 只影响一种交互面的体验 |
| Claw 与 Host **都应**遵守 | 只飞书或只 TUI 需要 |
| 需要 always-on 才能拦 | 按需打开 skill/文档即可 |
| 例：单写者、个人主分支、对抗定义 | 例：飞书字数预算、某脚本 flags 说明；Model/Harness 名词表 |

### 7.4 同步义务（L0-17）

```text
改 L0 核心 → claw AGENTS 与 agent-profiles 精神同步
改 L1 Claw  → 只 claw（如飞书克制）
改 L1 Host  → 只 profiles（如 permissions-claude）
改知识库   → 不强制改 always-on
```

---

## 8. 模型与 Provider（配置层）

与 [§2 Model](#22-术语表) 互补：本节偏 **OpenClaw 配置与 trailer**，不重复构成栈。

| 术语 | 含义 |
| --- | --- |
| **Provider** | OpenClaw 配置里的供应商 id（如 `grok-proxy`）——路由/账号，不是模型官方名 |
| **Model** | 实际模型 id（如 `grok-4.5`） |
| **provider/model** | 运行时完整路由；git trailer **优先短 model**，不必绑 `*-proxy` 后缀 |
| **backend=main** | trailer / 汇报：写码/编排是 Main 内置 agent（≠ Claude-ACP） |

---

## 9. 通道与投递（简述）

| 术语 | 含义 |
| --- | --- |
| **Feishu / 飞书 DM** | Main 的主聊天面；默认 **短回复**（L1 Claw） |
| **textChunkLimit** | 通道硬切上限（如 4000）；**不是**写作目标 |
| **deliveryStatus** | 投递结果：delivered / partial / failed… |
| **Fallback 错误句** | 无正文时 Gateway 硬拼的错误 payload；**非** Main 自由文本 |

---

## 10. 推荐对外说法（交流用语）

| 想表达 | 建议说 |
| --- | --- |
| 飞书里的编排 agent | **Main** / **Claw · C1 Main-Grok** |
| 本机 Claude / Codex / Grok 交互产品 | **coding agent**（官方主称）+ 全名 **Claude-TUI** / **Codex-TUI** / **Grok-native** |
| 经 OpenClaw 拉起的 Claude | **Claude-ACP**（backend） |
| 本机 Codex + Grok 配置 | **Codex-Grok-profile**（审查）或 **Codex-TUI** |
| 工具/权限/FS 外壳 | **Runtime / harness**（工程拆零件；非产品主称） |
| OpenClaw 整体 | **控制面** / Gateway + Main；**不要**默认叫 coding harness |
| 审查脚本调谁 | **review backend** `claude` / `codex` / `grok` |
| 纪律 always-on | **L0 核心** / **宪法** |
| 飞书怎么说话 | **L1 Claw（飞书克制）** |
| TUI 权限怎么配 | **L1 Host（agent-profiles）** |
| 查概念分层 | **知识库** 本文 [§2](#2-model--harness--agent--backend核心分层) |
| 查怎么跑审查 | **Skill** `adversarial-review` |

---

## 11. 维护

- 新词：先判 **L0 / L1 / 知识库 / skill**，再落文件。  
- 重名禁止：同一概念固定一个「对外全名」。  
- **Model / Harness / Agent session / Backend / Control plane** 的定义以本文 §2 为准；其它文档只交叉引用，勿平行发明第四套。  
- 本文件更新不自动改 always-on；若词义变更触及 L0，须升宪法并同步 profiles。
