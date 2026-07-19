# Adversarial Review (cross-agent) — v0.2

`scripts/dev/adversarial-review/` runs a **cross-agent adversarial code review**
over a diff, in three gates, and classifies findings so you can use the tool to
**recursively improve itself** (dogfood) without silent false confidence.

## What counts as 对抗审查

**Adversarial = multi-role.** Minimum:

1. **Find / reviewer** — guilty-until-proven; produce findings with failure scenarios  
2. **Refute / refuter** — opposite burden; try to kill each finding  
3. **Repro** (recommended) — empirical check for CONFIRMED items  

- Prefer **different** agent families (e.g. Claude-TUI × Codex-Grok-profile).  
- If only **one** model is available: still run **two roles** (two calls, opposite
  prompts). Label **SINGLE-MODEL**. Do **not** skip refute.  
- A single monologue (one Main-Grok essay) is **设计批判**, **not** 对抗审查.

Orchestration may be `run.sh` or Main spawning two ACP/TUI turns with distinct
role prompts. Same binary twice with different stance **is** multi-role;
same chat turn with no role split **is not**.

## Reporting disclosure (mandatory)

Any Feishu/chat claim of「对抗审查」**must** include this block (OpenClaw L0-20).
Never ship conclusions alone. Never use the title if refute role was omitted.

```text
## 对抗审查披露
- 形态: 三门全量 | 多角色·单模型
- reviewer 全名 / 立场: …
- refuter 全名 / 立场: …
- repro: 已跑 | 跳过（理由）
- 命令或范围: run.sh … | Main 编排两次 …
- skipped_gates: … | 无
- 关键结论: 每条绑定 find / refute / repro
```

| 形态 | 何时使用 | 可否写 cross-agent |
| --- | --- | --- |
| **三门全量** | find+refute+repro，且 reviewer≠refuter 家族 | 可以 |
| **多角色·单模型** | find+refute（±repro），同家族/同后端 | 否；标 SINGLE-MODEL |
| **设计批判** | 单角色分析 | **不要**叫对抗审查 |

Full backend names: see `openclaw/docs/agent-architecture.md` and
`openclaw/scripts/agent-matrix-status.sh`.

Design rationale (why three gates, why empirical repro matters more than debate)
is unchanged from v0.1; v0.2 tightens **contracts**, **naming**, **sandboxing**,
and **self-application**.

## The three gates

| Gate | Who | What |
| --- | --- | --- |
| 1 · Find | `--reviewer` | Finds defects under a **guilty-until-proven** stance; every finding must carry a concrete `failure_scenario`. |
| 2 · Refute | `--refuter` | A *different* model tries to **refute** each finding; burden of proof is on the finding (unsure → refuted). |
| 3 · Empirical | `--reviewer` + sandbox | For each `CONFIRMED` finding, the model writes a minimal repro script and the orchestrator **runs it in a sandbox that mirrors the reviewed revision/worktree** (not ambient `HEAD`). |

### Modes (survivor definition)

| Mode | Survivors (blockers) | Also reported |
| --- | --- | --- |
| **`strict` (default)** | only `CONFIRMED` **and** `repro.reproduced==true` | `needs_human` (timeout/dangerous/inconclusive); PLAUSIBLE dropped |
| **`advisory`** | same blockers | PLAUSIBLE + needs_human kept in a separate section |

Never claim “survived all three gates” for PLAUSIBLE items — they skip gate 3.

## Usage

```bash
scripts/dev/adversarial-review/run.sh <BASE_REF> [options]

  --reviewer P       backend: claude|codex|codex-gpt|codex-grok (default: claude)
  --refuter P        backend alias (default: codex → codex-gpt)
  --critic P         deprecated alias for --refuter
  --head REF         diff endpoint                         (default: HEAD)
  --mode MODE        strict | advisory                     (default: strict)
  --min-severity L   critical|high|medium|low              (default: low)
  --json             machine-readable output
  --dry-run          print the planned gates, call no agents
  --fail-on-finding  exit 10 if any strict survivor

scripts/dev/adversarial-review/run.sh selfcheck [claude|codex-gpt|codex-grok ...]
scripts/dev/adversarial-review/run.sh dogfood [--mode MODE] [options]
```

Examples:

```bash
# last commit, Claude finds, Codex+Grok refutes (recommended when GPT blocked)
run.sh HEAD~1 --reviewer claude --refuter codex-grok

# Claude finds, native Codex/GPT refutes (when account allows GPT)
run.sh HEAD~1 --reviewer claude --refuter codex-gpt

# advisory report for humans (includes PLAUSIBLE)
run.sh origin/master --mode advisory --reviewer claude --refuter claude

# recursive self-review of this tool's working tree
run.sh dogfood --mode strict --fail-on-finding

# provider JSON round-trip
run.sh selfcheck claude
```

**Stage 0 auto-skips** diffs that are docs/tests only.

