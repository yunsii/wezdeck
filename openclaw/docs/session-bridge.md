# Session Adapter Kit（session-bridge）

> **窄适配器**，不是双向会话同步平台 / 第二套 TUI。  
> CLI 名：`openclaw/scripts/session-bridge.sh` · 概念名：**Session Adapter Kit**

## 0. 目标与非目标

### 目标（Must）

1. **Claw → Host：** 列表/截取 host 会话状态（tmux 视图）；P2 才在 lease 下做临时遥控。
2. **Host → Claw：** 标准读 Claw 会话卡片 + 轨迹摘要；**poke** 注入 agent turn。
3. **身份三分：** `bot` / `user`（lark 本人）/ `agent-poke`（OpenClaw session 注入）永不混用。
4. **读宽写窄 + panic 一键冻结写路径。**

### 非目标（Must not）

- 不新建会话事实库 / 不做 CRDT / 不做第二 runtime
- 不把飞书做成第二块完整 TUI
- 不静默 `say-as-me`（P3 可选）
- 遥控 ≠ 获得写码权（单写者仍成立）

## 1. 架构

```text
L3 场景 / Skill / 人话命令
        │
L2 session-bridge CLI  ← SessionCard · panic · audit
        │
   ┌────┴────┐
   ▼         ▼
Host view   Claw truth
tmux JSON   openclaw sessions* + jsonl
```

| 平面 | 真相源 | 适配器角色 |
| --- | --- | --- |
| Claw 会话 | `openclaw sessions*` + `~/.openclaw/agents/*/sessions/` | 投影 SessionCard |
| Host 会话 | tmux（可选 attention） | **视图**；可 degraded |
| 飞书 | 飞书本身 | bot / user 出口（P2/P3） |

## 2. 身份三分

| 身份 | 命令 | 何时用 |
| --- | --- | --- |
| **agent-poke** | `poke` → `openclaw agent --session-key …` | 本机/脚本让 agent 跑一轮 |
| **bot** | `bot-send`（P2）→ `openclaw message send` | 机器人通知 |
| **user** | `say-as-me`（P3）→ `lark-cli im` | 你本人飞书账号 |

P0–P1：**agent-poke** + panic。P2：+ **lease / host-send-keys / bot-send**。P3：+ **say-as-me**。

## 3. CLI（P0–P3 已实现）

入口：

```bash
./openclaw/scripts/session-bridge.sh [--json|--text] <cmd> …
```

| 命令 | 读/写 | 说明 |
| --- | --- | --- |
| `host-ls` / `host-status` | 读 | tmux panes → SessionCard[]；tmux 挂了则 `degraded` |
| `host-capture --target …` | 读 | 默认 tail N 行（`defaults.capture_lines`） |
| `claw-ls [--active M]` | 读 | wrap `openclaw sessions --all-agents` |
| `claw-show --id\|--alias` | 读 | 卡片 + 短轨迹摘要 |
| `claw-tail --id …` | 读 | wrap `sessions tail` |
| `poke --id … -m … [--dry-run]` | **写** | identity=`agent-poke`；panic 时 exit 75 |
| `lease mint\|status\|revoke` | 元写/读 | TTL 遥控授权；落盘 `~/.openclaw/state/session-bridge-leases/` |
| `host-send-keys --target …` | **写** | 需 **lease + allowlist + 无 panic**；可 `--dry-run` / `--approve-visible` |
| `bot-send --to … -m …` | **写** | identity=`bot`；**默认 dry-run**，`--confirm` 才真发 |
| `say-as-me --to … -m …` | **写** | identity=`user`（lark-cli）；**默认 dry-run**；`--confirm` / 可选 `--interactive` |
| `take [--focus\|--target …]` | 元写 | 接管聚焦/指定 pane：写 watch job + 启 poller；可选 ack 通知 |
| `watch-status` / `watch-stop` | 读/元写 | 查看/停止盯梢 job |
| `watch-loop` | 内部 | 轻量 poller（flock）；**无 LLM**；仅 `waiting`/`ended` 通知 |
| `panic on\|off\|status` | 元写 | `~/.openclaw/state/session-bridge.panic` |
| `audit tail` | 读 | `~/.openclaw/logs/session-bridge-audit.jsonl` |

### take / 盯梢（饭点收尾）

**快捷键：** tmux chord **Ctrl+K w**（任意聚焦 pane）→ `scripts/runtime/session-bridge-take.sh`。

