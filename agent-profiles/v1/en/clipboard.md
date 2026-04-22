---
name: clipboard
scope: user
triggers:
  - write to system clipboard
  - proactive paste-ready output
tags: [host-effects, clipboard, side-effects, safety]
---

# Clipboard

## When To Read

When the task may write to the user's system clipboard, or when the agent is considering proactively staging paste-ready output.

## When Not To Read

When the task stays entirely within the repository and produces no clipboard side effect. General host-side wrapper policy (boundary, discovery, failure modes) lives in [platform-actions.md](./platform-actions.md).

## Default

[clipboard-01] Agent may proactively write to the system clipboard when the output is clearly intended for immediate user paste.

## Typical Allowed Cases

- [clipboard-02] a short shell command
- [clipboard-03] a commit message
- [clipboard-04] a short code snippet
- [clipboard-05] a URL
- [clipboard-06] other token-free text the user is expected to paste elsewhere

## Default Limits

- [clipboard-07] do not proactively read the clipboard unless the user explicitly asks
- [clipboard-08] do not simulate paste or depend on window focus
- [clipboard-09] do not keep monitoring or syncing clipboard state in the background

## Ask Before Writing

- [clipboard-10] secrets or credentials
- [clipboard-11] destructive commands
- [clipboard-12] long multi-line scripts
- [clipboard-13] unusually large payloads
- [clipboard-14] content that may overwrite something the user is likely to still need

## Reporting

[clipboard-15] After writing to the clipboard, explicitly tell the user that the clipboard was updated and summarize what was written.
