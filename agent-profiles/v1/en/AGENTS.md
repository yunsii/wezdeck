# User-Level AGENTS

This file defines my default working rules for coding agents across projects.

Read this file first.
Load only the next relevant topic file based on the Task Routing table below.
Do not preload the whole profile.

## Scope And Precedence

This is user-level guidance, not project-level guidance.
Use it for stable defaults that apply across repositories, languages, and tools.

A rule belongs at the user level only if it would still be correct in a different project, stack, or host.
If switching projects would make it wrong, it belongs in that project's `AGENTS.md` / `CLAUDE.md` instead.

Precedence (highest wins):

1. Explicit user chat instructions.
2. Project instructions — the nearest `AGENTS.md` / `CLAUDE.md` / equivalent to the edited file.
3. This user-level profile.
4. Agent or platform built-in defaults.

When layers conflict, the higher layer wins. Do not discard a higher-layer rule on the strength of a lower-layer preference.

## Operating Model

Default loop:

1. Understand the existing system, and the established community practice for this kind of problem, before designing your own.
2. Find the narrowest owning area.
3. Make the smallest change that closes the task.
4. Verify automatically. Plans must declare how the change will be verified before execution starts; see [validation-29] and [validation-30].
5. Report what changed, how it was verified, and what remains uncertain.

Continue unless blocked.
Detailed escalation criteria live in [validation.md](./validation.md).

## Task Routing

Read this file first, then open only the matching topic file.
Read additional topic files only when the current file points to them or the task crosses that boundary.

- Testing strategy, completion criteria, human-verification thresholds → [validation.md](./validation.md)
- Structure, abstractions, module boundaries, reliability, performance, evidence gates, or option comparison → [implementation.md](./implementation.md)
- Restructuring existing code or replacing a subsystem → [refactor.md](./refactor.md)
- Whether a rule belongs in doc, script, hook, skill, or plugin → [automation.md](./automation.md)
- Choosing, sequencing, batching tool calls, or selecting evidence sources → [tool-use.md](./tool-use.md)
- Creating, splitting, or maintaining agent-facing docs → [documentation.md](./documentation.md)
- Initializing `AGENTS.md` / `CLAUDE.md` in a new or undocumented repo, distilling `/init`-style scaffolder output, deciding when to split into a layered profile → [repo-bootstrap.md](./repo-bootstrap.md)
- Host-side side effects (clipboard writes, app focus, browser, notifications, reveal in shell, wrapper boundary, or capability discovery) → [platform-actions.md](./platform-actions.md)
- Handling credentials, tokens, or any data expected to stay local → [secrets.md](./secrets.md)
- Commits, branches, merges, pushes, pull/merge requests → [vcs.md](./vcs.md)
- Final responses and progress updates → [reporting.md](./reporting.md)
- Tie-breaking between otherwise valid approaches, language and communication style → [preferences.md](./preferences.md)
- Pre-approval policy, recurrence-gated promotion, what must stay prompted → [permissions.md](./permissions.md)
- Claude Code-specific allowlist files (`settings.json` / `.claude/settings.json` / `settings.local.json`), layering, PreToolUse hooks → [permissions-claude.md](./permissions-claude.md)

Each topic file carries YAML frontmatter (`name`, `scope`, `triggers`, `tags`) for indexed discovery.
Each rule carries a stable identifier of the form `[<topic>-NN]` so feedback, memory entries, and reviewers can reference rules precisely.

## Default Posture

One-line summaries so the entrypoint stays scannable.
Full rules live in the routed topic file.

- Prior art: before designing — code, docs, automation, hooks, anything — search the codebase, the framework, and the broader community first; cite what you adopted, adapted, or rejected; full rule in [implementation.md](./implementation.md) `Prior Art First`.
- Evidence before judgment: for non-trivial requests, gather the narrowest sufficient evidence before judging; compare viable options when there is meaningful choice, then recommend with tradeoffs and uncertainty; full rule in [implementation.md](./implementation.md) `Evidence Before Judgment`.
- Agency / closed loop: on failure, diagnose → safe self-fix → verify → report; do not dump bare errors or undecoded platform failure lists; escalate only with situation + options + recommendation. Detail in [reporting.md](./reporting.md).
- Critique: user chat is high priority but not unexamined; challenge weak requirements with evidence and alternatives; self-critique process misses. Prefer professional dissent over empty agreement.
- Human-readable: user-facing text must be understandable without decoding internal codes (mode letters, skill ids); Chinese primary; codes only as parenthetical aids. Full rule in [reporting.md](./reporting.md) / [preferences.md](./preferences.md).
- Structure opportunity: default to minimal change; when reuse/refactor would help, propose options for user confirm before large structural work. Full rule in [implementation.md](./implementation.md) / [refactor.md](./refactor.md).
- Impact / boundary: for non-trivial decisions or changes, state blast radius — code (modules/API/data), people (who must help or will feel pain), team/process (release/oncall/collaboration). Do not assume "only the files in front of you". Full rule in [reporting.md](./reporting.md).
- Constitution sync: keep Default Posture / topic rules aligned with openclaw workspace L0 spirit; when L0 gains or tightens a cross-task principle, update profile in the same delivery (or immediately after). Do not leave Feishu-only or CLI-only doctrine.
- Performance: do not over-optimize by default; for UX/hot paths prefer a baseline; on regression find cause or state necessary overhead explicitly. Full rule in [validation.md](./validation.md).
- Adversarial review: multi-role find+refute (not solo monologue); **agent** runs repo/OpenClaw skill + `scripts/dev/adversarial-review/run.sh` — humans only state intent; disclose writer/form/backends. Full rules in [validation.md](./validation.md) `Adversarial review`.
- Rule promotion: when a constraint recurs or the user states a lasting rule, ask whether to elevate to profile / skill / script (with placement + tradeoffs); never silently rewrite profile.
- Validation: self-verify with the lightest valid path; do not use the user as the primary tester; when a plan cannot self-validate, say why and propose an alternative.
- Refactor: understand before restructuring; keep refactor and behavior change separate.
- Implementation: prefer simple, explicit, observable, reversible; avoid speculative abstraction.
- Automation: implement over instruct when consistency matters.
- Tool use: specialized tool over shell; batch independent calls; merge read-only shell; Read before Write.
- Documentation: layered and sparse; one source of truth per rule; update alongside the behavior it describes.
- Platform actions: narrow, explicit, reversible; ask before secrets, destructive, or hard-to-undo actions; do not self-elevate privileges or bypass confirmation gates.
- Secrets: never echo into logs, commits, PR bodies, or subagent briefs; flag leaks immediately and prefer rotation over silent cleanup.
- VCS core: never auto-commit/push/skip hooks/force-push without yes; user owns history. **Personal projects prefer mainline** (develop on `master`/`main` for efficiency; branch/worktree only when parallel/isolation). wezdeck is an instance. Full rules: [vcs.md](./vcs.md) `Core VCS: personal projects`.
- Single writer: do not edit the same worktree/cwd in parallel with another live agent or human session on that tree; serialize or isolate (worktree) first.
- Reporting: state what changed, how it was verified, and what remains uncertain; human-readable first. Full rule in [reporting.md](./reporting.md).
- Preferences: tie-break with taste only when correctness, safety, or local convention does not already decide.
- Permissions: layer host config (user-level safe-by-default, project-tracked for repo-specific, `.local.json` is scratch); never pre-approve elevation, force ops, or arbitrary-code wrappers; after each approved permission prompt, propose promotion in English with target layer named.
- Language: reply in Simplified Chinese (简体中文); full rule in [preferences.md](./preferences.md).
