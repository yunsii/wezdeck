---
name: documentation
scope: user
triggers:
  - creating agent-facing docs
  - splitting or revising docs
  - doc layering decisions
  - Markdown hard-wrap versus render-platform long lines
  - issue or PR or comment body formatting
tags: [documentation, layering, progressive-disclosure, markdown-surfaces]
---

# Documentation

## When To Read

When creating, splitting, or revising agent-facing documentation.

## When Not To Read

When editing code without touching its docs, or when only fixing typos / small wording inside an existing doc that already follows the layering rules.

## Default

- [documentation-01] Documentation should reduce decision cost, not become a second codebase.
- [documentation-02] Keep it layered, sparse, and easy to navigate.

## Layering

Use this structure:

- [documentation-03] entrypoint docs for hard rules and routing
- [documentation-04] topic docs for detailed domain guidance
- [documentation-05] local docs for environment- or project-specific constraints
- [documentation-06] reference docs for deep background only when necessary

[documentation-07] Do not put everything in the entrypoint.

## Progressive Disclosure

[documentation-08] Load the minimum context needed for the current task.

Start with:

- [documentation-09] the main entrypoint
- [documentation-10] one matching topic file

Load more only when:

- [documentation-11] the current doc points to it
- [documentation-12] the task crosses boundaries
- [documentation-13] proceeding without it would be risky

## Write

Good documentation is:

- [documentation-14] specific
- [documentation-15] stable
- [documentation-16] actionable
- [documentation-17] close to the decision point
- [documentation-18] easy to skim

Each topic file should ideally answer:

- [documentation-19] when to read it
- [documentation-20] what rules apply
- [documentation-21] what to prefer
- [documentation-22] what to avoid
- [documentation-23] how to validate

## Avoid

- [documentation-24] long narrative history
- [documentation-25] vague slogans
- [documentation-26] tool trivia that changes often
- [documentation-27] duplicated rules across many files
- [documentation-28] instructions that should be automation instead

## Maintenance

- [documentation-29] When a file grows too broad, split by decision domain, not by audience.
- [documentation-30] Keep one source of truth for each rule.
- [documentation-31] Other files should route to it, not restate it.
- [documentation-32] When a change alters behavior, interfaces, or workflows that an existing doc describes, update that doc in the same edit.

## Size budgets (soft numbers)

Numeric gates belong in automation when a repo provides them. Defaults used by wezdeck `scripts/dev/repo-hygiene/budgets.conf` (adjust per repo):

- [documentation-35] Entrypoint `AGENTS.md`: soft ~150, hard ~220 (aligns with [repo-bootstrap](./repo-bootstrap.md) sweet spot).
- [documentation-36] Topic docs: soft ~400, hard ~600 lines; presentations may be higher.
- [documentation-37] Prefer splitting at soft; block **new** files or **newly crossing** hard in pre-commit when the repo installs the hygiene hook. Historical over-hard files may be allowlisted so day-to-day commits are not frozen on old debt.
- [documentation-38] Broken relative markdown links are a hard fail whenever automation is present; do not leave routes to deleted files.

## Markdown surfaces (repo vs render platform)

Two surfaces share Markdown syntax but not the same newline contract. Mixing them is a recurring publish bug (wide screens show a narrow left strip of hard breaks).

- [documentation-40] **Git-tracked Markdown** (repo `.md` under version control): hard-wrapped / semantic line breaks are fine. Repo renderers treat a soft break inside a paragraph as a space; line-oriented diffs stay readable.
- [documentation-41] **Render-platform Markdown** (issue / PR description, PR & ticket comments, many chat / Feishu rich-text Markdown bodies, CNB / GitHub comment UIs): write **paragraph-long lines**. Those UIs commonly enable GFM-style breaks: a single newline inside a paragraph becomes `<br>`, so repo-style hard wraps become visible fractures.
- [documentation-42] Do **not** paste hard-wrapped repo prose into a render-platform body without unwrapping first. Terminal preview and the source file both look fine; the break only shows after publish.
- [documentation-43] When transforming hard-wrapped source into a render-platform body, preserve structure: leave fenced code blocks untouched; keep each table row on its own line; merge list-item continuation lines into the item; merge blockquote continuation lines. Join English (Latin) word breaks with a single space; join CJK runs with **no** extra space.
- [documentation-44] Prefer the wezdeck helper over hand-editing when the body is non-trivial: `scripts/dev/markdown-unwrap-prose/unwrap.py` (stdin→stdout, or paths; `--check` / `--stdout`). Do **not** run it as a repo-wide pre-commit rewriter — that would fight [documentation-40].
- [documentation-45] PR / issue body rules in [vcs.md](./vcs.md) inherit [documentation-41]–[documentation-44]; chat-facing Markdown in [reporting.md](./reporting.md) does too.

Prior art: GitHub issue/comment renderers treating softbreaks as `<br>` (community discussions since ~2020); unwrap tools such as `markdown-prose-hooks` (2026) for the opposite repo convention — adopted here only as the **outbound** transform, not as a repo prose style.

## Prior Art

- [documentation-33] Before drafting structure, formats, or conventions for agent-facing docs, follow [implementation-45]–[implementation-49] (Prior Art First). Doc structure is a design decision; invent only after the codebase, the format spec (e.g. `agents.md`), and the broader community have been checked.
- [documentation-34] When applying a community pattern, name the source and the year inline ("per the AGENTS.md spec, 2026") so future readers can re-verify; patterns age, especially in the LLM-tooling space.
