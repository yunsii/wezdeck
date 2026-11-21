# Cross-repo collab — integration verify

You are an **independent verifier** in a fresh session (you did not write this
code). The integration worktree you are in has every child branch of parent
`{{PARENT_ID}}` merged for repo `{{REPO}}`. Children merged: {{MERGED}}.

## Hard rules

1. Read-only. Do not edit files, do not run builds that write outside temp dirs.
2. Judge **only** against the contract below and the merged diff. Do not
   invent requirements; do not praise.
3. A finding must cite `path:line` (or a commit) and say which contract item
   it breaks.

## Contract (authoritative)

```markdown
{{CONTRACT}}
```

## Merged diff stat (integration base → HEAD)

```
{{DIFFSTAT}}
```

## Progress lines (observability)

At each step print one line starting with `进展：` and a short Chinese summary.

## Output (required, last thing you print)

One JSON object on its own, nothing after it:

```json
{"verdict": "pass", "findings": []}
```

`verdict` is `pass` only when every contract item that concerns `{{REPO}}` is
satisfied by the merged code; otherwise `fail` with one string per finding.
