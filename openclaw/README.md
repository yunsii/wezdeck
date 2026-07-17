# OpenClaw personal control plane (MVP)

Versioned templates and agent protocol for a **Feishu → OpenClaw → local machine**
loop. This directory is **not** part of the WezTerm runtime hot path.

| Layer | Location | Git |
| --- | --- | --- |
| Templates + protocol (this tree) | `openclaw/` examples, skills, scripts | tracked |
| Live Gateway config + sessions | `~/.openclaw/` | **never** track |
| Host exec approvals | `~/.openclaw/exec-approvals.json` | **never** track |
| Secrets / filled env | `~/.config/shell-env.d/*.env` | **never** track |
| Task ledger Base tokens | `openclaw-tasks.env` (same shell-env.d) | **never** track |
| Optional Grok CLI / lark-cli stores | `~/.grok/`, lark-cli key store | **never** track |
| Machine path overrides | `OPENCLAW_TASKS_ALLOWED_ROOTS` in local env | **never** track |

**Do not commit:** absolute host paths (`/home/<user>/…`), App Secret, API keys,
Gateway tokens, Base tokens, filled `*.env`, live `openclaw.json`, or personal
`open_id` / app id used only on one machine. Tracked files use `$HOME`, env var
**names**, and placeholders only (`cli_xxx`, `ou_…` examples).

