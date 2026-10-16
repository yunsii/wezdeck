# OpenClaw personal control plane

Versioned templates and agent protocol for a **Feishu → OpenClaw → local machine**
loop. This directory is **not** part of the WezTerm runtime hot path.

**Display name on Feishu (this machine):** **Dex** — set in local
`channels.feishu.accounts.main.name` and in the Feishu Open Platform app/bot
title. Do not put personal branding into shared secrets files.

| Layer | Location | Git |
| --- | --- | --- |
| Templates + protocol (this tree) | `openclaw/` examples, skills, scripts | tracked |
| Live Gateway config + sessions | `~/.openclaw/` | **never** track |
| Host exec approvals | `~/.openclaw/exec-approvals.json` | **never** track |
| Secrets / filled env | `~/.config/shell-env.d/*.env` | **never** track |
| Task ledger Base tokens | `openclaw-tasks.env` (same shell-env.d) | **never** track |
| Optional Grok CLI / lark-cli stores | `~/.grok/`, lark-cli key store | **never** track |
| Task write allowlist (per agent) | `~/.openclaw/tasks-allowlist.json` | **never** track filled local copy; example is tracked |

**Do not commit:** absolute host paths (`/home/<user>/…`), App Secret, API keys,
Gateway tokens, Base tokens, filled `*.env`, live `openclaw.json`, or personal
`open_id` / app id used only on one machine. Tracked files use `$HOME`, env var
**names**, and placeholders only (`cli_xxx`, `ou_…` examples).

WezDeck (tmux / attention / `agent-launcher`) is an **optional** review surface.
OpenClaw may run headless.

### Where to read what

| Audience | Start here | Do not treat as |
| --- | --- | --- |
| **Dex / Main (always-on)** | [`workspace/AGENTS.md`](./workspace/AGENTS.md) + skills it points to | This README’s install chapters |
| **Human operator (install / health)** | **This README** | Always-on constitution |
| **Modes / rails / ACP** | [`docs/development-modes.md`](./docs/development-modes.md) · [`docs/agent-architecture.md`](./docs/agent-architecture.md) | Pasting long mode essays into AGENTS |
| **Policy map / terms** | [`docs/README.md`](./docs/README.md) · [`docs/terminology.md`](./docs/terminology.md) | — |

Rails: H1/H2 + C1/C2/C3；ACP=接入层。Legacy A–E 仅括号别名。  
**wezdeck cwd：** 默认 primary **`master`**；并行/长实验才 `claw-*`。

## Status

Operational when the checks below pass. Values live under `~/.openclaw/` (not in git).

| Area | Baseline |
| --- | --- |
| Package | Linked via `scripts/link-workspace.sh` |
| Gateway | systemd user `openclaw-gateway.service` (`enabled`, `Restart=always`) |
| Linger | `loginctl show-user $USER -p Linger` → `yes` |
| Model | Custom OpenAI-compatible provider for Grok (local only) |
| Feishu | `@openclaw/feishu`, WebSocket, probe `connected` / `works`; DM allowlist; groups allowlist + `requireMention` |
| Host exec | `mode: full`, `ask=off`, `strictInlineEval=false`; agent uses `claw-run` (`skills/exec-risk`) |
| Chrome MCP | `mcp.servers.chrome-devtools` → CDP `127.0.0.1:9222` — setup in `workspace/skills/chrome-devtools/SKILL.md` |
| Task ledger | `scripts/dev-task-ledger.sh` + skill `task-ledger` |
| Memory search | local `llama-cpp` — [`docs/memory-search.md`](./docs/memory-search.md) |
| Secrets | mode `600` env files; never commit filled config |

### Quick health

```bash
loginctl show-user "$USER" -p Linger
systemctl --user is-active openclaw-gateway
openclaw channels status --probe
openclaw exec-policy show
openclaw mcp list && openclaw mcp probe chrome-devtools
curl -sS -m 3 http://127.0.0.1:9222/json/version
openclaw memory status --agent main
openclaw security audit
./openclaw/scripts/smoke-readonly.sh
```

