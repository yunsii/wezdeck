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

## Wrapper Discovery

- [clipboard-16] Before writing to the clipboard, resolve the wrapper through the marker file declared by your active environment (see [platform-actions.md](./platform-actions.md) §Wrapper Discovery). For wezterm-config–shipped environments the marker is `$HOME/.wezterm-x/agent-tools.env` and the key is `agent_clipboard`. Read the path from the marker and invoke that wrapper directly.
- [clipboard-17] If the marker is missing, or `agent_clipboard` is absent / not executable, treat clipboard writes as unavailable. **Do not** fall back to raw OS clipboard binaries (`clip.exe`, `pbcopy`, `xclip`, `xsel`, `wl-copy`, `Set-Clipboard`, `osascript "set the clipboard to ..."`). The naive WSL → `clip.exe` path produces CJK mojibake because `clip.exe` reads stdin under the system ANSI codepage (CP936/GBK on Chinese Windows) and reinterprets UTF-8 bytes as GBK code points. A caller *can* avoid that by piping through `iconv -f UTF-8 -t UTF-16LE` with a BOM, but even then the binaries on this list only handle text — no image DIB/PNG dual-write, no STA threading, no helper trace_id / format negotiation. The same shape of trade-off applies to the POSIX entries. Re-implementing all that per call site is strictly worse than reporting the capability as unavailable. Tell the user instead.

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
