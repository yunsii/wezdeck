---
name: adversarial-review
description: >
  Multi-role adversarial code review for allowlisted repos. Agent loads this skill
  and runs host scripts (find → refute → sandbox repro); humans only state intent
  (e.g. 审一下 / 对抗审查). Use when user asks for adversarial review, task
  acceptance recommends review, or runtime code changed before merge.
---

# Adversarial review (agent-operated platform skill)

## Who runs what

| Actor | Duty |
| --- | --- |
| **Human** | Intent only:「对抗审查」「审一下这批改动」「按推荐审查」 |
| **Main / any OpenClaw agent** | **Load this skill → run scripts → disclose results** |
| **Host headless backends** | `claude` / `codex-gpt` / `codex-grok` as find/refute (not ACP by default) |

**Never** tell the user to copy-paste `run.sh` as the primary path.  
**Never** replace this with a solo Main monologue and call it 对抗审查 (that is 设计批判).

## When to load / run

- User asks for 对抗审查 / adversarial review / multi-role review
- Write-task checklist: acceptance suggests review (from 开发方式卡)
- Runtime code/scripts changed on allowlisted repo (wezdeck / team-repo worktree)
- After editing `scripts/dev/adversarial-review` itself → `dogfood`

**Skip:** pure docs/tests-only (runner auto-skips); user explicitly skips with reason.

## Multi-role minimum

| Role | Stance | Runner stage |
| --- | --- | --- |
| find / reviewer | guilty-until-proven | stage 1 |
| refute / refuter | kill weak findings | stage 2 |
| repro | empirical in sandbox | stage 3 |

- Prefer **different families** than the **writer** (strategy B via `--writer`).
- Same capability twice OK → label **SINGLE-MODEL** / degraded; **do not skip refute**.
- Solo essay without opposite roles → **设计批判**, not 对抗审查.

## Paths (resolve from repo root)

Prefer worktree cwd if task is on a `claw-*` tree; else primary allowlisted root.

```text
REPO_ROOT = git rev-parse --show-toplevel   # claw-* or primary
RUN = $REPO_ROOT/scripts/dev/adversarial-review/run.sh
SEL = $REPO_ROOT/scripts/dev/adversarial-review/lib/select-backends.sh
```

If scripts missing (wrong cwd), `cd` to wezdeck primary or the task worktree first.

## Agent procedure (do this; do not hand off to human)

1. **Identify**
   - `cwd` / repo (must be allowlisted write or read-review ok)
   - `BASE_REF` (default: `master` or merge-base with master / task start)
   - **writer** from 开发方式: `main` | `claude` | `codex` | `codex-gpt` | `codex-grok` | `human`
2. **Optional dry probe**
   ```bash
   "$SEL" --writer <writer> --no-probe   # or omit --no-probe for live ping
   ```
3. **Run** (prefer writer-aware; shell via claw-run / exec-risk when required)
   ```bash
   "$RUN" <BASE_REF> --writer <writer> --mode strict
   ```
   Explicit override only if user named backends:
   ```bash
   "$RUN" <BASE_REF> --reviewer claude --refuter codex-gpt --mode strict
   ```
4. **Report** in chat using mandatory disclosure block (below). Honest fail if scripts/backends fail (error-closed-loop).
5. **Do not** claim cross-agent if form is single-model; do not invent green gates.

### Writer → expected pair (strategy B)

| writer | Typical pair when available |
| --- | --- |
| `claude` / Claude-ACP/TUI | `codex-gpt` × `codex-grok` |
| `codex` / Codex-* | `claude` × `codex-gpt` (else × `codex-grok`) |
| `main` / Main-Grok | `claude` × `codex-gpt` |
| `human` | same as global best |

## Mandatory disclosure (paste into 结果)

```text
## 对抗审查披露
- writer: Main-Grok | Claude-ACP | Codex-ACP | human | …
- 形态/form: cross-family | cross-model-codex | single-model-multi-role | …
- form/degraded/reason: (from select-backends / run log)
- reviewer 全名 / 立场: …
- refuter 全名 / 立场: …
- repro: 已跑 | 跳过（理由）
- 命令或范围: run.sh <BASE> --writer … 
- skipped_gates: … | 无
- 关键结论: …（绑 find/refute/repro）
```

## Helper commands (agent-only)

```bash
"$RUN" selfcheck claude codex-gpt codex-grok
"$RUN" dogfood --mode strict --fail-on-finding
"$RUN" <BASE> --writer main --dry-run --no-probe
```

## Don't

- Don't ask the human to run `run.sh` as the main path
- Don't use ACP CODEX_HOME for review (`env -u CODEX_HOME` is inside provider)
- Don't skip refute when claiming 对抗审查
- Don't call solo Main analysis 对抗审查
- Don't force-push; wezdeck personal mainline may push master after green (L0-13/19)

## Related

- Repo thin skill (TUI discovery): `skills/adversarial-review/SKILL.md` (repo root)
- Runner & docs: `docs/adversarial-review.md`, `scripts/dev/adversarial-review/`
- Host TUI doctrine: `agent-profiles/v1/en/validation.md`
- L0-21 disclosure: `AGENTS.md`
- Task hooks: `skills/dev-task/SKILL.md` (acceptance / 审查建议)
- Interaction: `openclaw/docs/agent-interaction.md`
