# Deferred Session Messages

Use this doc for messages that belong to the current session but should reach
the agent after its current turn. Cross-repo work belongs to the ticket flow
in [`agent-scheduling.md`](./agent-scheduling.md).

## Delivery Contract

The composer offers send now, send after this turn, and wait for confirmation
after this turn. The latter two call signed `deferred.enqueue`; they do not
paste into the TUI. `session` returns `deferred[]` to every approved device.
The browser keeps only its unsent composer draft and preferred delivery mode
locally. The plus menu shows the pending count and jumps to the queue bubbles.
Its Send timing row shows the current choice and opens a nested Sheet view.
Each choice is a full-width radio row with a selected check; Back returns to
the actions list, while choosing a value closes the Sheet. Tab and arrow keys
reach the same choices as touch; Enter and Space activate the focused choice.

`deferred.release` sends one item now and `deferred.cancel` removes one item.
Both are signed writes. Edit loads the item back into the composer and cancels
the old queued copy. Every send uses the existing `send` / sent-message outbox
chain with a stable `client_op` so a repeated release does not paste twice.

## Host State

The host stores text and bare attachment names in
`~/.local/state/wezdeck/deferred-messages.json` (owner-only, flock, atomic
rename; `WEZDECK_DEFERRED_MESSAGES` overrides). Open records are never pruned
by age. Terminal records expire after 30 days; at most 200 open items are
accepted. Upload pruning pins attachments referenced by open items.

The relay polls attention state every two seconds even with no browser open.
An item queued while idle must see a later running turn. An item queued during
a turn waits for that turn's later `done` timestamp. A short turn missed
between polls is recognized from its `turn_started` timestamp. Only the
oldest open item advances on a completion. Review items become
`waiting_review` and block later items until sent or canceled. Failed or
stale head items also block later work because it may depend on the head;
retry, edit, or cancel the head to continue.

Before release, the host checks the session, pane and worktree again. A
changed target becomes `stale`. Desk-input holds honor the returned
`retry in Ns` deadline; confirmation prompts keep the item queued.
A release interrupted by a host restart is retried after its claim expires,
using the same `client_op` against the sent-message outbox.
After `/new` or `/clear`, the new session shows predecessor items as stale;
they can be edited into the new composer or removed, but never auto-send
across the session boundary.

## Verify And Diagnose

Go tests in `native/wezdeck-wsl/remote_deferred_test.go` cover ordering,
review, fast turns, persistence, retries and attachment pinning. Web tests in
`web/tests/session-deferred.unit.test.ts` cover host projection and empty
queue reconciliation. The relay writes `deferred_enqueue`,
`deferred_review`, `deferred_release`, and `deferred_cancel` to `relay.log`;
rows contain identifiers, outcomes and lengths, never message text.
