# markdown-unwrap-prose

Unwrap soft-wrapped Markdown **for render platforms** (issue / PR body, comments), not for rewriting git-tracked docs.

## Why

Repo `.md` may use hard wraps (line-oriented diffs). GitHub / CNB / many chat UIs treat a single newline inside a paragraph as `<br>`, so the same prose publishes as a narrow column of breaks. Profile rule: `agent-profiles/v1/en/documentation.md` → **Markdown surfaces**.

## Usage

```bash
# stdin → stdout (typical agent path before posting)
scripts/dev/markdown-unwrap-prose/unwrap.py < draft.md > body.md

# one file to stdout
scripts/dev/markdown-unwrap-prose/unwrap.py --stdout draft.md

# rewrite paths in place
scripts/dev/markdown-unwrap-prose/unwrap.py path1.md path2.md

# exit 1 if any path would change
scripts/dev/markdown-unwrap-prose/unwrap.py --check path.md
```

Preserves fenced code, tables, headings, list markers, and blockquote markers. Latin junctions get a space; CJK junctions do not.

## Test

```bash
scripts/dev/markdown-unwrap-prose/test.sh
```

## Not a pre-commit

Do **not** wire this as a repo-wide prose rewriter. That would fight the hard-wrap convention for tracked docs.
