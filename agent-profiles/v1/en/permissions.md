---
name: permissions
scope: user
triggers:
  - editing settings.json or settings.local.json
  - deciding whether a command should be pre-approved
  - reviewing or pruning the allowlist
  - choosing between allowlist entry and PreToolUse hook
tags: [permissions, host-config, allowlist, safety]
---

# Permissions

## When To Read

When adding, removing, or auditing entries in any Claude Code `settings.json`
/ `settings.local.json`, or when deciding whether a recurring command should
be pre-approved instead of prompting each call.

## When Not To Read

When the task is a one-off command that will not recur. Pre-approval is for
patterns, not single invocations — see [permissions-30].

## Scope

- [permissions-01] This file defines decision policy for permission entries.
  The host (Claude Code) reads `settings.json`; this file teaches the agent
  how to *propose, place, and prune* those entries.
- [permissions-02] Companion to [tool-use-26] / [tool-use-27]: those rules
  say allowlists belong in host config; this file defines the standards for
  what goes into them.

## Layering

- [permissions-10] User-level `~/.claude/settings.json` carries
  stack-agnostic, machine-stable rules: read-only investigation verbs,
  generic `git` read subcommands, common documentation domains. Anything
  that would still be safe in a different repo belongs here.
- [permissions-11] Project-tracked `.claude/settings.json` carries rules
  specific to the repository that any teammate or fresh checkout needs:
  project script paths, project-specific tooling.
- [permissions-12] Project-local `.claude/settings.local.json` is for the
  current operator's transient experiments. Treat it as scratch — entries
  here should either be promoted up a layer or garbage-collected.
- [permissions-13] When the same rule appears at two layers, delete the
  lower one. Duplicates rot independently.
- [permissions-14] When proposing a new entry, name the layer explicitly
  ("add to user-level" / "add to project-tracked") and justify the choice
  against [permissions-10..12].

## Pre-Approval Criteria

Pre-approve a Bash / Skill / Web pattern only when ALL hold:

- [permissions-20] Read-only or strictly local-reversible (no shared-state
  mutation, no network publish).
- [permissions-21] No arbitrary-code-execution surface — `bash -c *`,
  `sh -c *`, `python -c *`, `python3 *`, `node -e *`, `node *`,
  `perl -e *`, `eval`, `xargs sh`, `ssh ...` all fail this and must
  never be blanket-approved.
- [permissions-22] No privilege elevation (`sudo *`, `doas *`, admin
  shells, registry writes outside marker-known wrappers); see
  [platform-actions-38].
- [permissions-23] Pattern is narrow enough that an attacker controlling
  one argument cannot pivot. Prefer `Bash(rg *)` over patterns that allow
  shell-substitution or piping into another shell.
- [permissions-24] Effect is observable. Silent side effects warrant a
  prompt even when reversible ([platform-actions-35]).

## Patterns That Must Stay Prompted

Even if frequent, never pre-approve:

- [permissions-30] Force / destructive ops: `git push --force`,
  `git reset --hard`, `git clean -fd`, `git branch -D`, `rm -rf` outside
  known-safe scratch dirs ([vcs.md], [platform-actions-28]).
- [permissions-31] Privilege elevation: `sudo *`, `doas *`, `runas *`.
- [permissions-32] Arbitrary-code wrappers (see [permissions-21]).
- [permissions-33] Network publishers: `gh pr create`, `gh release
  create`, `gh issue create`, mail / chat senders, anything that mutates
  shared state.
- [permissions-34] Filesystem `chmod` / `chown` on paths outside the
  current project root.
- [permissions-35] Hook-bypass flags: `--no-verify`, `--no-gpg-sign`,
  `--force`, `--yes`, `-y` (see [platform-actions-39]).

## Hygiene

- [permissions-40] One-shot commands that drifted into
  `settings.local.json` during a session are noise, not security. Sweep
  them out periodically or run the host's own pruning skill (e.g.
  `fewer-permission-prompts`).
- [permissions-41] Before adding an entry, search the existing allowlist
  for an overlapping or wider rule; consolidate instead of stacking.
- [permissions-42] Group entries by domain (`git`, `tmux`, `wezterm`,
  `web`, `mcp__*`) within each layer for readability.
