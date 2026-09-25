<p align="center">
  <img src="assets/brand/banner.svg" alt="WezDeck — 面向 AI agent 的驾驶舱" width="960">
</p>

<h1 align="center">WezDeck</h1>

<p align="center">
  <em>面向 AI agent 的终端驾驶舱 — 基于 WezTerm、tmux 与 git worktree。</em>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="WezTerm: nightly" src="https://img.shields.io/badge/wezterm-nightly-8b5cf6">
  <img alt="tmux: ≥ 3.7" src="https://img.shields.io/badge/tmux-%E2%89%A5%203.7-1f6feb">
  <img alt="Platform" src="https://img.shields.io/badge/platform-linux%20%C2%B7%20wsl%20%C2%B7%20macOS-22d3ee">
  <img alt="Lua" src="https://img.shields.io/badge/lua-5.4-000080">
</p>

> 一个 WezTerm tab 对应一个仓库；一个 tmux window 对应一个 worktree；一个 pane 可以挂一个 agent。一键跳到正在等你的那个。

本仓库是 WezDeck 运行时的单一事实来源。GitHub 仓库：[`yunsii/wezdeck`](https://github.com/yunsii/wezdeck)（旧地址 `yunsii/wezterm-config` 仍可通过 GitHub 永久重定向访问）。

## 设计立场

WezDeck 不是一堆快捷键，而是面向多 agent 终端工作的**控制面**。三条约束约束每一次新交互；它们同样写在 [`AGENTS.md` · Design stance](AGENTS.md#design-stance) / Hard Rules 里，对 agent 有约束力——不是 README 营销文案。

| 约束 | 实践含义 |
|---|---|
| **键盘优先** | 每个新增或改动的交互必须有键盘路径；鼠标仅作兜底。Manifest 与 palette 覆盖同一批动作。 |
| **Agent 无头验证** | Debug Chrome 默认无头自启（`CDP·H·…`）；agent 经 CDP/MCP 接入，不抢 GUI 焦点。 |
| **开发过程可观测** | 热路径发出结构化信号，便于复盘一天、门控延迟、优化习惯——而不是靠记忆猜。没有徽章 / 日志 / 投影路径的功能视为**未完成**。 |

第三条是迭代的承重约束：徽章实时告警，日志解释「手感粘」或 attention 卡住，日/周投影把同一批信号变成可复盘闭环。长文见 [`docs/presentations/`](docs/presentations/)。

## ✨ 亮点

- **Tab × Worktree × Agent 同框** — 每个 WezTerm tab 一个仓库，每个 tmux window 一个 linked worktree，每个 pane 可挂 agent CLI（`claude` / `codex` / `grok` / …）。
- **主 pane 自动续聊** — 托管 agent pane 经 `agent-launcher.sh` 以 `<base>-resume` 启动；WezTerm 或整机重启后进入 worktree 会续上上次对话（没有会话则开新会话）。
- **实时 attention 面** — tab 徽章 + 右状态计数 `▲ N waiting ✓ N done ● N running`，由 agent hooks → `attention.json` 驱动。
- **槽内跳转键** — `Alt+j` / `Alt+k` / `Alt+l` 分别步进 waiting / done / running；`Alt+/` 与 `Alt+x` 是偶发总览 / overflow 选择器，不是主循环。
- **一键开 worktree** — `Ctrl+k g d/t/h` 在没有合适槽位时切开 linked worktree（并带上配套 agent）。
- **Manifest 驱动热键** — `wezterm-x/commands/manifest.json` 是唯一事实来源；本机覆盖在 `wezterm-x/local/keybindings.lua`。
- **开发环境可观测** — 右状态压力徽章、结构化 runtime / WezTerm 日志、阈值门控 latency，以及日环 timeline 与 habit-weekly 投影，用于复盘。

## 🎛️ 工作台 · 一天的主循环

> 先落到槽位（workspace / tab / worktree），保持 agent 续聊，再在槽内跳转与验证。实测日环由 `Alt+j/k/l` 与 `Alt+v` 主导——不是总览 picker。

```text
需求出现
  → 切 workspace (Alt+w/c/…) · tab (Alt+1..9) · worktree (Alt+g)
       └─ 没有合适槽位 → Ctrl+k g d|t|h  创建后进入
  → 该 cwd 的主 pane 自动 resume
  → 主循环: Alt+j waiting · Alt+k done · Alt+l running
               + Alt+v 打开 VS Code（日常验证路径）
       · 旁路: Alt+b debug Chrome · Alt+/ 总览 · Alt+x overflow
  → 交付到 origin/HEAD → recycle (dev-*) / reclaim (task|hotfix)
```

| 阶段 | 能力 | 深入阅读 |
|---|---|---|
| 落到槽位 | Workspace 切换 + tab 序号 + **`Alt+g`**；没有才创建 | [Workspaces](docs/workspaces.md) |
| 重启后续聊 | **`<base>-resume`**（`agent-launcher.sh`）+ access-ledger 焦点恢复 | [Architecture · startup](docs/architecture.md#startup-invariants) |
| 槽内主循环 | 徽章 / 计数 + **`Alt+j/k/l`**（真实日环最高频键） | [Agent attention](docs/agent-attention.md) |
| 验证 | 日常 **`Alt+v`**；需要 debug Chrome 时用 **`Alt+b`**（MCP 共用 CDP） | [Browser debug](docs/browser-debug.md) |
| 收尾本轮 | 主线交付（无 PR）→ **`worktree-recycle`** / reclaim | [Maintenance loop](docs/workspaces.md#maintenance-loop-wezdeck-standing-policy) |
| 复盘日 / 周 | 同一批信号上的 timeline + habit 报告 | [Diagnostics · timeline](docs/diagnostics.md#workflow-timeline) · [Habit report](docs/diagnostics.md#habit-report) |

## 📡 可观测面

三层共用一个想法：**看不见，就无法改进。**

### 实时右状态（操作员一瞥）

从左到右（压力徽章在健康时**不出现**——出现本身就是信号）：

`IME` · `CDP·…` · `◆ SB·N` · `D·…` · `M·…` · attention 计数

| 段 | 含义 | 深入阅读 |
|---|---|---|
| `CDP·H/V/-/?·port` | 无头 / 有窗 / 已退出 / helper 心跳过期 | [Browser debug](docs/browser-debug.md) |
| `◆ SB·N` | session-bridge watch 轮询器 | [session-bridge](openclaw/docs/session-bridge.md) |
| `D·…` | WSL `ext4.vhdx` 背后的主机卷余量 | [Host disk](docs/host-disk.md) |
| `M·…` | Guest 内存压力 / earlyoom 临近 | [Guest OOM](docs/guest-oom.md) |
| `▲ / ✓ / ●` | waiting / done / running attention | [Agent attention](docs/agent-attention.md) |

### 结构化日志 + latency（为什么手感粘？）

- WSL `runtime.log` + Windows `wezterm.log` / `helper.log` — 按 category 分行（`attention`、`hotkey`、`latency` …）。
- 阈值门控的慢热键 / status tick 行；慢样本会附带与 `M·` 同源的 guest 压力字段。
- 操作入口：[`docs/diagnostics.md`](docs/diagnostics.md) · 作者约定：[`docs/logging-conventions.md`](docs/logging-conventions.md) · 报告：`scripts/dev/latency-report.sh`。

### 日 / 周重建（复盘与优化）

| 投影器 | 回答的问题 | 入口 |
|---|---|---|
| **Workflow timeline** | 今天如何在 workspace / worktree / attention / 宿主验证之间移动？ | `scripts/dev/workflow-timeline.sh` · [文档](docs/diagnostics.md#workflow-timeline) |
| **Habit report / weekly** | Agent 并发、skills/MCP/CLI、verify→iterate、热键强度，以及可选 WakaTime / Rime / git churn | `scripts/dev/habit-report.sh` · skill `habit-weekly` · [文档](docs/diagnostics.md#habit-report) |

```bash
scripts/dev/workflow-timeline.sh --summary
scripts/dev/habit-report.sh --days 7
# 周报成文：加载 skill habit-weekly → skills/habit-weekly/run.sh
```

## 🧭 工作原理

```
WezTerm tab          ─┐
  └─ tmux window     ─┤  一个仓库  ·  一个 worktree  ·  一个 agent（resume）
       └─ tmux pane  ─┘
                       ↑
       agent hooks → attention.json → tab 徽章 + 右状态计数
                                       ↑
                         Alt+j/k/l  +  Alt+v  （主循环）
                       ↓
       结构化日志 → timeline / habit 投影器  （复盘环）
```

完整架构、所有权边界与 WSL ⇄ Windows 通道：[`docs/architecture.md`](docs/architecture.md)。会话与互通总览（workspace/tab/tmux/worktree/agent/attention ↔ session-bridge ↔ 飞书）：[Session & Interop Overview](docs/architecture.md#session--interop-overview)。

## ✅ 依赖

| | 要求 | 说明 |
|---|---|---|
| **WezTerm** | nightly | `hybrid-wsl` 模式跑在 Windows nightly 上 |
| **tmux** | ≥ 3.7 | DEC sync 需 3.6+；`refresh-from-pane` 需 3.7+。系统/brew 包 ≥ 3.7 优先；仅当发行版过旧（如 Ubuntu apt 3.4）才用用户前缀 `~/.local`。[安装](docs/tmux-install.md) · [原因](docs/ime-flicker-and-sync-output.md) |
| **lua5.4** | 推荐 | 驱动 sync 预检；缺失则跳过预检并警告 |
| **jq** | 推荐 | Agent-attention 写入与焦点路径；缺失则标签降级 |
| **go ≥ 1.21** | 可选 | 仅 `native/picker/` 维护者需要。终端用户经 release fetcher 拿 sha256 钉死的预编译包 |
| **python3** | 可选 | Habit / timeline 投影器；WakaTime 状态 |

支持的运行时模式：`hybrid-wsl`（Windows WezTerm + WSL/tmux）与 `posix-local`（Linux / macOS 本机）。

## 🚀 快速开始

```bash
# 1. 播种本机配置
cp -r wezterm-x/local.example/ wezterm-x/local/
$EDITOR wezterm-x/local/constants.lua   # runtime_mode, default_domain, shell, …
$EDITOR wezterm-x/local/shared.env      # WAKATIME_API_KEY, MANAGED_AGENT_PROFILE, …

# 2. 同步运行时到 $HOME（写入 ~/.wezterm.lua + ~/.wezterm-x/）
skills/wezdeck-runtime-ops/scripts/sync-runtime.sh

# 3. 重载 WezTerm，确认右状态出现
#    attention 计数（helper 起来后还有 CDP·…）——说明 attention / CDP 链路活着。
#    D· / M· 仅在压力下出现。
```

完整安装：[`docs/setup.md`](docs/setup.md)。WSL 主机可选守卫：[`docs/guest-oom.md`](docs/guest-oom.md) · [`docs/host-disk.md`](docs/host-disk.md)。

## 📚 文档

**入门**
- [Setup](docs/setup.md) · [Daily workflow](docs/daily-workflow.md) · [Workspaces](docs/workspaces.md) · [Presentations](docs/presentations/)

**日常使用**
- [Keybindings](docs/keybindings.md) · [tmux UI](docs/tmux-ui.md) · [Agent attention](docs/agent-attention.md) · [Browser debug](docs/browser-debug.md)

**可观测与运维**
- [Diagnostics](docs/diagnostics.md)（latency · [workflow timeline](docs/diagnostics.md#workflow-timeline) · [habit report](docs/diagnostics.md#habit-report)）· [Guest OOM](docs/guest-oom.md)（`M·`）· [Host disk](docs/host-disk.md)（`D·`）· [Logging conventions](docs/logging-conventions.md)

**内部机制**
- [Architecture](docs/architecture.md) · [Performance](docs/performance.md) · [IME & sync output](docs/ime-flicker-and-sync-output.md) · [Dev-env troubleshooting](docs/development-environment-troubleshooting.md)

**发布**
- [Host helper](docs/host-helper-release.md) · [Picker](docs/picker-release.md)

文档地图：[`docs/README.md`](docs/README.md)。Agent 规则：[`AGENTS.md`](AGENTS.md)。可复用用户级 profile：[`agent-profiles/`](agent-profiles/)。英文版：[`README.md`](README.md) — 与本文件保持结构同步（repo-hygiene L0 校验标题层级、相对链接、代码块/表格数量与耐久 token）。

> 专题文档目前以英文为主；叙事向长文（含中文）见 [`docs/presentations/`](docs/presentations/)。

## 🎨 品牌

品牌 SVG 与几何构造说明在 [`assets/brand/`](assets/brand/) — 资源表与比例规则见 [`assets/brand/README.md`](assets/brand/README.md)。

## 📄 许可

MIT © Yuns. 见 [LICENSE](LICENSE)。
