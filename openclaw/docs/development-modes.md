# Development modes (who writes code)

Authority for **H1/H2 · C1/C2/C3** (legacy A–E aliases). Operator entry: [`../README.md`](../README.md). Architecture overview: [`agent-architecture.md`](./agent-architecture.md). Cards/procedure: `../workspace/skills/dev-task/SKILL.md`.

**User-facing language:** human rail **H1/H2** and Claw rail **C1/C2/C3**
(see [`agent-architecture.md`](./agent-architecture.md)).
Legacy **A–E** codes stay as internal aliases (below).

**Everyday paths:** H1/H2 and C1. **C2** optional handoff. **C3** ACP access to
Claude/Codex backends. **D** disabled.

```text
需求
  ├─ 人工轨
  │    H1 人直接开发 ─────────────► IDE
  │    H2 人 + 原生 Agent ────────► grok / claude / codex 原生 TUI
  │
  └─ Claw 轨（飞书 Dex / Main-Grok 编排）
        ├─ C1 Main 自写 ──────────► Gateway 工具 + grok-proxy（小改）
        ├─ C2 Handoff 原生 ───────► 本机 CLI 写完 → Main 收尾（非 ACP）
        ├─ D  CLI backend ────────► **禁用**
        └─ C3 ACP 接入 ───────────► acpx → 后端 claude | codex
```

| 轨 | 方式 | 旧 | Who codes | How it connects | When | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 人工 | **H1** 人直接 | A | You (IDE) | No OpenClaw IPC | Day-to-day | **Active** |
| 人工 | **H2** 原生 Agent | A | Host `grok`/`claude`/`codex` | Native TUI | Full product UX | **Active** |
| Claw | **C1** Main 自写 | B | Dex (Main) embedded | Feishu → in-process tools | Small Feishu edits | **Active** |
| Claw | **C2** Handoff | C | Host CLI after handoff | Feishu `## Handoff`; not ACP | Local finish → Main wrap-up | **Optional** |
| Claw | **C3** ACP 后端 | E | `claude` / `codex` via ACP | ACP stdio JSON-RPC (**access layer**) | Multi-file Feishu workers | **Enabled** |
| — | ~~D CLI backend~~ | D | — | stream-json as model | — | **Disabled** |

**Single writer rule:** for a given **cwd** (primary checkout or worktree), only
**one** of main / local CLI / ACP worker / you is the primary editor. Do **not**
run C1+C2 or C1+C3 concurrent writes on the same tree.

**cwd (wezdeck):** default **primary `master`** (personal mainline, L0-13). Use a
`claw-*` worktree only for parallel work, long experiments, or isolation. 团队仓
still prefers `claw-*` unless the user overrides.

**Mode declaration (protocol):** after requirements (and worktree 初评 **only if**
isolation is needed), **main must post a 【开发方式】 recommendation card** (H/C
Chinese names + optional A–E + who executes + reason + alternatives) and **wait
for confirm** before writing code or `/acp spawn`. Soft routing; user overrides
win. See `../workspace/AGENTS.md` and `agent-architecture.md`.

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
Feishu → main → wezdeck primary master (default) or claw-* if isolated
         → read/write/exec via claw-run → Feishu 精简【结果】
```

- Instructions: `../workspace/AGENTS.md` + skills (not full agent-profiles).
- **No Claude-Code-like TUI** for full tool history — follow via Feishu progress,
  `journalctl --user -u openclaw-gateway`, and `git` in the cwd.
- Danger shell: `claw-run` → Feishu confirm if still danger (not `/approve` spam).

#### C — Operational handoff (optional)

Main **prepares** ledger + cwd (master or worktree), posts a brief, then **stops coding**.
Local side finishes; main is called back for **close / 验收 / reclaim** (reclaim only if worktree).

```text
正常节奏（推荐）:
  main: open + 【开发方式】+ cwd (wezdeck: often master) + ## Handoff
    → 本机: cd <cwd> && claude   # 或人直接改
    → 飞书: 「做完了…」→ main: ledger close + 问 reclaim（若用了 worktree）

不要:
  main 与本机 CLI 同时当主笔改同一 cwd
