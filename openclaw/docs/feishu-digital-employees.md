# 飞书数字员工接入手册（Dex / Bob / Scout）

避免反复试错。OpenClaw **agent** 与飞书 **应用/机器人** 是两层，必须分别配齐。

## 角色对照

| 对人短名 | agentId | 飞书 accountId | Workspace | 职责 |
| --- | --- | --- | --- | --- |
| **Dex** | `main` | `main` | `~/.openclaw/workspace` | 开发编排 |
| **Bob** | `pm` | `pm` | `~/.openclaw/workspace-pm` | 项目管理 |
| **Scout** | `radar` | `radar` | `~/.openclaw/workspace-radar` | 情报 / RSS |

产品/应用名可仍叫 YunsClaw；开发员工对内称 Dex。总览见 [`digital-employees.md`](./digital-employees.md)。

## 飞书开放平台（每个应用各做一遍）

1. 创建企业自建应用，开通 **机器人**。
2. **事件与回调**
   - 订阅方式：**长连接 / 持久连接（WebSocket）**（与 OpenClaw 默认一致）
   - 事件至少：`im.message.receive_v1`
3. **权限**：收发消息等相关 scope；**发布/可用范围**含机主本人。
4. 复制 **App ID**（`cli_…`）+ **App Secret** → 只写本机 `~/.openclaw/openclaw.json`，**禁止进 git**。
5. 机器人展示名建议：`Bob` / `Scout` / `Dex`（或 YunsClaw）。

## OpenClaw 配置骨架

```json5
{
  channels: {
    feishu: {
      defaultAccount: "main",
      // pairing：未知 open_id 出配对码，避免 allowlist 静默丢消息
      // allowFrom：已确认的机主 open_id（每个飞书应用各一个 ou_）
      dmPolicy: "pairing",
      allowFrom: [
        "ou_…_under_dex_app",
        "ou_…_under_bob_app",
        "ou_…_under_scout_app",
      ],
      accounts: {
        main:  { appId: "cli_…", appSecret: "***", name: "YunsClaw" },
        pm:    { appId: "cli_…", appSecret: "***", name: "Bob" },
        radar: { appId: "cli_…", appSecret: "***", name: "Scout" },
      },
    },
  },
  bindings: [
    { agentId: "pm",    match: { channel: "feishu", accountId: "pm" } },
    { agentId: "radar", match: { channel: "feishu", accountId: "radar" } },
  ],
}
```

### CLI 步骤

```bash
openclaw agents add pm --workspace ~/.openclaw/workspace-pm --model grok-proxy/grok-4.5 --non-interactive
openclaw agents add radar --workspace ~/.openclaw/workspace-radar --model grok-proxy/grok-4.5 --non-interactive
openclaw agents set-identity --agent main --name Dex --emoji "🛠️"
openclaw agents set-identity --agent pm --name Bob --emoji "📋"
openclaw agents set-identity --agent radar --name Scout --emoji "📡"
# 手写 accounts + bindings 后：
openclaw config validate
openclaw agents list --bindings
openclaw channels status --probe
```

异常时：`systemctl --user restart openclaw-gateway`。

## 关键坑：open_id 按应用隔离（必读）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 发了消息完全不回 | `dmPolicy=allowlist` 且 `allowFrom` 只有**别的应用**的 `ou_` | 收录该应用下的 open_id（见下） |
| 日志 `blocked unauthorized sender ou_…` | 同上 | 把该 `ou_` 加入 `allowFrom` |
| 主动发信 `open_id cross app` | 用 A 应用的 `ou_` 从 B 应用发消息 | 必须用 **B 应用** 下的用户 `ou_` |
| 邮箱反查失败 `contact:user.id:readonly` | 应用未开通讯录读权限 | 开权限，或靠首次对话日志拿 open_id |

**同一真人在 Dex / Bob / Scout 下 = 多个不同的 `ou_`，必须都进 `allowFrom`（或 pairing 批准后再写入）。**

### 收录 open_id（标准流程）

1. 用户给该机器人发任意一句。
2. 查日志：
   ```bash
   grep -E 'feishu\[(pm|radar|main)\].*(received|blocked|pairing)' \
     /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -30
   ```
3. 若 `blocked unauthorized sender ou_xxx` → 把 `ou_xxx` 加入 `channels.feishu.allowFrom`。
4. 或运行：
   ```bash
   ./openclaw/scripts/feishu-allowfrom-sync.sh
   ```
5. 若 `dmPolicy=pairing`：
   ```bash
   openclaw pairing list feishu
   openclaw pairing approve feishu <CODE>
   ```

### 主动私信验收

```bash
# 必须：--account 与 target 的 open_id 属于同一飞书应用
openclaw message send --channel feishu --account radar \
  --target ou_…scout… --message "Scout 连通测试"
openclaw message send --channel feishu --account pm \
  --target ou_…bob… --message "Bob 连通测试"
```

## 验收清单

- [ ] `openclaw channels status --probe`：main / pm / radar 均为 connected, works
- [ ] `openclaw agents list --bindings`：pm→feishu:pm，radar→feishu:radar
- [ ] 私聊 Bob → 项目管理助手，不进 Dex 会话
- [ ] 私聊 Scout → 情报助手
- [ ] 私聊 YunsClaw/Dex → 开发助手
- [ ] 日志无持续 `blocked unauthorized`

## 安全

- App Secret 只在本机；曾出现在聊天中则 **轮换 Secret** 并更新配置。
- 个人机推荐 `dmPolicy=pairing` + 维护 `allowFrom`；勿对公网无限制 `open`。
- 永不提交 `openclaw.json` / Secret 到 git。

## 相关

- [`digital-employees.md`](./digital-employees.md) — 三角模型
- [`agent-architecture.md`](./agent-architecture.md)
- 脚本：`openclaw/scripts/feishu-allowfrom-sync.sh`
- 上游：OpenClaw `channels/feishu`、`concepts/multi-agent`
