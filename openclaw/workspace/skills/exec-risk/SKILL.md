---
name: exec-risk
description: >
  Lightweight safe|write|danger labeling for host shell. Dev-task planning
  still uses agent judgment + AGENTS; this is only for obvious host-exec risk.
---

# Exec risk (simple classifier)

## Two layers (do not confuse)

| Layer | Who decides | Enough for |
| --- | --- | --- |
| **Dev task** | You (agent) + AGENTS / dev-task / worktree 初评 | lifecycle、是否写代码、是否确认计划、是否复用 worktree |
| **Host shell danger** | Optional `claw-exec-classify.sh` + below rules | 明显高危 shell（rm -rf、force-push、curl\|sh、泄密） |

**开发任务内部的 agent 判断够用** for: 需求拆解、选 claw-task/dev/hotfix、出计划、
等用户确认、记账。  
**不够单独当闸门** for: 用户已放行后的任意 shell——仍应用下面 danger 规则
（即使用户开了 `exec.mode=full`）。

## Classifier

```bash
./openclaw/scripts/claw-exec-classify.sh 'ls "$HOME/work/coco-forge"'
# stdout: {"label":"safe|write|danger","reason":"..."}
# exit: 0 safe, 1 write, 2 danger
```

| label | Meaning | Agent behavior |
| --- | --- | --- |
| **safe** | 探路 / 只读 | 直接执行 |
| **write** | 正常开发写 | 直接执行（仍遵守 coco-forge + claw worktree + 不 push main） |
| **danger** | 破坏性 / 强推 / 泄密 / pipe-to-shell | **先飞书说明并问用户**；未确认不执行 |

This is intentionally **simple regex**, not Claude full auto. Extend patterns in the
script when real misses appear.

## With current `exec.mode=full`

OpenClaw will not block at the gateway. **You still must not run `danger` without
user confirmation** — soft gate, but mandatory in this skill.

If policy is later tightened to allowlist/auto, use classify to decide what to
allowlist vs what must stay human-approved.
