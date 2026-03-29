# Commit Guidelines

Use this doc only when you are preparing a commit or reviewing commit readiness.

## Goal

Use a commit format that is:

- easy to scan in `git log`
- specific enough to explain intent
- small enough for review and later rollback

This repo uses a lightweight Conventional Commits style with repo-specific scopes.

## Commit Shape

Preferred title format:

```text
<type>(<scope>): <description>
```

Scope is optional when it does not add useful information:

```text
<type>: <description>
```

## Allowed Types

- `feat`: new behavior or capability
- `fix`: bug fix or behavior correction
- `docs`: documentation-only changes
- `refactor`: code restructuring without intended behavior change
- `perf`: performance improvement
- `test`: test additions or test-only changes
- `chore`: maintenance, tooling, or housekeeping that does not fit the types above

## Scope Guidance

Use the narrowest stable scope that explains the change area.

Portable examples:

- `api`
- `auth`
- `ui`
- `docs`
- `scripts`

If a file-oriented scope is clearer, use that instead, such as:

- `server.ts`
- `build.sh`
- `login-form`
- `deploy`

## Repo Scopes

For this repository, the most useful stable scopes are:

- `workspaces`
- `wezterm`
- `tmux`
- `titles`
- `ui`
- `scripts`
- `docs`
- `agents`

If a repo-specific file-oriented scope is clearer, use that instead, such as:

- `workspaces.lua`
- `tmux.conf`
- `open-project-session`
- `run-managed-command`

## Title Rules

- Keep the title to one line.
- Use lowercase after the prefix unless capitalization is required by a proper name or acronym.
- Use imperative phrasing.
- Do not end the title with a period.
- Keep the title concise; around 50 characters is the soft limit.

Good examples:

- `docs(api): clarify webhook retry behavior`
- `fix(auth): avoid token refresh loop`
- `feat(ui): add compact table density`

Avoid:

- `Update stuff`
- `Fix bug`
- `docs: Clarify Commit Rules.`

## Body Rules

Add a body when the reason is not obvious from the diff or title.

Body structure:

1. State the problem or current limitation.
2. Explain why this approach is the right fix.
3. Note important side effects, constraints, or follow-up implications if needed.

Body guidance:

- Separate title and body with one blank line.
- Prefer present tense when describing the current problem.
- Keep the body focused on why, not a line-by-line diff narration.

## AI Collaboration Metadata

When AI-assisted development details add review value, append an `AI Collaboration:` block after the main body.

You should strongly prefer adding the block when any of the following are true:

- the work required repeated debugging or multiple failed implementation attempts before the root cause was identified
- the final fix depends on constraints outside the repo, such as shell rc files, OS environment behavior, or toolchain/runtime quirks
- the final diff is small relative to the investigation needed to make it correct
- meaningful human course-corrections changed the implementation plan more than once

Preferred shape:

```text
<type>(<scope>): <description>

<problem / motivation>
<approach / rationale>
<important side effects if any>

AI Collaboration:
- human-adjustments: 3 (excluding escalation-only interactions)
- hard-parts: missed an edge case in tenant ID normalization
- hard-parts: required repeated layout debugging before the mobile breakpoint stabilized
- ai-complexity: medium
- tools-used: mcp.chrome_devtools, deepwiki-mcp-cli
- skills-used: vercel-react-best-practices
```

Rules:

- Keep the title and main body readable without the AI block.
- Use the AI block to capture process context, not a full debug diary.
- Omit fields that do not add signal for the current commit.
- Keep the AI block flat: use single-level bullets only; do not nest bullets under fields such as `hard-parts`.

### Field Definitions

- `human-adjustments`: count meaningful human interventions that changed the plan, prompt, code, or commit content. Exclude approval-only or escalation-only interactions.
- `hard-parts`: short summaries of non-obvious constraints, missed edge cases, or problems that required repeated debugging to resolve.
- `ai-complexity`: one of `low`, `medium`, or `high`.
- `tools-used`: external helpers that materially affected the result, such as MCP tools or repository-specific CLIs.
- `skills-used`: Codex skills that materially affected the result.

### Complexity Guidance

- `low`: narrow change, few constraints, little or no debugging.
- `medium`: multiple files or non-obvious constraints, with meaningful validation or iteration.
- `high`: cross-cutting change, strong constraints, or repeated human correction and debugging.

### Metadata Quality Rules

- Prefer concrete summaries over vague notes like `debugged a lot`.
- Record only tools or skills that materially influenced the final result.
- Do not include raw escalation logs or approval history in the commit message.
- Keep the AI block short enough to scan in `git log --format=fuller`.

## Commit Splitting

- Split unrelated changes into separate commits.
- Split large changes when the title or body becomes hard to explain cleanly.
- Keep documentation-only changes separate when they are independent.
- If a user-visible behavior change and its required doc update are part of one logical change, they may stay in the same commit.

## Breaking Changes

Use breaking-change markers only when the repo behavior or documented workflow changes incompatibly.

Examples:

```text
feat(api)!: rename webhook event fields
```

```text
feat: change plugin bootstrap flow

BREAKING CHANGE: plugin instances now require an explicit project ID.
```

## Repo-Specific Rules

- Match the current repo history, which already uses `feat:`, `docs:`, and similar prefixes.
- Prefer `docs(agents): ...` for agent-only documentation work.
- Prefer `docs(user): ...` only if a commit changes user docs without changing agent docs.
- For mixed documentation work across user and agent docs, prefer `docs: ...` unless one audience is clearly primary.
- Do not run Git commands that can contend on the index lock in parallel; stage, inspect, and commit in sequence.
- Before committing runtime changes, confirm required sync and validation steps in [`validation.md`](./validation.md).
- Preview the full commit message and get human confirmation before running `git commit`.
- Use [`scripts/dev/commit-with-ai-context.sh`](../../scripts/dev/commit-with-ai-context.sh) when the commit should include AI collaboration metadata.
