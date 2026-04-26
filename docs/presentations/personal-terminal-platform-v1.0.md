---
title: WezDeck v1.0 — 一个前端第一次做平台工程的三天
subtitle: 关于 C# / IPC / Windows exe 交付 / 长驻进程 / 多语言收口 / 和 AI 一起做这些
version: v1.0
date: 2026-04-19
project: WezDeck (repo: wezterm-config)
audience: 同行前端 · personal reflection · 8 分钟
author: AI 生成初稿，人工微调
---

# WezDeck v1.0 — 一个前端第一次做平台工程的三天

> *本篇是 personal reflection，不是技术文档。*
> *想看 WezDeck 现在长什么样、5 大特性是什么 → [`ai-workspace-sharing-outline.md`](./ai-workspace-sharing-outline.md)（10 分钟）*
> *想看 v0 → v5 完整演进 + 一天日常切面 → [`ai-dev-environment-evolution.md`](./ai-dev-environment-evolution.md)（30 分钟）*

## 三天

`2026-04-17` 到 `2026-04-19`。三天里，WezDeck 从一堆"勉强跑得起来的 WezTerm 配置脚本"变成了 v1.0 ——这是它第一次开始像一个有主干的系统。

但这篇不想讲架构（[outline](./ai-workspace-sharing-outline.md) 和 [evolution](./ai-dev-environment-evolution.md) 已经讲过了）。这篇想讲的是**对一个前端来说**，这三天里第一次真正碰到的一些东西。

---

## 第一次真做 `C# + IPC`

之前对 IPC 的理解大概是：

> "进程间通信，常见实现有命名管道、unix socket、共享内存…"

—— 知道概念，没碰过。

这次是把它**做进了一条运行中的控制链路**。Windows 侧有一个长驻 `helper-manager.exe`（C#），WSL 侧每次按 `Alt+v` / `Alt+b` / `Ctrl+v` 都通过 `helperctl.exe` 发请求过去，名命管道（`\\.\pipe\wezterm-host-helper-v1`）做传输，typed envelope 回来。

碰上才发现的事情：

- **"长驻"不是写个 `while(true)` 就完事**。要处理服务自启 / 崩溃恢复 / 健康心跳 / 同时多个客户端 / STA 线程对剪贴板这种"进程上下文敏感"操作的隔离 —— 这一堆全要自己想。
- **协议设计是个真问题**，不是发个 JSON 就行。要决定：什么 op 用 sync 调 / 什么 op 用 fire-and-forget；envelope 里塞不塞 trace_id（最后塞了 —— 没 trace_id 跨进程 debug 直接歇菜）；版本号怎么放（最后放在 named pipe 名字里 `…-v1`，将来好平滑 cut over）。
- **错误模式比 happy path 多**：管道没起来、helper 还在重启、helper 卡住了不响应、客户端发到一半挂了、helper 收到一半挂了 —— 每一种都要有可观测的失败签名。

最后回头看，**IPC 不是技术，是控制面的语法**。你怎么定义这套语法，就怎么决定平台未来能怎么长。

---

## 第一次做 Windows `exe` 的交付链路

更没碰过的是"把一个 C# 项目变成可分发的 `exe`"。这次要解决的不是构建命令，而是：

