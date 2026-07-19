# 错误闭环：覆盖范围与 OpenClaw 平台边界

本文固化 **Main（Dex）侧错误闭环** 与 **OpenClaw Gateway/通道层** 的分工，
避免把「agent 纪律」误当成「能消灭所有飞书尾部报错」。

相关：

- 纪律入口：`workspace/AGENTS.md` L0-5
- 操作 skill：`workspace/skills/error-closed-loop/SKILL.md`
- 官方 run 循环：本机 OpenClaw 包 `docs/concepts/agent-loop.md`
- 交互总览：[`agent-interaction.md`](./agent-interaction.md)

---

## 1. 结论（先读）

| 说法 | 对不对 |
| --- | --- |
| 已做的错误闭环 **有意义** | **对** — 覆盖 **同轮、agent 可见** 的失败 |
| 能消灭 **所有** 飞书/通道尾部报错 | **不对** — 部分是 Gateway **硬拼 / 投递后** 事件，**默认不再调 Main** |
| 要产品级「失败必解释」 | 需改 **OpenClaw**（失败注入再跑一轮 / 改 fallback），不是只改 prompt |

**一句话：**  
错误闭环 = **agent 责任面** 的彻底；  
OpenClaw 特殊场景 = **平台责任面**，闭环 **覆盖不了**，须分轨记录与排障。

---

## 2. 错误闭环 **覆盖** 什么（仍必须做）

这些失败会以 **toolResult（常含 `isError`）** 回到 **当前 agent run**，
模型 **可以且必须** 在同轮或紧随的 assistant 正文里闭环：

| 场景 | 例子 |
| --- | --- |
| Shell/exec 非零、批失败 | `🛠️ Exec failed: A → B → …`、SIGTERM 批杀 |
| 工具可读错误 | 路径不存在、权限、ETXTBSY、429（可退避） |
| 自愈后验收 | 重跑检查；`re-run pass (after …)` |
| 写任务结果 | 「失败记录」含已自愈项；阻塞检查不得假绿 |

**强制用户可见模板**（见 skill）：

```text
失败：…
原因：…
处置：已自愈 | 重试中 | 无法自愈
影响：阻塞与否；结论是否仍成立
结果/备选：…
```

**禁止：** 只甩未解码的平台箭头列表 / 裸 stderr 当最终回复。

---

## 3. 错误闭环 **覆盖不了** 什么（OpenClaw 特殊场景）

依据 OpenClaw **agent-loop / hooks / delivery** 设计（非猜测）：

| 场景 | 发生什么 | 为何闭环接不住 |
| --- | --- | --- |
| **A. Fallback 错误句** | 整轮 **无可用正文** 且发生过工具错 → runtime **自动** 发 fallback 错误 payload | 这是 **Gateway 生成** 的终态回复，**不会**再开一轮让 Main 写中文闭环 |
| **B. 模型/流式固定错误** | 如 AI service error 固定英文句、`Something went wrong…` | 系统 `isError` payload，非 agent 自由文本 |
| **C. 投递失败 / partial** | final 已生成但通道 `deliveryStatus=failed|partial` | `message_sent` **仅观察**；**不**自动再跑 agent 解释 |
| **D. 会话/轨迹截断** | 如 trajectory data 数组上限（实现侧 `trajectory-array-size-limit`，数组项上限 64）等 | 诊断/轨迹被裁；**不保证**用户侧完整解释 |
| **E. Run 已 end 后的生命周期 error** | timeout / abort / gateway 打断（少数有 resume 注入，非常规） | 多数情况下 **没有**「失败→强制中文闭环」的通用钩子 |

| 场景 | 人侧观感 | 正确归因 |
| --- | --- | --- |
| 正文已成功，气泡尾部仍像报错 | 「硬拼的消息」 | 常为 **B/C** 或通道 UI 对 `isError`/trace 的展示 |
| 只有英文模板、没有失败/原因/处置 | Main「没接管」 | **A/B**：runtime 终态，**不是** Main 偷懒漏写（若同轮 tool 失败且仍有输出机会却不写，才是 agent 违规） |

---

## 4. 责任面划分

```text
                    ┌─────────────────────────────┐
                    │  Agent 责任面（错误闭环）      │
                    │  同轮 toolResult / 可续写正文  │
                    │  → skill + L0 强制解释与自愈  │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │  Platform 责任面（OpenClaw）   │
                    │  fallback 句 / 投递 / 截断    │
                    │  → 默认不再调 Main            │
                    │  → 产品改造才算「彻底」        │
                    └─────────────────────────────┘
```

| 面 | 谁改 | 目标 |
| --- | --- | --- |
| Agent | wezdeck skills / AGENTS / 执行纪律 | 凡 **可见且可写** 的失败必闭环 |
| Platform | openclaw/openclaw Gateway / 通道 | 失败强制二次回合、中文 fallback、delivery 回调 |

---

## 5. 排障时怎么判断

1. 会话里是否有 **toolResult `isError`** 且之后 **还有 assistant 正文**？  
   - 有正文却无闭环 → **agent 违规**（补闭环）。  
   - 无正文只有固定英文/模板 → **A/B 平台 fallback**。  
2. 业务已做完、用户说「结尾报错」→ 查 **投递 partial/failed** 与 **chunk**（飞书 `textChunkLimit` 等），属 **C**。  
3. 超长多工具回合 → 考虑 **D**；拆回合，勿指望单回合无限轨迹。

---

## 6. 与「落实错误闭环」工作的关系

| 已做 | 价值 |
| --- | --- |
| L0-5 + error-closed-loop skill | **同轮 agent 面** 有明确验收标准 |
| 禁止裸 Exec failed 列表 | 用户可读性、可自愈 |
| 结果模板「失败记录」 | 写任务诚实验收 |

| 未做（有意边界） | 说明 |
| --- | --- |
| 改写 OpenClaw fallback / delivery 回调 | 属上游；本文只 **记账边界** |
| 保证飞书永不出现尾部系统错误条 | **做不到** 仅靠 agent 纪律 |

**因此：之前的错误处理仍然正确且必要；只是不能覆盖 OpenClaw 平台特殊场景。**  
两者叠加：agent 面尽量干净，平台面单独升级。

---

## 7. 维护

- 改 L0 错误纪律时：同步本文件「覆盖/不覆盖」表。  
- 若上游 OpenClaw 增加「失败强制再跑一轮」，更新 §3 并收紧 agent 期望。