Feishu continuity: do not exit the chat to “fix” connectivity; with DM allowlist,
reconnect does not need pairing. If DMs stop: gateway status + channel probe; keep
WSL/host up. Linger once: `sudo loginctl enable-linger "$USER"`.

## Security (non-negotiable)

- Never commit secrets or live `openclaw.json`. Placeholders / env **names** only.
- Prefer DM **allowlist**; never `dmPolicy: "open"` for a personal bot.
- Groups: allowlist + `requireMention: true` unless intentionally opened.
- OpenClaw and lark-cli may share one Feishu app (shared blast radius).
- If a secret leaks: rotate, purge history if needed, restart Gateway.

### Host guards (local)

| Layer | Setting |
| --- | --- |
| Feishu DM / groups | allowlist (+ `requireMention` for groups) |
| Feishu tools | Prefer off: doc/wiki/drive/perm/bitable |
| Host exec | `full`+`ask=off` **or** allowlist+on-miss; do not mix conflicting fields |
| `strictInlineEval` | Personal Dex: **`false`**; semantic gate = `claw-run` |
| Elevated | `tools.elevated.enabled: false` |
| Gateway | systemd user; loopback + token; Linger=yes |

```bash
openclaw exec-policy show
openclaw approvals get
openclaw channels status --probe
openclaw security audit
# widen carefully:
openclaw approvals allowlist add --agent main /absolute/path/to/bin
```

## Architecture (sketch)

```text
Feishu DM (allowlist)
  → Gateway (systemd user, linger)
      → main (AGENTS + skills) → model provider
      → claw-run → host shell
      → chrome-devtools MCP → CDP :9222
  → Feishu reply
```

Modes / who writes: [`docs/development-modes.md`](./docs/development-modes.md).  
Architecture: [`docs/agent-architecture.md`](./docs/agent-architecture.md).

## Prerequisites

1. WSL; Node **22.22.3+** or **24.15+** (prefer 24).
2. OpenClaw CLI + Gateway.
3. Model auth (official or same OpenAI-compatible proxy as Grok CLI) — local only.
4. Feishu self-built app: App ID/Secret; long connection + `im.message.receive_v1`; published.
5. Optional: `loginctl enable-linger`; WezDeck debug Chrome on CDP `9222`.

## Layout

```text
openclaw/
  README.md                 # this file — operator entry
  docs/                     # knowledge map + deep topics
  workspace/                # linked to ~/.openclaw/workspace (AGENTS + skills)
  config/*.example          # templates only
  scripts/                  # link-workspace, smoke, claw-run, ledger, …
```

## Install (WSL)

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh \
  | bash -s -- --no-onboard

openclaw onboard \
  --non-interactive --accept-risk \
  --mode local --flow quickstart \
  --auth-choice skip \
  --install-daemon --daemon-runtime node \
  --workspace "$HOME/.openclaw/workspace" \
  --skip-bootstrap --skip-channels --skip-skills --skip-search --skip-ui

