---
name: adversarial-review
description: >
  Multi-role adversarial code review (platform skill). Agent loads this skill and
  runs the co-located runner (find → refute → sandbox repro); humans only state
  intent (审一下 / 对抗审查). Works for OpenClaw Main and host TUI agents via
  user-level skill links. Use when user asks for adversarial review, acceptance
  recommends review, or runtime code changed before merge.
---

# Adversarial review (platform skill — single source)

**Who runs:** the coding agent (OpenClaw Main / Claude-TUI / Codex-TUI), **not** the human.  
**Never** tell the user to copy-paste `run.sh` as the primary path.  
**Never** replace this with a solo monologue and call it 对抗审查 (that is 设计批判).

This directory is the **only** skill + runner unit. Other paths are **symlinks**
(user-level or in-repo discovery). Do not maintain a second SKILL.md body.

## Who runs what

| Actor | Duty |
| --- | --- |
| **Human** | Intent only:「对抗审查」「审一下这批改动」「按推荐审查」 |
| **Any agent** | **Load this skill → resolve TOOL + TARGET → run → disclose** |
| **Host headless backends** | `claude` / `codex-gpt` / `codex-grok` as find/refute (not ACP by default) |

## When to load / run

- User asks for 对抗审查 / adversarial review / multi-role review
- Write-task checklist: acceptance suggests review
- Runtime code/scripts changed (any git TARGET the agent may review)
- After editing this toolkit itself → `dogfood`

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

## Paths: TOOL vs TARGET (critical)

**Do not** assume `./scripts/dev/adversarial-review` exists in the repo under review.

| Name | Meaning |
| --- | --- |
| **TOOL_HOME** | This skill/runner directory (where `run.sh` lives) |
| **TARGET** | Git repo being reviewed (`--repo` or current git toplevel) |

### Resolve TOOL_HOME (first hit wins)

```text
1. $ADV_REVIEW_HOME                          # explicit override
2. directory of this SKILL.md if run.sh is co-located
3. $WEZDECK_ROOT/scripts/dev/adversarial-review
4. $HOME/github/wezterm-config/scripts/dev/adversarial-review
5. else: fail clearly — "adversarial-review tool not installed; run link-platform-skills.sh"
```

**Never** default to `$TARGET/scripts/dev/adversarial-review` unless that path
actually exists (compat only).

### Resolve TARGET

```text
--repo <path>  if given
else: git rev-parse --show-toplevel from cwd
```

## Context pack v1

Find and refute receive the **same** pack (not bare diff):

- META / INTENT / CHANGESET / DIFF / FILES / NOTES
- `--head WORKTREE` includes uncommitted TARGET changes
- `--intent` or `--intent-file` (else commit message or degraded none)
- Budget: `--max-files` (10) `--max-file-bytes` (40960) `--context-window` (200)
- Optional: `--keep-pack DIR` to retain pack.md for audit

```bash
"$TOOL_HOME/run.sh" HEAD --head WORKTREE --repo "$TARGET" \
  --writer main --intent "what this change is for" --mode strict
```

## Agent procedure

1. **Identify** TARGET cwd/repo, `BASE_REF`, **writer**  
   (`main` | `claude` | `codex` | `codex-gpt` | `codex-grok` | `human`)
2. **Resolve** TOOL_HOME (above). Confirm `"$TOOL_HOME/run.sh"` is executable.
3. **Optional dry probe**
   ```bash
   "$TOOL_HOME/lib/select-backends.sh" --writer <writer> --no-probe
   ```
4. **Run**
   ```bash
   "$TOOL_HOME/run.sh" <BASE_REF> --repo "$TARGET" --writer <writer> --mode strict
   ```
   Explicit backends only if user named them:
   ```bash
   "$TOOL_HOME/run.sh" <BASE_REF> --repo "$TARGET" \
     --reviewer claude --refuter codex-gpt --mode strict
   ```
5. **Report** with mandatory disclosure (below). Honest fail if tool/backends fail.
6. **Do not** claim cross-agent if form is single-model; do not invent green gates.

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
- 命令或范围: run.sh <BASE> --repo <TARGET> --writer …
- skipped_gates: … | 无
- 关键结论: …（绑 find/refute/repro）
```

## Helper commands (agent-only)

```bash
"$TOOL_HOME/run.sh" selfcheck claude codex-gpt codex-grok
"$TOOL_HOME/run.sh" dogfood --mode strict --fail-on-finding
"$TOOL_HOME/run.sh" <BASE> --repo "$TARGET" --writer main --dry-run --no-probe
```

Install / refresh user-level discovery (idempotent):

```bash
# from wezdeck primary
./scripts/dev/link-platform-skills.sh
```

## Don't

- Don't ask the human to run `run.sh` as the main path
- Don't use ACP CODEX_HOME for review (`env -u CODEX_HOME` is inside provider)
- Don't skip refute when claiming 对抗审查
- Don't call solo Main analysis 对抗审查
- Don't assume the skill lives only under the TARGET repo
- Don't force-push; wezdeck personal mainline may push master after green (L0-13/19)

## Related

- Runner (this dir): `run.sh`, `lib/`, `prompts/`
- Docs: `docs/adversarial-review.md` (wezdeck)
- Host doctrine: `agent-profiles/v1/en/validation.md`
- Link installer: `scripts/dev/link-platform-skills.sh`
- L0-21 disclosure: OpenClaw `AGENTS.md`
