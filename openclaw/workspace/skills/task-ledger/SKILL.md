---
name: task-ledger
description: >
  Ledger development tasks to Feishu Base via dev-task-ledger.sh.
  Allowlist: wezdeck (+ optional team roots in local config) (wezterm-config). Use on accept/confirm/close
  of coding work; not for pure Q&A.
---

# Development task ledger (Feishu Base)

## Hard rules

1. Development tasks **must** target an **allowlisted** root (see Path guard):
   **团队仓** or **wezdeck** / wezterm-config. Do not hard-code another
   machine's `/home/...` paths in prompts or commits.
2. If the user asks for another repo: **do not** `open` a ledger row as accepted
   work; refuse and explain allowlist policy.
3. When accepted:
   - `open` → `confirm` (if required) → `close` (`done`/`failed`/`cancelled`/`blocked`)
4. Never write secrets into the ledger.
5. Final reply **must** include `task_id`.
6. If CLI fails, say so; do not invent `task_id`.
7. When the request has a clear **需求提出人** (product / user who asked):
   record them on open/update with `--requester-id <ou_…>` (preferred).
   Feishu person field name: **需求提出人**. Do not leave it blank when known.
8. **Order with worktree:** `open` first (may still point at primary repo path);
   after claw worktree exists, `update` cwd/分支 **before** claiming work started
   in that tree. Never `close` without a real `task_id` from CLI.
9. Pure Q&A: do not open a row. As soon as the user accepts **implementation**,
   open before assess/create (same turn is OK if open is first).

## Path guard

- Local env `OPENCLAW_TASKS_ALLOWED_ROOTS` (colon-separated) overrides defaults.
- Defaults (portable): wezdeck (+ optional team roots in local config) roots under `$HOME/work` /
  `$HOME/github/wezterm-config` (see `dev-task-ledger.sh` `DEFAULT_ALLOWED_ROOTS`).
- CLI rejects `--repo` / `--cwd` outside the allowlist.

## CLI

```bash
# from wezterm-config checkout, or $WEZTERM_REPO if set
./openclaw/scripts/dev-task-ledger.sh open \
  --title "…" \
  --repo "$HOME/work/team-repo" \
  --cwd "$HOME/work/team-repo" \
  --scope "packages/… or apps/…" \
  --acceptance "pnpm --filter … test" \
  --risk low|medium|high \
  --source feishu \
  --confirm-required 1 \
  --requester-id ou_xxx   # 需求提出人 (Feishu open_id); optional --requester "显示名"

./openclaw/scripts/dev-task-ledger.sh update \
  --task-id <uuid> \
  --requester-id ou_xxx

./openclaw/scripts/dev-task-ledger.sh confirm --task-id <uuid>

./openclaw/scripts/dev-task-ledger.sh close \
  --task-id <uuid> \
  --status done|failed|cancelled|blocked \
  --summary "…" \
  --branch "…" \
  --commits "abc1234" \
  --mr "https://…"
```

### 需求提出人

| CLI | Base 列 | 类型 |
| --- | --- | --- |
| `--requester-id ou_…` | `需求提出人` | 人员（单选） |
| `--requester "姓名"` | 仅当没有 open_id 时写入 `record_note` 兜底 | 文本 |

- Prefer open_id from Feishu mention / contact lookup.
- Owner who chats with OpenClaw is **not** automatically the requester; set when the asker is named (e.g. product feedback).

Config: `~/.config/shell-env.d/openclaw-tasks.env` (local only; never commit filled file).

## Flow

1. Path guard → allowlist (团队仓 | wezdeck).
2. `open` (status `open`/`planned`) — may still point at primary repo path;
   capture `task_id` immediately for all later Feishu messages.
3. Plan / worktree 初评 → user confirm when needed → `confirm` if required.
4. Create/reuse **`claw-*` worktree**; `update` ledger `cwd` + `分支`
   (never human `dev-*`/`task-*`/`hotfix-*`).
5. Implement under claw cwd **or** handoff to profile-backed coding agent
   (main still owns close).
6. `close` + report with `task_id` (AGENTS 结果 template).
7. **Ask** reclaim (do not auto-reclaim). Prefer keep for `claw-dev-*`;
   task/hotfix only after user yes.
