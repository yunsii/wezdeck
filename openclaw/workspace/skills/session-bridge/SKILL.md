---
name: session-bridge
description: >
  Host ↔ Claw Session Adapter Kit: list/capture host tmux panes, list/tail
  OpenClaw sessions, poke agent turns, lease-gated host-send-keys, bot-send,
  optional say-as-me, take/watch poller for focused-pane handoff. Use for
  Feishu/host interop — not a second TUI.
---

# Session Adapter Kit（Dex · Main）

入口脚本（仓内）：

```bash
REPO="${WEZDECK_REPO:-$HOME/github/wezterm-config}"
SB="$REPO/openclaw/scripts/session-bridge.sh"
```

规范：`openclaw/docs/session-bridge.md`  
tmux 版本策略：`docs/tmux-install.md`

## 何时用

| 用户意图 | 命令 |
| --- | --- |
| 本机 Claude/Codex 卡在哪 | `$SB host-status` → 必要时 `host-capture --target …` |
| 飞书侧让 agent 跑一轮 | `$SB poke --id dex -m '…'`（先 `--dry-run` 若不确定） |
| 临时点 Continue / 发短文本进 TUI | `lease mint` → `host-send-keys …`（先 dry-run） |
| 权限框点 Yes | `host-capture` 确认 → `host-send-keys --approve-visible` |
| 查 Dex 会话 | `$SB claw-ls` / `claw-show --id dex` |
| 机器人通知 | `$SB bot-send --to dex -m '…'`（默认 dry-run） |
| **本人**飞书说话 | `$SB say-as-me --to dex -m '…'`（P3；默认 dry-run） |
| **饭点接管聚焦 pane** | 快捷键 **Ctrl+K w**；或 `$SB take --focus --confirm-notify` |
| 查/停盯梢 | `$SB watch-status` / `watch-stop --all` |
| 紧急停写 | `$SB panic on` |

`take` 只做轻量轮询 + 飞书通知（需确认 / 会话结束）；**不**代按 TUI、不每 tick 跑模型。  
**仅 agent pane**（kind / 标题启发式 / attention）；普通 shell 直接拒绝，无强开开关。

## 硬规则

1. **身份三分：** `agent-poke` ≠ `bot` ≠ `user`（say-as-me）；汇报里写清。  
2. **读宽写窄：** 写路径 panic 全拒（exit 75）。  
3. **host-send-keys** 需要：有效 lease + `host_allowlist` + 无 panic；禁 C-c/C-z/C-d。  
4. **遥控 ≠ 写码权**（单写者仍成立）。  
5. **tmux client** 必须与 server 匹配（脚本自动 probe；勿硬编 `/usr/bin/tmux` 3.4）。  
6. 密钥/token 不要从 capture 贴回飞书。

## 配置（仓外）

`~/.openclaw/session-bridge.json`：

- `aliases.dex` → session key  
- `host_allowlist.send_keys_panes` → session 名 glob（如 `wezterm_*`）  
- `feishu_targets.dex_user_id` / `*_chat_id` → bot-send / say-as-me  
- `defaults.tmux_bin` / `receipt` / `defaults.watch`（ttl/interval/notify_to）

## 不要

- 不要新建第二 session store  
- 不要默认 `say-as-me --confirm` 无用户明确授权  
- 不要与 live TUI **并行改同一 cwd 代码**
