---
name: adversarial-review
description: >
  Thin pointer: OpenClaw agents must load workspace skill
  openclaw/workspace/skills/adversarial-review/SKILL.md and run host scripts
  themselves. Humans only state intent (审一下 / 对抗审查).
---

# Adversarial review (runner-side pointer)

**Canonical agent skill:** `openclaw/workspace/skills/adversarial-review/SKILL.md`

That skill tells Main/agents to:

1. Resolve `REPO_ROOT` / worktree
2. Run `scripts/dev/adversarial-review/run.sh` with `--writer …`
3. Paste L0-20 disclosure — **without** asking the human to run the script

Docs: `docs/adversarial-review.md`. Select: `lib/select-backends.sh`.