```bash
# 聚焦 pane（在 tmux 内）或最前台 client
./openclaw/scripts/session-bridge.sh take --focus --confirm-notify
# 指定
./openclaw/scripts/session-bridge.sh take --target 'sess:0.1' --note '去吃饭' --confirm-notify
./openclaw/scripts/session-bridge.sh watch-status
./openclaw/scripts/session-bridge.sh watch-stop --all
```

| 项 | 行为 |
| --- | --- |
| poller | 本机 bash + flock；读 attention.json / pane 存活 / 权限锚点 |
| 通知方向 | **默认 `user+poke`**：你（say-as-me）→ Dex 飞书会话 **+** poke 注入 Dex session，让 Main 跑一轮。**不是** bot→主人（旧路径看起来像 Dex 主动找你，且易被当成飞书菜单）。配置：`defaults.watch.notify_identity`=`user`\|`poke`\|`user+poke`\|`bot` |
| 通知时机 | **仅跃迁** take_ack / `→waiting`（need_human）/ `→done`·TTL；不每 tick 跑模型 |
| say-as-me 条件 | 需 `feishu_targets.dex_chat_id`（与 Dex bot 的 p2p chat）。只有 `dex_user_id` 不够（那是主人 open_id，发了也不进 Dex 会话） |
| waiting 判定 | attention.json → 否则 capture 底栏匹配 **watch 专用锚点**（权限 y/N **与** Claude 选择题 footer：`Enter to select` / `Esc to cancel` 等）。**不用** approve-visible 窄锚点（避免选择题被当 y/N 自动键）。take 时 `last_status=init`，已在等待的 pane 首 tick 也会发 `need_human`。 |
| need_human 文案 | `format-need-human.py` 从 capture（~80 行）抽出题目/选项/当前选中 `▶`，排成可读多行；**禁止**只 tail 底栏半截原文。 |
| job 目录 | `~/.openclaw/state/session-bridge-watch/` |
| WezTerm 徽章 | poller 每 tick 写 `%LOCALAPPDATA%/wezterm-runtime/state/session-bridge-watch/status.json`；right-status 在 **CDP 与 attention 之间** 显示 `SB·-`（未跑）/ `SB·N`（N=job 数）；waiting>0 时用 waiting 色 |
| Alt+/ 列表 | `tmux-attention-menu.sh` 追加 `session-bridge-watch-picker-rows.sh` 行（status=`sb`，徽章 📡）；**Enter** 跳 pane；**Ctrl+X** = `watch-stop --id` **软停**（`active=false`，job 文件保留审计；列表不再显示；**不**动 agent-attention）。普通 `x` 仍可搜索。Tab 可筛 `[📡 SB watch]`。硬删：`SB_WATCH_PURGE=1 watch-stop` |
| 默认 TTL | `defaults.watch.ttl_sec`（样例 5400s） |
| 遥控写键 | **不做**（take ≠ host-send-keys） |
| 非 agent | **拒绝**（不启 poller）；仅 Claude/Codex/Grok 等 agent 会话 |
| agent 判定（优先级） | **① pane 前台进程**（tty 上 STAT 含 `+` 的 comm/argv0）→ **② pane_pid 后代树** → ③ `pane_current_command` 名 → ④ live `attention.json`。**不用标题**（任务名噪声大）。不信任单独的 `cmd=sh`（常见 `sh -c claude`）。 |

`host-status` 会尝试读取 WezDeck `attention.json`，把 `waiting|running|done` 填进 `inferred.attention`（无文件则 `unknown`）。
`host-send-keys` 成功后默认 **audit 回执**；`defaults.receipt.mode=bot_announce` 且 `SB_RECEIPT_CONFIRM=1` 才 bot 播报。

### SessionCard（投影）

```json
{
  "side": "host|claw",
  "id": "tmux:sess:win.pane | agent:main:feishu:direct:…",
  "alias": "dex|null",
  "kind": "claude-tui|main-grok|…",
  "status": "running|waiting|done|idle|unknown",
  "cwd": "/abs|null",
  "preview": "…",
  "control": { "read": true, "write": "deny|ask" }
}
```

## 4. 配置（仓外）

样例：`openclaw/config/session-bridge.json.example`  
本地：`~/.openclaw/session-bridge.json`

```json
{
  "aliases": {
    "dex": "agent:main:feishu:direct:ou_…"
  },
  "host_allowlist": {
    "send_keys_panes": ["wd:*"]
  },
  "defaults": {
    "capture_lines": 40,
    "lease_ttl_sec": 120,
    "panic_path": "~/.openclaw/state/session-bridge.panic"
  }
}
```

`host_allowlist.send_keys_panes`：按 **tmux session 名** glob；**空或不配 = 全拒** host-send-keys。

## 5. 菜谱（examples）