WezDeck (this repo's tmux / attention / `agent-launcher`) stays the **optional
review surface**. OpenClaw may run headless; open a pane only when you want to
watch or take over.

Protocol detail: [`workspace/AGENTS.md`](./workspace/AGENTS.md).

## Status (MVP)

Personal control-plane MVP is **operational** when the checks below pass on
the machine. Values below describe the **intended** baseline; they live under
`~/.openclaw/` and are not stored in git.

| Area | Baseline |
| --- | --- |
| Package | This tree linked via `scripts/link-workspace.sh` |
| Gateway | systemd user `openclaw-gateway.service` (`enabled`, `Restart=always`) |
| Linger | `loginctl show-user $USER -p Linger` → `yes` (user services survive logout) |
| Model | Custom OpenAI-compatible provider for Grok (same idea as Grok CLI proxy); local only |
| Feishu channel | `@openclaw/feishu`, WebSocket, probe `connected` / `works` |
| Feishu DM | `dmPolicy: allowlist` (owner only); no re-pairing on reconnect |
| Feishu groups | `groupPolicy: allowlist` (empty = all groups off) + `requireMention: true` |
| Feishu tools | Prefer off: `doc` / `wiki` / `drive` / `perm` / `bitable`; keep `chat` / `scopes` if needed |
| Host exec | `tools.exec.mode: auto` + host file `allowlist` / `on-miss` / `askFallback: deny` |
| Elevated | `tools.elevated.enabled: false` |
| Task ledger | Feishu Base via `scripts/dev-task-ledger.sh` + skill `task-ledger` |
| Dev allowlist | **coco-forge only** — roots from local env or `$HOME/work/…` defaults (no host user path in git) |
| Secrets | mode `600` env files; never commit filled config |

### Quick health

```bash
loginctl show-user "$USER" -p Linger          # expect Linger=yes
systemctl --user is-active openclaw-gateway   # active
openclaw channels status --probe              # Feishu … works
openclaw exec-policy show
openclaw security audit                       # prefer 0 critical
./openclaw/scripts/smoke-readonly.sh
```

### Feishu continuity (no exit-and-retry)

- Gateway holds the long connection; **do not** exit the Feishu chat to “fix”
  connectivity.
- With DM **allowlist**, reconnect does **not** require pairing again.
- If DMs stop: `systemctl --user status openclaw-gateway` and
  `openclaw channels status --probe`. WSL/host must still be running.

Enable linger once (already done on the primary machine if `Linger=yes`):

```bash
sudo loginctl enable-linger "$USER"
```

## Security (non-negotiable)

- **Do not commit** App Secret, API keys, Gateway tokens, pairing codes, or
  filled `openclaw.json` from a live machine.
- Tracked files may only contain **placeholders** (`cli_xxx`, env var names,
  commented examples). Prefer `mode 600` for any local secret file.
- OpenClaw and **lark-cli may share one Feishu self-built app** (same App ID /
  Secret). That is fine for personal use: CLI ≈ user OAuth, OpenClaw channel ≈
  bot WebSocket. Shared app ⇒ shared scopes, rate limits, and blast radius if
  the secret leaks.
- Prefer DM **allowlist** or **pairing**; never `dmPolicy: "open"` for a
  personal bot.
- Group: **allowlist** + `requireMention: true` unless you intentionally open
  it.

If a secret is ever committed: rotate App Secret / API key immediately, purge
history if needed, and restart the Gateway.

### Host guards (local runtime)

| Layer | Setting |
| --- | --- |
| Feishu DM | `allowlist` + owner `open_id` only |
| Feishu groups | `allowlist` (empty list = no groups) + `requireMention` |
| Feishu tools | Disable `doc` / `wiki` / `drive` / `perm` / `bitable` unless needed |
| Host exec | `tools.exec.mode: auto` (do **not** also set `tools.exec.security` / `ask` — OpenClaw rejects the combination) |
| Host approvals file | `security=allowlist`, `ask=on-miss`, `askFallback=deny`, `autoAllowSkills=false` |
| Allowlist entries | Explicit binaries (git, common Unix tools, node/npm under known paths, …) |
| Elevated | `tools.elevated.enabled: false` |
| Gateway | systemd user unit; loopback bind + token auth |
| Linger | `yes` so logout does not kill the Feishu long-connect |

```bash
# inspect (never paste secrets into chat/git)
openclaw exec-policy show
openclaw approvals get
openclaw channels status --probe
openclaw security audit
```

Widen carefully when a needed binary is denied:

```bash
openclaw approvals allowlist add --agent main /absolute/path/to/bin
systemctl --user restart openclaw-gateway.service   # if policy not hot-reloaded
```

## Architecture (personal)

```text
Feishu DM (allowlisted user)
  → OpenClaw Gateway (WSL systemd user service, loopback; linger preferred)
      → main agent (workspace AGENTS.md + skills)
          → model provider (e.g. OpenAI-compatible proxy for Grok)
          → host exec under allowlist / auto policy
  → streaming card reply on Feishu

Optional: same Feishu app used by lark-cli for manual API work.
```

## Prerequisites

1. WSL, Node **22.22.3+** or **24.15+** (installer prefers Node 24).
2. [OpenClaw](https://docs.openclaw.ai) CLI + Gateway.
3. Model auth: official provider **or** the same OpenAI-compatible proxy you
   already use for Grok CLI (`baseUrl` + key in **local** config only).
4. Feishu self-built app: App ID / Secret; Open Platform **long connection**
   + `im.message.receive_v1`; app published.
5. Work roots for write tasks (default mental model: `$HOME/work`).
6. Optional but recommended: `loginctl enable-linger` for the OpenClaw user.

## Layout

```text
openclaw/
  README.md
  config/
    openclaw.json5.example          # desensitized Gateway sketch
    feishu-openclaw.env.example     # shell-env.d template (no secrets)
  workspace/                        # symlink target for ~/.openclaw/workspace
    AGENTS.md
    skills/dev-task/SKILL.md
  scripts/
    link-workspace.sh
    smoke-readonly.sh
```

## Install (WSL)

```bash
# Prefer a Node version OpenClaw accepts (e.g. fnm use 24)
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh \
  | bash -s -- --no-onboard
```

If the default shell still uses an older Node, a small wrapper under
`~/.local/bin/openclaw` that prepends the Node 24 install `bin` is enough so
`openclaw` works without changing the default Node for everything else.

Non-interactive skeleton (auth filled later):

```bash
openclaw onboard \
  --non-interactive --accept-risk \
  --mode local --flow quickstart \
  --auth-choice skip \
  --install-daemon --daemon-runtime node \
  --workspace "$HOME/.openclaw/workspace" \
  --skip-bootstrap --skip-channels --skip-skills --skip-search --skip-ui
```

`--skip-bootstrap` preserves a linked repo `workspace/` (see below).

Then:

```bash
sudo loginctl enable-linger "$USER"   # once per machine user
```

## Link this package into runtime

```bash
./openclaw/scripts/link-workspace.sh
./openclaw/scripts/smoke-readonly.sh
```

Merge ideas from `config/openclaw.json5.example` into **local**
`~/.openclaw/openclaw.json` only. Never overwrite live secrets with the
example file blindly.

## Model: Grok via existing CLI proxy (optional pattern)

If Grok CLI already uses a custom OpenAI-compatible `baseUrl` + API key:

1. Keep the key **only** in local stores (Grok config, or
   `~/.config/shell-env.d/*.env` with mode 600).
2. In `~/.openclaw/openclaw.json`, define a **custom** `models.providers.*`
   entry (`api: "openai-responses"` when that matches the proxy) and set
   `agents.defaults.model.primary` to `provider/model-id`.
3. Restart Gateway: `systemctl --user restart openclaw-gateway.service`
4. Smoke without Feishu:

```bash
openclaw agent --local --agent main --session-key 'agent:main:smoke' \
  --message '只回复两个字：就绪' --thinking off --timeout 120
```

Do **not** paste real `baseUrl` + key into this repository.

## Feishu channel

### Plugin

```bash
openclaw plugins install @openclaw/feishu
# plugins.entries.feishu.enabled + plugins.allow includes "feishu"
```

### Credentials

```bash
install -m 600 openclaw/config/feishu-openclaw.env.example \
  ~/.config/shell-env.d/feishu-openclaw.env
# fill FEISHU_APP_ID / FEISHU_APP_SECRET locally
```

Or configure under `channels.feishu` in local `openclaw.json`. Reusing the
**lark-cli** app is OK for personal use — secrets stay local only.

### Recommended policy (personal)

| Setting | Value |
| --- | --- |
| `dmPolicy` | `allowlist` (owner `open_id`) |
| `groupPolicy` | `allowlist` (empty until a group is intentionally added) |
| `requireMention` | `true` |
| `tools` | disable doc/wiki/drive/perm/bitable unless needed |
| Transport | WebSocket long connection |

Open Platform: long connection + `im.message.receive_v1` + published bot.

### Apply and probe

```bash
systemctl --user restart openclaw-gateway.service
openclaw gateway status
openclaw channels status --probe
# expect: Feishu … connected, works
```

### End-to-end test

1. `openclaw logs --follow` (or `journalctl --user -u openclaw-gateway.service -f`).
2. Feishu **DM** the bot (allowlisted account).
3. Send e.g. `只回复两个字：就绪`.
4. Logs: receive DM → dispatch agent → model HTTP 200 → streaming /
   `dispatch complete (replies=1)`.

### Pairing (only if not using allowlist)

```bash
openclaw pairing list feishu
openclaw pairing approve feishu <CODE>
```

## MVP checklist

| Item | Done when |
| --- | --- |
| Package + AGENTS/skills in git | this tree |
| Gateway daemon | systemd active + enabled |
| Linger | `Linger=yes` |
| Model (Grok path) | local agent smoke OK |
| Feishu channel | probe works + real DM round-trip |
| Channel guards | DM allowlist; groups closed by default |
| Exec guards | `mode=auto` + approvals file + non-empty allowlist |
| Secrets not in git | audit / review before push |

## Task ledger (Feishu Base)

**Source of truth for development-task audit:** a Feishu multi-dim table
(Base), not git and not chat history.

| Piece | Location |
| --- | --- |
| CLI | `scripts/dev-task-ledger.sh` (`open` / `confirm` / `close` / `list` / `show`) |
| Skill | `workspace/skills/task-ledger/SKILL.md` |
| AGENTS rule | development tasks must open + close; reply includes `task_id` |
| Local env | `~/.config/shell-env.d/openclaw-tasks.env` (mode 600, **never commit**) |
| Env template | `config/openclaw-tasks.env.example` |
| Local index | `~/.local/state/openclaw-tasks/index.json` (task_id → record_id) |
| Requires | `lark-cli` on PATH (same Feishu app as OpenClaw channel is fine) |

### Commands

```bash
# after env is filled:
./openclaw/scripts/dev-task-ledger.sh config

./openclaw/scripts/dev-task-ledger.sh open \
  --title "…" --repo "$HOME/work/coco-forge" --cwd "$HOME/work/coco-forge" \
  --scope "packages/…" --acceptance "pnpm --filter … test" \
  --risk medium --source feishu --confirm-required 1

./openclaw/scripts/dev-task-ledger.sh confirm --task-id <uuid>
./openclaw/scripts/dev-task-ledger.sh close --task-id <uuid> \
  --status done --summary "…" --branch feat/… --commits abc1234
```

### Development allowlist (coco-forge only)

**Do not commit machine-specific absolute paths** (e.g. `/home/<user>/…`).  
Tracked docs only describe the *policy*; concrete roots stay local.

| Source | Value |
| --- | --- |
| Local override (preferred on odd layouts) | `OPENCLAW_TASKS_ALLOWED_ROOTS` in `~/.config/shell-env.d/openclaw-tasks.env` |
| Portable default (CLI if env unset) | `$HOME/work/coco-forge` and `$HOME/work/.worktrees/coco-forge` |

- Soft guard: `workspace/AGENTS.md` + skills refuse non–coco-forge development.
- Hard guard: `dev-task-ledger.sh` rejects `--repo` / `--cwd` outside the allowlist.

### Development workflow + worktree ownership

Write tasks follow:

**ledger open → worktree 初评 (assess) → user confirm → create → work →
ledger close → reclaim**

Claw mirrors your WezDeck **lifecycle** (dev / task / hotfix) under reserved
`claw-` prefixes so human trees are never overwritten.

| Kind | Claw dir / branch | Human analogue | Length |
| --- | --- | --- | --- |
| task | `claw-task-*` / `claw/task/…` | `task-*` | hours–days |
| dev | `claw-dev-*` / `claw/dev/…` | `dev-*` | weeks–months |
| hotfix | `claw-hotfix-*` / `claw/hotfix/…` | `hotfix-*` | hours |

Optional **domain** in slug: `claw-task-i18n-cache-field`.

```bash
# 初评 only (JSON): lifecycle + slug + branch + reasons
./openclaw/scripts/claw-worktree.sh assess \
  --title "cache search field" --domain i18n --scope "apps/…" --days 2

./openclaw/scripts/claw-worktree.sh create \
  --title "cache search field" --lifecycle task --domain i18n \
  --cwd "$HOME/work/coco-forge"

./openclaw/scripts/claw-worktree.sh list --cwd "$HOME/work/coco-forge"
./openclaw/scripts/claw-worktree.sh reclaim --slug claw-task-i18n-cache-search-field \
  --cwd "$HOME/work/coco-forge"
# claw-dev-*: add --allow-long-lived
```

Create uses `worktree-task` + `--provider none`. Reclaim refuses human prefixes;
`claw-dev-*` requires `--allow-long-lived` (same idea as WezDeck `dev-*`).

### Privacy

- Do **not** put App Secret, API keys, tokens, or full diffs in Base cells.
- Prefer short summaries + commit hashes; optional `source_ref` for chat ids only.

### Views (in Feishu UI)

Create views as needed: 进行中 / 本周完成 / 失败与取消 — no extra code required.

## Roadmap (after MVP)

Ordered by payoff for this personal setup:

1. **Ops polish** — pin `@openclaw/feishu` version; reduce doctor PATH/fnm
   warnings; optional weekly `openclaw security audit`.
2. **Exec allowlist hygiene** — add binaries only when Feishu tasks hit deny;
   keep `autoAllowSkills=false`.
3. **Ledger habit** — every Feishu dev task gets open/close; weekly glance at
   Base views for audit.
4. **One work group (optional)** — add a single `oc_…` to `groupAllowFrom`,
   keep `@mention`.
5. **Multi-repo spawn** — only after exec denials feel understood.
6. **ACP → Claude Code / Codex** — heavy coding workers; keep OpenClaw as
   orchestrator.
7. **WezDeck attach** — open worktree pane only when reviewing, not for every
   remote task.

## Non-goals (still)

- Replacing WezTerm/tmux/worktree-task.
- Auto-opening a pane for every remote task.
- eve as personal remote control.
- Committing secrets or live `~/.openclaw` state.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Probe fails | `openclaw gateway status`; `systemctl --user status openclaw-gateway` |
| Dead after logout | `loginctl show-user $USER -p Linger`; WSL still running? |
| No inbound on DM | Open Platform long connection + event + published app; correct bot |
| Inbound OK, no model reply | `openclaw models status`; proxy/key; local agent smoke |
| DM ignored | `dmPolicy` / allowlist `open_id` |
| Exec denied | `openclaw approvals get`; add binary; avoid broad `bash -c` if not listed |
| Group silent | empty `groupAllowFrom` is intentional; add group + @mention |

Logs: `openclaw logs --follow`, or
`journalctl --user -u openclaw-gateway.service -f`.

## Docs map

- This README: install, security, Feishu, guards, roadmap.
- [`workspace/AGENTS.md`](./workspace/AGENTS.md): main-agent behavior.
- Upstream: [OpenClaw](https://docs.openclaw.ai),
  [Feishu channel](https://docs.openclaw.ai/channels/feishu),
  [install](https://docs.openclaw.ai/install),
  [exec approvals](https://docs.openclaw.ai/tools/exec-approvals).