```

- Handoff is **execution transfer**, not “so you can resume TUI for curiosity”.
- After handoff, main **does not** drive the local CLI turn-by-turn.
- You **may** message Feishu mid-flight (status / stop local then let main take a
  slice); default is **finish local first**, then return main for wrap-up.
- Mid-process “take back”: possible on Feishu, but pause local coding first.

**Handoff block (main → 飞书):** see `../workspace/AGENTS.md`.

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

#### C3 / E — ACP access layer (Claude / Codex backends)

**ACP is not a third constitution.** It is the OpenClaw **access layer** that
schedules **Claude** or **Codex** as coding backends on the Claw rail. There is
no `spawn grok`. Grok as a *model* on Codex ≠ Grok native CLI ≠ Main-Grok.

**Config isolation (hard):** ACP Codex uses only
`~/.openclaw/acpx/codex-home/**`. Do **not** overwrite host `~/.codex` defaults
when tuning ACP. Host `~/.claude` / `~/.codex` / `~/.grok` remain user assets.

**Attention isolation (hard):** C3 ACP and other delegated headless workers must
**not** write the WezDeck interactive attention badge (`Alt+/` · ●/▲). After
`@openclaw/acpx` regenerates `~/.openclaw/acpx/*-wrapper.mjs`, re-run
`openclaw/scripts/patch-acpx-attention-skip.sh`. Defense in depth:
`scripts/runtime/agent-attention/emit.sh` skips when `AGENT_ATTENTION_SKIP` /
`OPENCLAW_ACP` / `OPENCLAW_ACPX_LEASE_ID` is set.
Adversarial-review and handoff CLIs use host configs (`env -u CODEX_HOME`).

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

| Target | Smoke | Notes |
| --- | --- | --- |
| **claude** | **PASS** (2026-07-18) — `claude-acp-ok` | Host Claude Code login; user `~/.claude` / agent-profiles |
| **codex** (ACP isolated default) | **PASS** (2026-07-19) — `tmp-acp-smoke/smoke-ok.txt` = `codex-acp-ok` | ACP uses **isolated** `~/.openclaw/acpx/codex-home` (default model **grok-4.5** on this proxy). Host `~/.codex` defaults **not** overwritten. No `spawn grok`. |
| **codex host GPT default** | **degraded** on this proxy account group | Host may keep `gpt-5.5`; many GPT ids 404 here — separate from ACP smoke |
| **codex + Grok (host profile)** | **PASS** CLI (`codex -p grok`); review path uses host | `~/.codex/grok.config.toml` + `[profiles.grok]`; review adapters `env -u CODEX_HOME` |

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
| Main (B) | `../workspace/AGENTS.md` + workspace / `~/.agents` skills |
| Human / handoff CLI / future ACP Claude (A, C, E) | `../../agent-profiles/v1` via `~/.claude` + project `AGENTS.md` at cwd |
| Codex host / future ACP `codex` | `~/.codex` + `../../agent-profiles/v1/host-setup/codex.md` |
| CLI backend (D) | **N/A — disabled** |

**Auth:** CLI/ACP reuse machine logins (Claude CLI child clears many `ANTHROPIC_*`
env vars so subscription login wins). Main **Grok** is a native OpenClaw provider
(proxy), not a local CLI login — [Grok proxy](../README.md#model-grok-via-existing-cli-proxy-optional-pattern).

#### How ACP talks to the agent (when E is enabled)

ACP = [Agent Client Protocol](https://agentclientprotocol.com/). Access stack
(terms: [`./terminology.md` §2](./terminology.md#2-model--harness--agent--backend核心分层)):

```text
Feishu / chat
  → OpenClaw Gateway (control plane: route, bind, deliver, policy)
      → @openclaw/acpx
          → ACP JSON-RPC over stdio
              → adapter (Claude Code ACP / Codex ACP / …)
                  → coding agent process + its own harness (tools/auth/FS)
                      + agent-profiles
```

**OpenClaw = control plane** (not “another Claude Code”). On the ACP worker
side, **harness = that coding process’s tools/auth/FS**. Plugin tools are
**not** injected into the worker harness by default.

**Remote path (post-Happy / post-Tailscale phone shell).** WezDeck no longer
wraps desktop agent panes with Happy for phone sync, and the host no longer
maintains a Tailscale phone-ssh path. Remote agent work goes through **this
control plane** (Feishu → Gateway → C1/C2/C3, including ACP). Temporary help on
a live tmux pane uses the OpenClaw **tmux** skill (capture / send-keys), not a
second full client. History and retired phone notes:
[`mobile-access.md`](../../docs/mobile-access.md) · evolution **v6**.

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
| E (later) | Bound chat delivery + worker harness; still ≠ 1:1 Claude TUI |

Upstream: [ACP agents](https://docs.openclaw.ai/tools/acp-agents),
[ACP setup](https://docs.openclaw.ai/tools/acp-agents-setup),
[CLI backends](https://docs.openclaw.ai/gateway/cli-backends).

