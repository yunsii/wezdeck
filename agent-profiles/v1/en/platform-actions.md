# Platform Actions

Read this file when the task may trigger a host-side side effect on the user's local machine.

This file defines policy, not guaranteed capability availability.
Whether an action is actually possible depends on the active platform, installed wrappers, and project-local integrations.

Examples:

- writing to the system clipboard
- focusing or launching a desktop application
- opening a browser or URL
- showing a local notification
- revealing a file in the OS shell

## Default

Agent actions that affect the local machine should be:

- narrow
- explicit
- reversible where possible
- directly in service of the current task

Prefer preparing the next user step over silently taking extra actions beyond it.

## Command Boundary

Prefer a stable high-level wrapper command over raw transport details when one exists.

Use wrappers that:

- hide platform-specific IPC details
- expose clear inputs and outputs
- fail visibly
- are easy to log and verify

Do not couple user-level policy to a specific named pipe, binary path, or transport encoding when a stable wrapper already owns that layer.

If no stable wrapper or owned command boundary exists for a given action, treat that action as unavailable by default.

## Wrapper Discovery

Use an explicit marker file instead of guessing paths.

Default contract:

- read `~/.wezterm-x/agent-tools.env`
- if the file is missing, treat host-side wrappers as unavailable
- do not infer wrappers from the current task repository, AGENTS symlinks, or unrelated environment details

For the clipboard wrapper:

- read `agent_clipboard` from `~/.wezterm-x/agent-tools.env`
- only use it when the file exists and is executable
- if the key is missing or the file is not executable, treat the clipboard capability as unavailable

## Clipboard

Agent may proactively write to the system clipboard when the output is clearly intended for immediate user paste.

Typical allowed cases:

- a short shell command
- a commit message
- a short code snippet
- a URL
- other token-free text the user is expected to paste elsewhere

Default limits:

- do not proactively read the clipboard unless the user explicitly asks
- do not simulate paste or depend on window focus
- do not keep monitoring or syncing clipboard state in the background

Ask before writing:

- secrets or credentials
- destructive commands
- long multi-line scripts
- unusually large payloads
- content that may overwrite something the user is likely to still need

After writing to the clipboard, explicitly tell the user that the clipboard was updated and summarize what was written.

## Other Host-Side Actions

Agent may take other host-side actions only when all of the following are true:

- the action is a natural continuation of the current task
- the action is low-risk and easy to understand
- there is a stable wrapper or well-owned command boundary
- the user would otherwise need to perform the same mechanical step manually

Ask before actions that are destructive, persistent, privacy-sensitive, or hard to undo.

## Reporting

When a host-side action succeeds, report:

- what action was taken
- what target was affected
- whether follow-up is still needed from the user

When it fails, report the failed action, the immediate reason if known, and whether the main task is still blocked.