- [permissions-43] When elevating an entry from `.local.json` to tracked
  `.claude/settings.json`, the rule should be reviewable in a diff —
  name explicit paths, not regex soup.
- [permissions-44] Tag user-level entries that have a clear safety
  rationale ("read-only investigation", "documentation domain") in the
  proposal message; this is the audit trail [permissions-43] expects.

## Hooks Over Allowlist

- [permissions-50] When the same shape recurs across many specific
  arguments (e.g. "any read-only `tmux ...` query"), prefer a PreToolUse
  classifier hook that approves by regex over an exploding allowlist.
- [permissions-51] Hooks must be dry-runnable and visibly logged
  ([automation-25..30]); a wrong regex in a hook is harder to spot than
  a wrong glob in JSON.
- [permissions-52] A hook that pre-approves must still respect
  [permissions-20..24]; hook scope is not an excuse to widen the
  pre-approval criteria.

## Subagent Inheritance

- [permissions-60] Subagent permission boundaries do not auto-inherit
  from the parent. State the boundary explicitly in the brief
  ([tool-use-37]).
- [permissions-61] Grant subagents the minimum read-only set in their
  agent definition rather than the parent's full allowlist; child
  authority should not exceed parent authority.

## Reporting

- [permissions-70] When proposing changes to an allowlist, output a diff
  framed as "add / remove / move", grouped by layer, with a one-line
  rationale per entry ([permissions-44]).
- [permissions-71] When a permission prompt fires unexpectedly, do not
  silently retry under a wider rule — surface the prompt and let the
  user decide whether the rule needs broadening or the call needs
  changing ([tool-use-24..25]).

## Proactive Promotion

- [permissions-80] When a Bash / Skill / Web call triggers a host
  permission prompt and the user approves it, agent should — at the end
  of the same turn — assess whether the pattern qualifies under
  [permissions-20..24] and has appeared at least twice in the current
  session. A single approval is treated as a one-shot; only repeat
  occurrences signal a real pattern worth promoting ([permissions-86]).
- [permissions-81] If yes, propose promotion in one English line that
  names BOTH the pattern AND the target layer, with a one-clause
  rationale:

      "Promote `<pattern>` to <layer>? (reason: <why this layer>)"

  Always phrase the prompt-to-promote in English regardless of the
  surrounding conversation language. Pick the layer per
  [permissions-10..12]:

  - **user-level** `~/.claude/settings.json` — when the pattern is
    stack-agnostic and would still be safe in any other repo
    (e.g. `rg`, `git status*`, doc-domain WebFetch).
  - **project-tracked** `.claude/settings.json` — when the pattern
    references this repo's scripts, tools, or paths and any teammate
    on a fresh checkout would need it (e.g. `scripts/dev/foo.sh`,
    project-specific binary paths).
  - **project-local** `.claude/settings.local.json` — only when the
    pattern is operator-specific transient experimentation; default
    answer is to NOT propose this layer (treat `.local.json` as
    scratch, [permissions-12]).

- [permissions-82] If the pattern could fit either user-level or
  project-tracked, prefer user-level — narrower-scope rules are easier
  to add later than to retract. State the alternative in the proposal
  ("user-level; or project-tracked if you want it scoped to this repo").
- [permissions-83] Do not edit any settings.json without explicit
  confirmation. Promotion is a user-authorized step, not an agent
  decision ([automation-30], [platform-actions-41]).
- [permissions-84] Skip the prompt-to-promote when: the call is
  one-shot (specific absolute path, ad-hoc one-line grep), the pattern
  fails any of [permissions-30..35], or the user has indicated this
  turn is exploratory.
- [permissions-85] When proposing, also check whether an existing
  allowlist entry already covers a wider pattern ([permissions-41]).
  If so, surface it instead of stacking — "Already covered by
  `<wider>`, no new entry needed" beats a redundant entry.
- [permissions-86] Recurrence gate: do not propose promotion on the
  first approved prompt for a pattern. Track approved patterns within
  the session; only propose when the same pattern (matched by the
  proposed glob, not by exact argv) has been approved at least twice
  in the current session. Reset the counter at session start.
- [permissions-87] Decline memory: when the user declines a promotion
  proposal in the current session, do not raise it again for the same
  pattern in that session. Treat the decline as scope-bounded — across
  sessions the proposal may resurface once the recurrence gate fires
  again, since the user's stance may have changed.