## Recursive self-optimization (dogfood)

Intended loop (human or agent supervised — **no autonomous rewrite loop**):

```text
1. change scripts/dev/adversarial-review (or claw-worktree path core)
2. run.sh dogfood --mode strict
3. read survivors / needs_human
4. apply targeted fixes
5. re-run dogfood until survivors empty (or accept needs_human)
6. stop — do not auto-commit or unbounded multi-agent rewrite
```

`dogfood` scopes the diff to:

- `scripts/dev/adversarial-review/**`
- `docs/adversarial-review.md`
- `openclaw/scripts/claw-worktree.sh` (path core often co-evolves)

Stopping conditions (hard):

- max 3 dogfood→fix cycles per session unless a human re-authorizes
- never `git commit` / `git push` from inside repro scripts
- never treat SINGLE-MODEL (refuter unavailable) as full cross-agent success

## Structure

```
scripts/dev/adversarial-review/
  run.sh                     three-gate orchestration (agent-agnostic)
  lib/provider.sh            ONLY agent-specific code
  lib/findings-schema.json   inter-stage JSON contract (enforced)
  prompts/{critic,refute,repro}.md
docs/adversarial-review.md   this file
```

## Backend aliases (three review paths)

These names are **review backends**, not OpenClaw ACP harness ids (`claude` /
`codex` only at the ACP layer). Grok is never `spawn grok`; it is **Codex +
profile/model**.

| Alias | Meaning | Host config used | Typical role |
| --- | --- | --- | --- |
| `claude` | Claude Code CLI | `~/.claude` | find / repro |
| `codex` / `codex-gpt` | Codex native default model (GPT when account allows) | host `~/.codex` default | refute or second opinion |
| `codex-grok` | Codex `--profile grok` + `grok-4.5` | host `~/.codex` + `grok.config.toml` | Grok-side refute / matrix |

**OpenClaw ACP isolation** (`~/.openclaw/acpx/codex-home`) is for Feishu
`/acp spawn codex` only. This review tool **must not** set `CODEX_HOME` there,
so native interactive Codex stays untouched.

### Recommended matrices

| Stage | reviewer | refuter | Notes |
| --- | --- | --- | --- |
| Now (proxy GPT often 404) | `claude` | `codex-grok` | Real cross-stack: Claude vs Grok |
| When GPT account works | `claude` | `codex-gpt` | Claude vs GPT |
| Optional third matrix | `codex-gpt` | `codex-grok` | Same harness, **different models** — full gate 2 runs |

If gate 2 is skipped (unavailable or same family), results are **SINGLE-MODEL**
— never claim full cross-agent success.

## Provider status

- **Claude** — `selfcheck claude` expected green when Claude Code is logged in.
- **codex-gpt** — host Codex default; on some proxy account groups `gpt-5.5` returns
  404 → mark unavailable / SINGLE-MODEL, do not fake green.
- **codex-grok** — host `codex -p grok -m grok-4.5`; preferred refuter when GPT is
  blocked. Uses host profile files, not ACP `CODEX_HOME`.
- Gate 2 skip is always **reported** (`skipped_gates`); never silent cross-agent claim.

## Safety

- Reviewer/refuter generation run **read-only** (Claude plan mode + read tool allowlist).
- Repro scripts run in a **detached sandbox worktree that matches the reviewed tree**:
  - normal range `BASE..HEAD_REF` → checkout **`HEAD_REF`** (not whatever the agent cwd HEAD is)
  - `dogfood` / `WORKTREE` → checkout **`BASE`** (usually `HEAD`), then **copy** the
    reviewed paths from the live worktree (so uncommitted edits are present)
  - `trap` on EXIT/INT/TERM/HUP removes the sandbox worktree (no leak on interrupt)
  - 60s timeout; expanded danger-pattern scan (network, sudo, push/publish, inline
    eval, …); flagged scripts are not executed (`needs_human`)
  - best-effort: sandbox `.git` is made read-only before exec
- This is **not** a full OS sandbox (no bubblewrap/seccomp). Treat repro as
  semi-trusted automation; do not enable auto-fix loops without a human.
- Nothing is auto-fixed. Survivors are for you (or a supervised agent) to adjudicate.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | completed; no strict survivors (or fail-on not set) |
| 1 | usage |
| 2 | reviewer provider unusable |
| 3 | internal (e.g. invalid stage1 JSON) |
| 10 | `--fail-on-finding` and ≥1 strict survivor |

## Open questions

1. Codex CLI binary + `exec --json` flags on this host (`selfcheck codex`).
2. Project-specific verify conventions for gate 3 beyond shell/unit checks.
3. Cost controls for huge monorepo diffs (`--paths` future).

## What it is NOT

- Not a style/simplification pass (`/simplify`).
- Not an unbounded self-modifying agent. Dogfood is a **supervised** loop.
- Not a substitute for human ownership of security-critical merges.