sudo loginctl enable-linger "$USER"
```

`--skip-bootstrap` preserves a linked repo `workspace/`.

## Link this package into runtime

```bash
./openclaw/scripts/link-workspace.sh
./openclaw/scripts/smoke-readonly.sh
```

Merge ideas from `config/openclaw.json5.example` into **local**
`~/.openclaw/openclaw.json` only. Never overwrite live secrets with the example.

## Model: Grok via existing CLI proxy (optional)

1. Keep key only in local stores (`~/.config/shell-env.d/*.env` mode 600, etc.).
2. In local `openclaw.json`, custom `models.providers.*` + `agents.defaults.model.primary`.
3. `systemctl --user restart openclaw-gateway.service`
4. Smoke:

```bash
openclaw agent --local --agent main --session-key 'agent:main:smoke' \
  --message '只回复两个字：就绪' --thinking off --timeout 120
```

Do **not** paste real `baseUrl` + key into this repository.

## Feishu channel

```bash
openclaw plugins install @openclaw/feishu
install -m 600 openclaw/config/feishu-openclaw.env.example \
  ~/.config/shell-env.d/feishu-openclaw.env
# fill FEISHU_APP_ID / FEISHU_APP_SECRET locally
systemctl --user restart openclaw-gateway.service
openclaw channels status --probe   # expect: Feishu … works
```

Recommended: `dmPolicy=allowlist`, `groupPolicy=allowlist` (empty until needed),
`requireMention=true`, disable unused Feishu tools. Open Platform: long connection
+ `im.message.receive_v1` + published bot.

E2E: `openclaw logs --follow` → DM bot → expect receive → dispatch → replies=1.  
Pairing only if not on allowlist: `openclaw pairing list|approve feishu …`.

Multi-bot / digital employees: [`docs/feishu-digital-employees.md`](./docs/feishu-digital-employees.md).

## Operational checklist

| Item | Done when |
| --- | --- |
| Package linked | `link-workspace.sh` + smoke |
| Gateway + Linger | active/enabled + `Linger=yes` |
| Model | local agent smoke OK |
| Feishu | probe + real DM round-trip |
| Exec | claw-run protocol; policy matches intent |
| Chrome | CDP up + `mcp probe chrome-devtools` |
| Secrets | not in git |

## Task ledger & allowlist

- Ledger CLI/skill: `scripts/dev-task-ledger.sh` · `workspace/skills/task-ledger/SKILL.md`
- Env template: `config/openclaw-tasks.env.example` → `~/.config/shell-env.d/openclaw-tasks.env` (600)
- Write allowlist: `~/.openclaw/tasks-allowlist.json` (example tracked under `config/`)
- Workflow / worktree: [`docs/development-modes.md`](./docs/development-modes.md) · skill `dev-task`

## Chrome DevTools MCP

One-time setup and OOM notes: **`workspace/skills/chrome-devtools/SKILL.md`**.  
Host browser debug: repo [`docs/browser-debug.md`](../docs/browser-debug.md).

## Roadmap / non-goals

Prefer improving **C1/C2/C3** and Ticket-headless over re-enabling D. ACP stays an
access layer (Claude/Codex backends). Details: [`docs/development-modes.md`](./docs/development-modes.md).

Still out of scope as defaults: open DM policy, elevating host exec without
confirm, committing live secrets, treating Feishu as a full Claude TUI.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Probe fails | `openclaw gateway status`; systemd user unit |
| Dead after logout | Linger; WSL still running |
| No inbound DM | long connection + event + published app; correct bot |
| Inbound OK, no reply | `openclaw models status`; proxy/key; local smoke |
| DM ignored | `dmPolicy` / allowlist `open_id` |
| Exec denied | `openclaw approvals get`; claw-run / allowlist |
| Group silent | empty `groupAllowFrom` is intentional |
| Chrome MCP down | CDP `:9222`; skill setup; `openclaw mcp reload` |

Logs: `openclaw logs --follow` or `journalctl --user -u openclaw-gateway.service -f`.

## Docs map

| Doc | Role |
| --- | --- |
| This README | Operator install / health / Feishu / security |
| [`workspace/AGENTS.md`](./workspace/AGENTS.md) | Main always-on L0 |
| [`docs/README.md`](./docs/README.md) | Knowledge map |
| [`docs/development-modes.md`](./docs/development-modes.md) | Who writes code (H/C rails) |
| Skills | `dev-task`, `task-ledger`, `exec-risk`, `chrome-devtools`, … |
| Host profiles | [`agent-profiles/v1`](../agent-profiles/v1/README.md) |
| Upstream | [OpenClaw](https://docs.openclaw.ai) · [Feishu](https://docs.openclaw.ai/channels/feishu) · [ACP](https://docs.openclaw.ai/tools/acp-agents) |
