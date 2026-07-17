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

**Main vs coding agents:** YunsClaw **main** owns Feishu orchestration (ledger,
worktree, claw-run, chrome MCP, handoff brief). Heavy coding uses host agents
that already load user `agent-profiles` (Claude/Codex) — **no** profile/MCP
bridge into ACP is required for that path.

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
| Dev allowlist | **coco-forge only** — roots from local env or `$HOME/work/…` defaults (no host user path in git) |
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

### Development execution modes

How a development request reaches something that actually writes code. Four
paths; only **main direct** and **operational handoff** are used on this host
today. CLI backend and ACP are OpenClaw product capabilities — **not configured**
here yet (see [Roadmap](#roadmap-after-mvp)).

| Mode | Executor | Model / auth | How messages reach the worker | Use when | Status (this host) |
| --- | --- | --- | --- | --- | --- |
| **Main agent, direct** | Gateway embedded agent (YunsClaw) | OpenClaw native provider (`grok-proxy`) | In-process tools (`read`/`write`/`exec` …) in claw worktree cwd | Small, clear-scope edits | **Active** (Feishu main path) |
| **Operational handoff** | Human or WezDeck `agent-launcher` starts host `claude` / `codex` at a cwd | Local CLI subscription login + **user `agent-profiles`** | Not OpenClaw IPC — main posts a **Handoff brief** in Feishu; operator continues in that CLI | Multi-file / heavy work without enabling ACP | **Active** (ops path; see `workspace/AGENTS.md`) |
| **CLI backend** | Bundled **`claude-cli`** (and custom `cliBackends`); **not** a default `codex-cli` | Reuses local Claude login; child env clears many `ANTHROPIC_*` vars so OAuth/login wins over API keys | OpenClaw selects model ref `claude-cli/…`, spawns CLI, **stream-json** over stdio; optional `bundleMcp` loopback for gateway tools | **Text / model fallback** when primary API fails — not the primary coding path | Capability present, **not configured** |
| **ACP harness** | Persistent coding harness via `@openclaw/acpx` (`claude`, `codex`, `gemini`, …) | Same local-login style as the harness itself | **[Agent Client Protocol](https://agentclientprotocol.com/)** over **stdio + JSON-RPC** (see below) | Heavy multi-file work with bindable sessions, `/acp` controls, resume | Capability present, **not configured** |

**Coding rules by executor**

| Executor | Instructions loaded |
| --- | --- |
| Main | `openclaw/workspace/AGENTS.md` + workspace skills (+ `~/.agents/skills`) |
| Operational handoff / ACP Claude | `~/.claude` → repo `agent-profiles/v1` (symlink) + **project** `AGENTS.md` at cwd |
| Codex (CLI host / ACP `codex`) | `~/.codex` profile links + `agent-profiles/v1/host-setup/codex.md` |
| CLI backend `claude-cli` | OpenClaw builds a system prompt from **workspace context**; not a full interactive Claude Code UX |

**Also not a coding backend:** in-process OpenClaw **sub-agents**
(`sessions_spawn` without `runtime: "acp"`) share the same embedded model/runtime —
parallelism only, not a separate Claude/Codex process.

**Auth note:** CLI/ACP reuse accounts you already use on the machine. Grok for
**main** is a native OpenClaw provider (proxy), not a local CLI login — see
[Model: Grok via existing CLI proxy](#model-grok-via-existing-cli-proxy-optional-pattern).
A Grok-backed **Codex** worker would be configured inside Codex itself
(`~/.codex/config.toml`), not by pointing OpenClaw main at Grok twice.

#### How ACP talks to the agent (protocol)

ACP is a **client↔server agent protocol** ([spec](https://agentclientprotocol.com/)).
In the OpenClaw **harness** direction (Feishu → coding worker), the stack is:

```text
Feishu / chat
  → OpenClaw Gateway (routing, bindings, delivery, policy)
      → acpx backend plugin
          → ACP JSON-RPC over stdio (or adapter transport)
              → harness adapter (e.g. Claude Code ACP / Codex ACP)
                  → real coding CLI process + its tools + user profile
```

OpenClaw owns the **control plane** (spawn, bind chat, cancel, close, deliver
replies). The harness owns **coding tools, auth, model catalog, and filesystem
behavior**. OpenClaw plugin tools are **not** exposed to the harness by default
(optional MCP bridges in upstream ACP setup docs).

**Session key shape (OpenClaw):** `agent:<agentId>:acp:<uuid>`  
(compare sub-agent: `agent:<agentId>:subagent:<uuid>`).

**Typical JSON-RPC-style lifecycle** (names follow ACP; exact fields are
adapter-defined — illustrative):

```text
1) Client (OpenClaw/acpx) → initialize
   ← server capabilities (sessions, models, …)

2) → session/new  { cwd: "/home/…/claw-task-…", … }
   ← session id

3) → session/prompt (or equivalent) { text: "Implement … acceptance …" }
   ← stream of session updates:
        agent message chunks / thought chunks / tool call events
   ← turn complete

4) Optional: session/set_model, session/request_permission (approvals),
             session/load or resume after restart

5) → session/close  (or /acp close from chat)
```

Bound chat (when enabled): after `/acp spawn claude --bind here --cwd <worktree>`,
**normal user text** in that conversation is forwarded as ACP prompts to the
same session; **`/acp …`, `/status`, `/unfocus`** stay on the Gateway and are
**not** sent as prompt text to the harness.

**Operator examples** (not enabled on this host until ACP is configured):

```text
# Health
/acp doctor

# Spawn Claude Code ACP in a claw worktree; keep talking in this chat
/acp spawn claude --bind here --cwd $HOME/work/.worktrees/coco-forge/claw-task-…

# Or from main agent tooling (when advertised)
sessions_spawn({ runtime: "acp", agentId: "claude", cwd: "…", … })

# Steer / stop without tearing down the binding
/acp steer tighten logging and continue
/acp cancel
/acp status
/acp close
```

**Example Feishu turn (mental model):**

1. User: 「大改 i18n CSV 导入」  
2. **Main** (embedded): ledger open → worktree 初评 → create `claw-task-…` →
   either implements small fix **or** prepares handoff / (later) `/acp spawn`.  
3. If ACP: Gateway spawns harness at that `cwd`; user follow-ups in the bound
   chat become ACP prompts; harness uses **its** profile + project files.  
4. Completion text returns through Gateway → Feishu; **main** still owns ledger
   `close` + reclaim ask.

**Contrast with operational handoff (what we use now for heavy work):**

```text
Main → Feishu "## Handoff" block (task_id, cwd, goal, acceptance)
User/WezDeck → cd <cwd> && claude --continue
  (no ACP JSON-RPC; full local Claude + agent-profiles)
Main ← user pastes summary or continues Feishu for ledger close
```

Upstream: [ACP agents](https://docs.openclaw.ai/tools/acp-agents),
[ACP setup](https://docs.openclaw.ai/tools/acp-agents-setup),
[CLI backends](https://docs.openclaw.ai/gateway/cli-backends)
(fallback only — not a substitute for ACP).

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
  --risk medium --source feishu --confirm-required 1 \
  --requester-id ou_xxx   # optional: 需求提出人 (Feishu open_id)

./openclaw/scripts/dev-task-ledger.sh update \
  --task-id <uuid> --requester-id ou_xxx

./openclaw/scripts/dev-task-ledger.sh confirm --task-id <uuid>
./openclaw/scripts/dev-task-ledger.sh close --task-id <uuid> \
  --status done --summary "…" --branch feat/… --commits abc1234
```

### Base columns (selected)

| Column | Meaning |
| --- | --- |
| `task_id` | UUID primary key for agent reports |
| `标题` / `状态` / `范围` / `验收` | Task meta |
| **`需求提出人`** | Person who raised the need (Feishu user field) |
| `来源` | feishu / cli / manual |
| `cwd` / `分支` / `commits` / `MR` | Delivery pointers |
| `结果摘要` | Close summary |

Write `需求提出人` via CLI `--requester-id <ou_…>` (cell value `[{ "id": "ou_…" }]`).

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
  --cwd "$HOME/work/coco-forge"

# second parallel tree in same domain
./openclaw/scripts/claw-worktree.sh create \
  --title "other i18n fix" --lifecycle task --domain i18n \
  --cwd "$HOME/work/coco-forge" --force-new

./openclaw/scripts/claw-worktree.sh list --cwd "$HOME/work/coco-forge"
# reclaim only after user says yes (never automatic)
./openclaw/scripts/claw-worktree.sh reclaim --slug claw-task-i18n-… \
  --cwd "$HOME/work/coco-forge"
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
6. **ACP → Claude Code / Codex** — optional; enables `/acp spawn`, bindable
   sessions, JSON-RPC harness control (see
   [Development execution modes](#development-execution-modes)). Until then,
   heavy work uses **operational handoff** + host `agent-profiles`.
7. **CLI backend (`claude-cli`)** — optional text/model **fallback** only, not
   the primary coding path ([upstream CLI backends](https://docs.openclaw.ai/gateway/cli-backends)).
8. **WezDeck attach** — open worktree pane only when reviewing, not for every
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