```bash
./openclaw/examples/session-bridge/01-host-status.sh
./openclaw/examples/session-bridge/02-claw-ls.sh
SB_POKE_TARGET='agent:main:feishu:direct:…' \
  ./openclaw/examples/session-bridge/03-poke-dry-run.sh
SB_HOST_TARGET='demo:0.0' \
  ./openclaw/examples/session-bridge/04-lease-and-nudge.sh
```

### 遥控最小链（P2）

```bash
# 1) 配置 allowlist 含目标 session 名
# 2) 发 lease
./openclaw/scripts/session-bridge.sh lease mint --target 'mysess:0.0' --ttl 120 --max-sends 3
# 3) 先 dry-run
./openclaw/scripts/session-bridge.sh host-send-keys --target 'mysess:0.0' \
  --text '请继续' --enter --dry-run
# 4) 真发（tmux 可用时）去掉 --dry-run
# 权限框：
./openclaw/scripts/session-bridge.sh host-send-keys --target 'mysess:0.0' \
  --approve-visible --dry-run
```

## 6. 安全

| 动作 | 默认 |
| --- | --- |
| host/claw 读 | allow |
| poke | 允许（本机）；**panic 全拒**；推荐先 `--dry-run` |
| lease mint | 写；panic 全拒 |
| host-send-keys | **deny** 除非 lease + allowlist + 无 panic；禁 C-c/C-z/C-d |
| bot-send | dry-run 默认；`--confirm` 才发 |
| say-as-me | **P3** |

- Audit 每条写：`ts, action, identity, target, preview≤80, text_hash, result`
- Panic **不**自动 re-arm
- Lease 默认 TTL 120s、`max_sends` 3；用尽自动删
- `--approve-visible`：capture 须含确认锚点，否则拒绝
- capture 可能含秘密：默认截断；禁止把 token 贴回飞书

### tmux 侧载二进制（事故洞）

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `server exited unexpectedly`，但 `ps` 里 server 还在 | **client/server 二进制不一致**（常见：server=`~/.local/bin/tmux` 3.7b，client=`/usr/bin/tmux` 3.4） | session-bridge 自动 probe 可用 client；或设 `defaults.tmux_bin` / `SB_TMUX_BIN` |
| `host-status` `degraded` | 全部候选都连不上 socket | 查 `/tmp/tmux-$(id -u)/default` 与 `ps` |

```bash
# 手工验证
/usr/bin/tmux -V                    # 常为 3.4
~/.local/bin/tmux -V                # WezDeck 常用 3.7b
~/.local/bin/tmux list-sessions     # 应成功
/usr/bin/tmux list-sessions         # 错配时失败
```


**不要** `apt remove tmux`：会连带卸掉 `ubuntu-wsl`、`byobu`。

**推荐策略（当前）：**

| 层 | 策略 |
| --- | --- |
| 系统 | **保留** apt `/usr/bin/tmux`（满足依赖）；不 divert、不覆盖 |
| 用户 | **唯一入口** `~/.local/bin/tmux`（WezDeck 3.7b）+ PATH 优先 |
| 禁止 | 在 `~/.cargo/bin`、`~/bin` 等处再 ln 多份 shim |

```bash
# PATH：~/.config/shell-env.d/00-tmux-bin.env 与 ~/.zshenv
command -v tmux   # 期望：.../.local/bin/tmux
tmux -V           # 期望：3.7b

# OpenClaw session-bridge 会自动 probe 与 server 匹配的 client
./openclaw/scripts/session-bridge.sh host-status
```

系统路径硬编码且无法改 PATH 时，才考虑可选 `FORCE_SYSTEM=1 ~/.local/bin/tmux-unify-system.sh`（默认不推荐）。

## 7. 分期

| 期 | 内容 | 状态 |
| --- | --- | --- |
| **P0** | 本文档 + examples + config 样例 | ✅ |
| **P1** | 只读 CLI + poke + panic + audit | ✅ |
| **P2** | lease + host-send-keys + bot-send；attention 推断；audit 回执 | ✅ |
| **P3** | say-as-me（lark-cli user） | ✅ |
| **Skill** | `openclaw/workspace/skills/session-bridge/SKILL.md` | ✅ |

## 8. 单写者提醒

`poke` / `host-send-keys` **只推交互**，不授予并行改同一 cwd 的写码权。C2 handoff 时 Main 仍须停笔。

## 9. 相关

- 交互面：[`agent-interaction.md`](./agent-interaction.md)
- 架构：[`agent-architecture.md`](./agent-architecture.md)
- 飞书数字员工：[`feishu-digital-employees.md`](./feishu-digital-employees.md)
