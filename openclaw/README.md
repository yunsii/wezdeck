# OpenClaw personal control plane (MVP)

Versioned templates and agent protocol for a **Feishu → OpenClaw → local machine**
loop. This directory is **not** part of the WezTerm runtime hot path.

**Display name on Feishu (this machine):** **YunsClaw** — set in local
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
| Machine path overrides | `OPENCLAW_TASKS_ALLOWED_ROOTS` in local env | **never** track |

**Do not commit:** absolute host paths (`/home/<user>/…`), App Secret, API keys,
Gateway tokens, Base tokens, filled `*.env`, live `openclaw.json`, or personal
`open_id` / app id used only on one machine. Tracked files use `$HOME`, env var
**names**, and placeholders only (`cli_xxx`, `ou_…` examples).

WezDeck (this repo's tmux / attention / `agent-launcher`) stays the **optional
review surface**. OpenClaw may run headless; open a pane only when you want to
watch or take over.

Protocol detail: [`workspace/AGENTS.md`](./workspace/AGENTS.md).

**Development modes:** human direct (A), Feishu main (B), optional handoff (C);
**CLI backend (D) disabled by policy**; ACP (E) optional later — see
[Development modes](#development-modes-who-writes-code).

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
| Host exec | `mode: full`, `ask=off`, **`strictInlineEval=false`** (no `/approve` on `xargs`/inline). **Option A:** agent must use `claw-run.sh` → rules → Grok → Feishu if danger (`skills/exec-risk`). Not binary allowlist. |
| **Chrome MCP** | OpenClaw `mcp.servers.chrome-devtools` → `chrome-devtools-mcp` on **CDP `127.0.0.1:9222`** (WezDeck debug Chrome). Core browser capability for YunsClaw. |
| Elevated | `tools.elevated.enabled: false` |
| Task ledger | Feishu Base via `scripts/dev-task-ledger.sh` + skill `task-ledger` |
| Dev allowlist | **wezdeck (+ optional team roots in local config)** (wezterm-config) — roots from local env or `$HOME/…` portable defaults |
| Secrets | mode `600` env files; never commit filled config |

### Quick health

```bash
loginctl show-user "$USER" -p Linger          # expect Linger=yes
systemctl --user is-active openclaw-gateway   # active
openclaw channels status --probe              # Feishu … works
openclaw exec-policy show
openclaw mcp list && openclaw mcp probe chrome-devtools   # ~29 tools
curl -sS -m 3 http://127.0.0.1:9222/json/version          # CDP up
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
| Host exec | Prefer one of: `mode: full` (auto) **or** `mode: auto`/`allowlist` (prompt/deny). Do not mix `mode` with `security`/`ask` fields. |
| `strictInlineEval` | Personal YunsClaw: **`false`** so platform does not force `/approve` on `xargs`/`-c`. Semantic gate is `claw-run` (see `skills/exec-risk`). Set `true` only if you want platform hard-block on inline carriers. |
| Host approvals file | Must match intent: full+off for auto; allowlist+on-miss for prompts |
| Allowlist entries | Only matter when security is allowlist |
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
          → host exec (claw-run protocol + mode=full)
          → MCP chrome-devtools → CDP 127.0.0.1:9222 (WezDeck debug Chrome)
  → reply on Feishu

Optional: same Feishu app used by lark-cli for manual API work.
```

### Development modes (who writes code)

Five ways code gets written on this machine. **A / B are the everyday paths.**
**C** is an optional bot→local handoff (single writer). **E (ACP)** is enabled
on this host for `claude` + `codex` (see below). **D (CLI backend) is disabled**.

```text
需求
  ├─ A 人工直接开发 ──────────────► IDE / 终端 / 本机 Claude·Codex
  │                                   （可不经飞书、不经 Handoff）
  │
  └─ 飞书 YunsClaw (main)
        ├─ B Main 直写 ───────────► Gateway 内工具 + grok-proxy（小改）
        ├─ C 运营 Handoff ────────► 本机做完编码 → 再回飞书让 main 收尾
        ├─ D CLI backend ─────────► **禁用**
        └─ E ACP harness ─────────► acpx → claude / codex（stdio JSON-RPC）
```

| | Mode | Who codes | How it connects | When | Status |
| --- | --- | --- | --- | --- | --- |
| **A** | **Human direct** | You (IDE / shell / host `claude`·`codex`) | No OpenClaw IPC | Day-to-day coding; full **TUI history** if using CLI | **Active** |
| **B** | **Main direct** | YunsClaw embedded agent | Feishu → Gateway in-process tools | Small, clear Feishu-driven edits + ledger/worktree | **Active** |
| **C** | **Operational handoff** | Host CLI (or you) after main prepares cwd | Main posts `## Handoff` in Feishu; **not** ACP | Main will not implement the bulk; local finish → main wrap-up | **Optional protocol** |
| **D** | **CLI backend** | Bundled `claude-cli` etc. | stream-json spawn as model | — | **Disabled by policy** |
| **E** | **ACP harness** | `claude` / `codex` via `@openclaw/acpx` | ACP **stdio + JSON-RPC** | Multi-file Feishu-driven coding workers | **Enabled** (`allowedAgents: claude, codex`) |

**Single writer rule:** for a given worktree, only **one** of main / local CLI /
you should be the primary editor at a time. Do **not** run B and C (or A and B)
as concurrent writers on the same tree.

**Mode declaration (protocol):** after the user confirms requirements / worktree
初评, **main must post a 【开发方式】** block (A/B/C/E + who executes + one-line
reason) and **wait for confirm** before writing code or `/acp spawn`. This is
**soft routing** (agent + AGENTS heuristics), not a hard classifier binary.
User overrides win. See `workspace/AGENTS.md`.

#### A — Human direct

```text
You → edit under 团队仓 or a worktree → commit / MR as usual
```

- No Feishu brief required.
- Host Claude/Codex load **agent-profiles** (`~/.claude` / `~/.codex` symlinks).
- Process detail: your TUI / IDE. OpenClaw is unaware unless you later ask main
  for ledger/验收.

#### B — Main direct (Feishu claw develops)

```text
Feishu → main → claw-* worktree (read/write/exec via claw-run) → Feishu 结果
```

- Instructions: `openclaw/workspace/AGENTS.md` + skills (not full agent-profiles).
- **No Claude-Code-like TUI** for full tool history — follow via Feishu progress,
  `journalctl --user -u openclaw-gateway`, and `git` in the worktree.
- Danger shell: `claw-run` → Feishu confirm if still danger (not `/approve` spam).

#### C — Operational handoff (optional)

Main **prepares** ledger + worktree, posts a brief, then **stops coding**.
Local side finishes; main is called back for **close / 验收 / reclaim**.

```text
正常节奏（推荐）:
  main: open + 初评 + create cwd + ## Handoff
    → 本机: cd <cwd> && claude   # 或人直接改；做完这一段
    → 飞书: 「做完了…」→ main: ledger close + 问 reclaim

不要:
  main 与本机 CLI 同时当主笔改同一 worktree
```

- Handoff is **execution transfer**, not “so you can resume TUI for curiosity”.
- After handoff, main **does not** drive the local CLI turn-by-turn.
- You **may** message Feishu mid-flight (status / stop local then let main take a
  slice); default is **finish local first**, then return main for wrap-up.
- Mid-process “take back”: possible on Feishu, but pause local coding first.

**Handoff block (main → 飞书):** see `workspace/AGENTS.md`.

#### D — CLI backend: disabled (policy)

Do **not** add `claude-cli/…` as primary or `agents.defaults.model.fallbacks`,
and do **not** configure `agents.defaults.cliBackends` for coding on this host.

Why: non-interactive CLI backend only gets a **coarse** permission mode at
spawn (e.g. bypass vs default). It cannot do Feishu step-by-step 提权 like
main `claw-run`, nor a real TUI Allow/Deny loop. Controllability is too weak
for a personal control plane that already has **A** (full TUI) and **B**
(main + claw-run + Feishu confirm).

If a future need appears (pure text fallback when Grok is down), re-evaluate
explicitly — default remains **off**. Upstream reference only:
[CLI backends](https://docs.openclaw.ai/gateway/cli-backends).

#### E — ACP (enabled on this host)

Local config (never commit secrets): `@openclaw/acpx` enabled, `plugins.allow`
includes `acpx`, top-level:

```json5
acp: {
  enabled: true,
  backend: "acpx",
  defaultAgent: "claude",
  allowedAgents: ["claude", "codex"],
  maxConcurrentSessions: 4,
  runtime: { ttlMinutes: 120 },
}
// plugins.entries.acpx.config.permissionMode: "approve-all"  // personal; break-glass
```

**Usage (Feishu or `openclaw agent --message`):**

```text
/acp doctor
/acp spawn claude --cwd /abs/path/to/claw-worktree
/acp spawn codex  --cwd /abs/path/to/claw-worktree
/acp status | /acp close
```

| Target | Smoke (2026-07-18) | Notes |
| --- | --- | --- |
| **claude** | **PASS** — `smoke-ok.txt` = `claude-acp-ok` | Host Claude Code login; user `~/.claude` / agent-profiles |
| **codex** (default GPT) | **PASS** after auth bridge | Isolated `~/.openclaw/acpx/codex-home` needs host auth (401 if missing). Bundled `codex-acp` OK without global `codex` on PATH |
| **codex + Grok** | **Config landed; ACP write smoke not green** | Model id **`grok-4.5`** from Grok CLI / OpenClaw proxy. Use `~/.codex/grok.config.toml` + `codex --profile grok` (and/or `[profiles.grok]`). ACP still `spawn codex` (no `spawn grok`). First ACP turns failed (`ACP_TURN_FAILED` / sandbox-read-only or profile form); treat as **best-effort** until re-verified |

**Codex + Grok (recommended local config)** — aligned with Grok CLI
`~/.grok/config.toml` (`models_base_url` …`/v1`, default `grok-4.5`,
`api_backend = responses`) and OpenClaw `grok-proxy` models:

```toml
# ~/.codex/grok.config.toml  (preferred for newer Codex: codex --profile grok)
model_provider = "OpenAI"
model = "grok-4.5"
model_reasoning_effort = "high"

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://YOUR-PROXY.example"   # same host as Grok CLI / Packy
wire_api = "responses"
requires_openai_auth = true
```

Optional dual form in `config.toml` (if your Codex still reads profiles from it):

```toml
[profiles.grok]
model_provider = "OpenAI"
model = "grok-4.5"
model_reasoning_effort = "high"
```

Keep **default** `model = "gpt-5.5"` (or your GPT id) for everyday Codex; only switch
to Grok when you want that model. Prefer `codex --profile grok` with
`grok.config.toml` (newer Codex rejects top-level `profile = "…"`). Auth: same
proxy credentials as Grok CLI / Codex `auth.json` (do not commit). For ACP
isolation, ensure `~/.openclaw/acpx/codex-home/auth.json` stays populated after
first successful codex ACP run.

**Ops:** single writer per worktree; main still owns ledger `task_id` open/close.
`approve-all` is intentional for personal DM-only control plane — tighten if
shared. Upstream: [ACP agents](https://docs.openclaw.ai/tools/acp-agents).

**Also not a coding backend:** OpenClaw in-process **sub-agents**
(`sessions_spawn` without `runtime: "acp"`) — same embedded runtime, parallelism
only.

**Coding rules by executor**

| Who | Instructions |
| --- | --- |
| Main (B) | `openclaw/workspace/AGENTS.md` + workspace / `~/.agents` skills |
| Human / handoff CLI / future ACP Claude (A, C, E) | `agent-profiles/v1` via `~/.claude` + project `AGENTS.md` at cwd |
| Codex host / future ACP `codex` | `~/.codex` + `agent-profiles/v1/host-setup/codex.md` |
| CLI backend (D) | **N/A — disabled** |

**Auth:** CLI/ACP reuse machine logins (Claude CLI child clears many `ANTHROPIC_*`
env vars so subscription login wins). Main **Grok** is a native OpenClaw provider
(proxy), not a local CLI login — [Grok proxy section](#model-grok-via-existing-cli-proxy-optional-pattern).

#### How ACP talks to the agent (when E is enabled)

ACP = [Agent Client Protocol](https://agentclientprotocol.com/). Harness stack:

```text
Feishu / chat
  → OpenClaw Gateway (route, bind, deliver, policy)
      → @openclaw/acpx
          → ACP JSON-RPC over stdio
              → adapter (Claude Code ACP / Codex ACP / …)
                  → coding process + its tools + agent-profiles
```

OpenClaw = control plane; harness = tools/auth/FS. Plugin tools are **not**
injected into the harness by default.

**vs Happy (the mobile channel).** `claw` bets on **one** protocol — ACP over
stdio — for *every* agent on the local hop; Claude/Codex/etc. all reach it
through their ACP adapters. Happy inverts this: it is a **polyglot** locally —
`stream-json` for Claude, **MCP** for Codex, **ACP** only for Gemini — and is
uniform only on its remote E2E relay. Where the two touch ACP they share the
same `@agentclientprotocol/sdk` standard. Per-agent transport detail (verified
against `slopus/happy-cli`): [`docs/mobile-access.md` → How Happy talks to each
agent](../docs/mobile-access.md).

**Illustrative lifecycle:**

```text
initialize → session/new { cwd } → session/prompt (stream updates)
  → optional set_model / request_permission / load|resume
  → session/close   # or /acp close
```

After `/acp spawn claude --bind here --cwd <worktree>`, normal chat text is
forwarded as ACP prompts; `/acp …` / `/status` stay on Gateway.

```text
/acp doctor
/acp spawn claude --bind here --cwd $HOME/work/.worktrees/team-repo/claw-task-…
/acp steer …   /acp cancel   /acp status   /acp close
```

**Follow process detail**

| Mode | How to follow “what happened” |
| --- | --- |
| A | IDE / CLI TUI (`claude --continue` in that cwd) |
| B | Feishu thread + gateway logs + worktree `git` — **not** full TUI |
| C | Local TUI during coding; Feishu for brief + wrap-up |
| E (later) | Bound chat delivery + harness; still ≠ 1:1 Claude TUI |

Upstream: [ACP agents](https://docs.openclaw.ai/tools/acp-agents),
[ACP setup](https://docs.openclaw.ai/tools/acp-agents-setup),
[CLI backends](https://docs.openclaw.ai/gateway/cli-backends).

### Chrome DevTools MCP (core browser capability)

YunsClaw drives the **same** headless/debug Chrome that WezDeck auto-starts
for agents (see repo [`docs/browser-debug.md`](../docs/browser-debug.md)).

| Layer | Value |
| --- | --- |
| Config key | `mcp.servers.chrome-devtools` in **local** `~/.openclaw/openclaw.json` |
| Command | `npx -y chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:9222` |
| Tool profile | `tools.profile: coding` (allows `bundle-mcp`) |
| Agent skill | `workspace/skills/chrome-devtools/SKILL.md` |

One-time install on a machine:

```bash
curl -sS -m 3 http://127.0.0.1:9222/json/version   # CDP must be up first

openclaw mcp add chrome-devtools \
  --command npx \
  --arg -y \
  --arg chrome-devtools-mcp@latest \
  --arg --browser-url=http://127.0.0.1:9222 \
  --timeout 90 \
  --connect-timeout 60

openclaw mcp probe chrome-devtools   # expect ~29 tools
openclaw mcp reload
# or: systemctl --user restart openclaw-gateway.service
```

Notes:

- Grok/Claude CLI MCP configs are **separate processes**; they share the **Chrome
  on 9222**, not the OpenClaw MCP runtime. Prefer one agent controlling the browser
  at a time.
- Change port only if `wezterm-x/local/constants.lua` `chrome_debug_browser.remote_debugging_port`
  differs; keep loopback only.
- Do not commit live `openclaw.json`; template is in `config/openclaw.json5.example`.

## Prerequisites

1. WSL, Node **22.22.3+** or **24.15+** (installer prefers Node 24).
2. [OpenClaw](https://docs.openclaw.ai) CLI + Gateway.
3. Model auth: official provider **or** the same OpenAI-compatible proxy you
   already use for Grok CLI (`baseUrl` + key in **local** config only).
4. Feishu self-built app: App ID / Secret; Open Platform **long connection**
   + `im.message.receive_v1`; app published.
5. Work roots for write tasks (default mental model: `$HOME/work`).
6. Optional but recommended: `loginctl enable-linger` for the OpenClaw user.
7. **Browser automation:** WezDeck debug Chrome on CDP `9222` + OpenClaw
   `mcp.servers.chrome-devtools` (above).

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
| CLI | `scripts/dev-task-ledger.sh` (`open` / `confirm` / `close` / `delete` / `list` / `show`) |
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
  --title "…" --repo "$HOME/work/team-repo" --cwd "$HOME/work/team-repo" \
  --scope "packages/…" --acceptance "pnpm --filter … test" \
  --risk medium --source feishu --confirm-required 1 \
  --requester-id ou_xxx   # optional: 需求提出人 (Feishu open_id)

./openclaw/scripts/dev-task-ledger.sh update \
  --task-id <uuid> --requester-id ou_xxx

./openclaw/scripts/dev-task-ledger.sh confirm --task-id <uuid>
./openclaw/scripts/dev-task-ledger.sh close --task-id <uuid> \
  --status done --summary "…" --branch feat/… --commits abc1234

# After every smoke/test open: hard-delete the row (do not leave test data)
./openclaw/scripts/dev-task-ledger.sh delete --task-id <uuid>
# or: … delete --record-id recXXXX
```

### Base columns (selected)

| Column | Meaning |
| --- | --- |
| `task_id` | UUID primary key for agent reports |
| `标题` / `状态` / `范围` / `验收` | Task meta |
| **`需求提出人`** | Person who raised the need (Feishu user field) |
| `来源` | feishu / cli / manual |
| **`仓库`** | **https web URL** only (`https://github.com/…` / `https://cnb.cool/…`) — clickable; CLI rewrites `git@` / `ssh://` / `.git` |
| **`cwd`** | **Local** working path (allowlisted absolute path / claw worktree) |
| `分支` / `commits` / `MR` | Delivery pointers |
| **开始时间** | `open` — second precision (`YYYY-MM-DD HH:MM:SS`) |
| **需确认** | Live gate: true until `confirm` (default); **unchecked after confirm** — not 验收/merge |
| **确认时间** | `confirm` wall clock; only equals 开始时间 when `--confirm-required 0` |
| **结束时间** | `close` — **ledger close clock** (done/failed/cancelled/blocked), **not** PR merge time |
| `结果摘要` | Close summary |

`--repo` may be a local path (resolved to origin, then to **https web URL** for
`仓库`) or any git remote form. `--cwd` is always local. Never store machine
paths or bare `git@…` SSH remotes in `仓库`.

**Test hygiene:** every smoke that calls `open` must end with **`delete`** so
the production Base table stays free of test rows. Real work uses `close`.

**Time loop:** `open` → user yes → **`confirm`** → work → **`close`**.  
`close --status done` is rejected if still 需确认. PR merge time is **not**
auto-filled; use `MR` URL + summary.

**秒级显示：** 开始/确认/结束时间 must be Base **文本** columns. Feishu
`datetime` formats max out at `HH:mm` (no seconds) and default
`yyyy/MM/dd` only shows the day — that is why the table looked day-only.

Write `需求提出人` via CLI `--requester-id <ou_…>` (cell value `[{ "id": "ou_…" }]`).

### Development allowlist (wezdeck (+ optional team roots in local config))

**Do not commit machine-specific absolute paths** (e.g. `/home/<user>/…`).  
Tracked docs only describe the *policy*; concrete roots stay local.

| Logical repo | Portable default roots (when env unset) |
| --- | --- |
| **团队仓** | `$HOME/work/team-repo`, `$HOME/work/.worktrees/team-repo` |
| **wezdeck** | `$HOME/github/wezterm-config`, `$HOME/work/.worktrees/wezterm-config`, `$HOME/work/wezterm-config` |

| Source | Value |
| --- | --- |
| Local override | `OPENCLAW_TASKS_ALLOWED_ROOTS` in `~/.config/shell-env.d/openclaw-tasks.env` |
| Portable default | See `dev-task-ledger.sh` `DEFAULT_ALLOWED_ROOTS` |

- Soft guard: `workspace/AGENTS.md` + skills refuse non-allowlisted development.
- Hard guard: `dev-task-ledger.sh` rejects `--repo` / `--cwd` outside the allowlist.
- Default create cwd for product work remains 团队仓; pass
  `--cwd "$HOME/github/wezterm-config"` (or local equivalent) for wezdeck tasks.

### Development workflow + worktree ownership

Write tasks follow:

**ledger open → worktree 初评 (assess) → user confirm → create/reuse → work →
ledger close → ask whether to reclaim**（dev 默认不回收）

Claw mirrors your WezDeck **lifecycle** (dev / task / hotfix) under reserved
`claw-` prefixes so human trees are never overwritten.

| Kind | Claw dir / branch | Human analogue | Length |
| --- | --- | --- | --- |
| task | `claw-task-*` / `claw/task/…` | `task-*` | hours–days |
| dev | `claw-dev-*` / `claw/dev/…` | `dev-*` | weeks–months |
| hotfix | `claw-hotfix-*` / `claw/hotfix/…` | `hotfix-*` | hours |

Optional **domain** in slug: `claw-task-i18n-cache-field`.

**Same domain, multiple tasks:** prefer **reuse** (especially `claw-dev-<domain>-*`
hubs). Independent parallel work: `--force-new` → unique `…-2`. Assess reports
`action=reuse|create` and `same_domain_candidates`.

```bash
# 初评 (JSON): action, reuse path, create_slug_if_new, candidates
./openclaw/scripts/claw-worktree.sh assess \
  --title "cache search field" --domain i18n --scope "apps/…" --days 2

# default prefer-reuse
./openclaw/scripts/claw-worktree.sh create \
  --title "cache search field" --lifecycle task --domain i18n \
  --cwd "$HOME/work/team-repo"

# second parallel tree in same domain
./openclaw/scripts/claw-worktree.sh create \
  --title "other i18n fix" --lifecycle task --domain i18n \
  --cwd "$HOME/work/team-repo" --force-new

./openclaw/scripts/claw-worktree.sh list --cwd "$HOME/work/team-repo"
# reclaim only after user says yes (never automatic)
./openclaw/scripts/claw-worktree.sh reclaim --slug claw-task-i18n-… \
  --cwd "$HOME/work/team-repo"
# claw-dev-*: default keep; if user insists: --allow-long-lived
```

Create uses `worktree-task` + `--provider none`. Reclaim refuses human prefixes.
**After business completes, claw asks before reclaim; `claw-dev-*` usually stays.**

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
6. **ACP ops** — mode **E** enabled (`claude`/`codex`); prefer claw worktree
   cwd; keep `approve-all` personal-only; Codex may need CODEX_HOME auth bridge
   on first use. Grok-via-Codex = set Codex model id on proxy, not `spawn grok`.
7. **CLI backend** — **disabled** (mode **D**).
8. **WezDeck attach** — open worktree pane only when reviewing, not for every
   remote task.

## Non-goals (still)

- Replacing WezTerm/tmux/worktree-task.
- Auto-opening a pane for every remote task.
- eve as personal remote control.
- Committing secrets or live `~/.openclaw` state.
- **CLI backend (`claude-cli` as Feishu model/fallback)** — controllable
  development uses **A/B/C** (or later **E**), not coarse spawn-time permissions.

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

- This README: install, security, Feishu, guards, **execution modes + ACP**,
  roadmap.
- [`workspace/AGENTS.md`](./workspace/AGENTS.md): main checklist, handoff brief,
  claw-run, chrome triggers.
- Skills: `dev-task`, `task-ledger`, `exec-risk`, `chrome-devtools`.
- User coding profile (host CLIs / future ACP): repo
  [`agent-profiles/v1`](../agent-profiles/v1/README.md).
- Browser host: [`docs/browser-debug.md`](../docs/browser-debug.md).
- Upstream: [OpenClaw](https://docs.openclaw.ai),
  [Feishu channel](https://docs.openclaw.ai/channels/feishu),
  [ACP agents](https://docs.openclaw.ai/tools/acp-agents),
  [CLI backends](https://docs.openclaw.ai/gateway/cli-backends),
  [install](https://docs.openclaw.ai/install),
  [exec approvals](https://docs.openclaw.ai/tools/exec-approvals).
