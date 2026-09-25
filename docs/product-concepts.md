# WezDeck 产品概念

这份文档定义 WezDeck 的产品边界、术语和对外文案。实现、首页、README 和后续功能说明都以这里的概念分层为准。

## 一句话定位

**WezDeck 是一个本地优先的 AI Agent 工作台，也是围绕终端工作的本地控制平面。**

它把 WezTerm、tmux、git worktree、Agent 会话和注意力状态组织在同一个工作流里，让人可以知道每个 Agent 在哪里、是否需要介入，以及如何回到正确的工作上下文。

## 三层结构

| 层 | 正式名称 | 作用 | 主要入口 |
| --- | --- | --- | --- |
| 工作层 | WezDeck AI Agent 工作台 | 管理 workspace、worktree、Agent 会话、恢复和注意力 | WezTerm + tmux |
| 运行层 | WezDeck Runtime | 提供本地主机能力、事件、IME、Chrome/CDP、Rime 统计和 IPC | Windows 本地进程 |
| 观察层 | WezDeck Runtime Console | 在需要浏览器时查看 Runtime 状态和本地指标 | `/console`、`/zh/console` |

Runtime Console 是观察入口，不是 WezDeck 的全部能力。它不能替代键盘优先的本地工作台，也不应在首页上占据产品主叙事。

## 术语选择

| 场景 | 推荐用词 | 说明 |
| --- | --- | --- |
| 中文主分类 | 本地优先的 AI Agent 工作台 | 用户最容易理解，覆盖工作区、Agent 和终端工作流 |
| 中文技术定位 | 本地 AI Agent 控制平面 | 适合架构、开发者文档和技术 SEO |
| 英文品牌隐喻 | AI flight deck | 延续 WezDeck 品牌含义，强调多个 Agent 的工作位置和状态 |
| 英文技术定位 | local-first control plane for AI coding agents | 说明实际能力，不依赖隐喻理解 |
| 浏览器页面 | Runtime Console / 运行时控制台 | 明确它是观察面，不是主工作台 |

“AI 驾驶舱”可以作为中文长文中的比喻，但不作为首页主分类。`deck` 单独不是“驾驶舱”的直译；`flight deck` 才带有航空驾驶舱的语境。中文主文案使用“工作台”，避免把产品误解为监控大屏或云端 Agent 编排平台。

## 能力边界

WezDeck 当前解决的是本地终端里的多 Agent 工作组织问题：

- workspace、tmux window、git worktree 和 Agent pane 的对应关系；
- waiting、running、done 等注意力状态的快速发现；
- Agent 会话恢复和键盘优先的跳转；
- 本地主机能力和 Runtime 信号的统一入口；
- 不依赖云端后端的本地数据和运行时。

WezDeck 当前不是：

- 云端多租户 Agent 编排平台；
- 替代 Claude Code、Codex 等 Agent 的聊天产品；
- 只展示 Runtime 指标的浏览器控制台；
- 自动替用户决定任务拆分、权限或发布策略的自治系统。

## 首页文案基线

英文：

> WezDeck — A local-first control plane for AI coding agents.

辅助隐喻：

> A flight deck for your terminal AI agents.

中文：

> WezDeck：本地优先的 AI Agent 工作台。

技术辅助文案：

> 把 WezTerm、tmux、git worktree 和多个 Agent 会话组织成一个键盘优先的本地控制平面。

Runtime Console 的文案应使用：

> 可选的浏览器伴侣，用来观察本地 Runtime 信号。

不要把 Runtime Console 写成 WezDeck 的同义词。