- 本地有 dotnet → publish self-contained exe，sync 时直接拷到 `%LOCALAPPDATA%\wezterm-runtime\bin\`
- 本地没 dotnet（很常见）→ **release fallback**：从 GitHub Release 拉版本钉死的 zip，校验 SHA-256，再装
- 升级路径要不破坏现有 helper 进程：先停旧的、释放管道、再装新的、再起
- 有 install state 文件记录"现在装的是哪个版本 / 装在哪 / 哪一步成功了"

碰上才理解的事：

- **release fallback 不是 nice-to-have，是默认路径**。开源/团队场景下绝大多数用户机器没装 dotnet SDK；如果不做 fallback 这套东西就只是"作者本机能跑"。
- **版本必须钉死**：`release-manifest.json` 里写明 tag + SHA-256；helper 升级是有 commit / PR 流程的，不能像脚本一样"git pull 即刻生效"。
- **签名 / SmartScreen 是另一坨问题**（这次没解决，留作后话）—— Windows 给"未签名 exe"的体验对外发布会是个真问题。

第一次理解了"软件交付"和"功能开发"完全是两件事。**把一个能跑的东西变成一个能装的东西，工作量经常和实现本身一样大。**

---

## 第一次面对"多语言架构怎么收口"

WezDeck 的 v1.0 同时活着这些：

- Lua（WezTerm 配置 + 运行时逻辑）
- bash + Go（运行时脚本 / popup pickers）
- PowerShell（Windows 安装 / 兼容路径）
- C#（native helper）
- 加上 docs / agent profile / manifest 这些"contract 层"

难的不是"语言多"。难的是**每一层该放什么、边界要怎么收**：

- 什么逻辑留在 Lua 层 —— 答：所有"按了键之后立刻要做的 UI 反应"，因为那必须 in-process。
- 什么走 bash —— 答：所有"shell-shaped"的工作（管道、流式 IO、和 git/tmux 直接对话），不要在 Lua 里硬写。
- 什么走 PowerShell —— 答：装 helper 这一类**Windows 一次性 bootstrap** 动作；其它别。
- 什么必须收敛到长驻 C# helper —— 答：所有"调用方是多个 + 每次调用启动开销不能接受 + 需要进程级状态"的操作（剪贴板、Chrome reuse、VS Code window cache）。
- 什么进入 contract 层 —— 答：跨语言的稳定调用面（`agent-tools.env` 发现契约、`worktree-task.env` 配置契约、`commands/manifest.json` 命令契约）。

**这一层一层的"什么放哪"，就是平台和脚本堆的差别**。脚本堆是"哪写哪都行、能跑就行"；平台是"每个东西在它该在的层、跨层边界明确、超出边界就重写而不是凑合"。

这条理解在前端日常工作里其实接触不太到 —— 前端的"层"通常都已经被框架预先定义好了（component / store / route / API client）。这次是从零开始**自己定层**，每一层放什么是"我说了算"，但正因为我说了算，每条边界都得自己扛后果。

---

## 第一次和 AI 真正一起"做平台"

之前用 AI 是"它写代码我看 → 接受/拒绝"。这次是"我们一起做一个系统"，循环长这样：

```
我提目标
  → AI 快速实现 / 给结构方案
  → 我纠偏：方向对不对 / 交互够不够自然 / 结构够不够优雅 / 验证够不够真
  → AI 改、跑真实链路回归
  → 我再看是不是真"系统级正确"
  → 收口、refactor、写 docs
```

每一步都很重要，缺哪步都不行：

- **缺第 1 步（明确目标）**：AI 会给一个"看起来不错"的方案，但解决的是它**猜**你想解决的问题。
- **缺第 2 步（AI 实现）**：你自己搞，速度退回 v0 之前。
- **缺第 3 步（人纠偏）**：AI 给你一个 happy-path 实现，没考虑你这套场景的边界（hybrid-wsl / 多 agent 并行 / IME 叠加 sync output / 跨 FS 读延迟）。
- **缺第 4 步（真实链路回归）**：mock 测试通过、真按下 `Alt+/` 不响应。
- **缺第 5 步（系统级回看）**：每个 commit 都对、整体有 N 处冗余 / 概念漂移。
- **缺第 6 步（收口）**：能跑但下一次想加东西要重新理解一遍代码。

最有用的发现是**第 3 步和第 5 步是人的不可替代价值**。AI 在每条具体路径上都比我快，但**它不知道哪条路径不该走**，也不知道**整套系统什么时候开始概念漂移**。这两个判断，至少 2026 年的 Claude / Codex 还做不到。

WezDeck 之所以走得到现在的形态，最核心的原因就是这六步没断过 —— 每次想偷懒（"先这样吧后面再说"），都会在两周内变成必须重写的债。

---

## 这三天对我个人的意义

作为一个前端，平时碰到的是：JSX / TS 类型 / 状态管理 / 浏览器 API / npm 生态 / CI 配置。这次第一次真正做深的几件事，每一件都在前端日常的边界之外：

| 之前 | 这三天之后 |
|---|---|
| "IPC 是个概念" | "IPC 是控制面的语法，会决定平台未来怎么长" |
| "exe 就是个可执行文件" | "exe 交付有制品 / 安装 / 升级 / 回退一整套语义" |
| "long-lived process 是后端的事" | "我自己写过一个，知道它的健康检查、崩溃恢复、状态文件怎么设计" |
| "多语言 = polyglot, sounds nice" | "多语言要靠'每一层放什么'的边界设计才不会变成乱炖" |
| "AI 帮我写代码" | "AI 是协作对象 —— 我提目标 + 纠偏 + 抬标准，它出实现 + 跑回归" |

这些理解不是看资料能拿到的。**必须自己把系统搭起来、踩坑、推翻、重做、再验证**。三天里大概有过四五次"这个方向不对要回退"的瞬间，每次都是真的把刚写完的东西删掉重来。最后剩下的东西不是"AI 写的"，是"AI 写的、我推翻过、又重写过、最后留下来的"。

---

## 一句话结尾

> v1.0 这三天对 WezDeck 是平台主干第一次成型。
> 对我自己，是**第一次以一个 builder 的身份和系统问题较劲，而不是以一个使用者的身份消费别人解决好的抽象**。
>
> 这件事在 AI 协作时代变得意外地可行 —— 一个前端可以在三天内做完一个 C# IPC + Windows exe 交付 + 多语言架构收口的项目。
> 但有一个前提：**你得知道哪些步骤是 AI 替不了的**。
