# Remote sessions (remote web console → agent sessions)

The session half of remote access: what `wezdeck-wsl relay` answers about
the agents running on the host, and what a remote web console may write into them.
Transport, pairing, write signatures, cost and operations are in
[`remote-access.md`](./remote-access.md); the web console UI is in
[`web-pwa.md`](./web-pwa.md).

## Session RPCs

Source: the agent-attention state (`attention.json`, keyed by session id with
tmux socket / session / pane, status `running|waiting|done` and
`waiting_kind`), the only place that already knows every hooked agent
(Claude, codex, grok) and its pane. `wezdeck-wsl relay` answers:

| Action | Kind | What it does |
| --- | --- | --- |
| `sessions` | read | live entries whose pane still exists, plus archived ones (`recent[]`, status `idle`) whose pane still runs an agent (`claude`/`codex`/`grok`/`grok.real`, or `python3` when the session is Grok under `grok-focus-filter.py` — otherwise archived Grok vanishes from 会话 until the next message); newest session id per pane; newest conversation first: the newest turn's own timestamp in the transcript (Claude `~/.claude/projects/*/<id>.jsonl` user / assistant lines, Codex `~/.codex/sessions/*/*/*/rollout-*-<id>.jsonl` any line; read from the file tail, cached by size — `remote_activity.go`), the file mtime only for Grok (`~/.grok/sessions/*/<id>/chat_history.jsonl` lines carry no timestamp); not the mtime for Claude, which touches idle transcripts (mtime only, same size) long after the last turn and kept floating idle sessions such as fe1 to the top; status ts / tmux `window_activity` only when no transcript is found. Each card also carries tree fields for the session list: `repo` / `repo_label` (the terminal's display name through `WEZDECK_REPO_ALIASES`, read from the repo's `wezterm-x/local/shared.env` since the relay runs without that env — `repo_alias.go`; wezterm-config → wezdeck, also for the main checkout's worktree row) / `repo_root` / `worktree` (git family + this checkout; soft-fail without git) and optional tmux mount `tmux_session` / `tmux_pane` / `pane_index` / `pane_role` (`primary` when index≤1, else `secondary`) so the UI groups by path and ticket agents can join the same tree later; after `/new` / `/clear` an archived entry marked `cleared_to` by the SessionStart clear hook (`agent-attention/turn-lib.sh` `attention_mark_cleared`; not the pane pin, which is also set at launch and goes stale after `/resume`) is listed as that new session — idle, empty, sendable before its first prompt creates an entry — and `session` on the old id answers `replaced_by`, which the page follows (`useFollowReplacement`); a composer message that starts with a slash command (`/new`, `/compact …`, not a path) is not queued as a message; Claude records commands as `<command-name>` + `<local-command-stdout>` lines, which become one `role:system`, `kind:slash` message (text = the command line, body = its output, ANSI stripped — `claude_command.go`; the page draws a quiet row, `chat-command.tsx`); for Claude sessions the composer's 命令 panel sends `/compact`, `/new`, `/context`, `/usage`, `/model <alias>` and opens 恢复会话, which `session.history {id}` (read, `session_history.go`) fills with the project's earlier conversations (the transcript dir, or the pane cwd in Claude's encoding for a session with none yet; title, first human message, last turn, `open` when a pane runs it — not offered) and which sends `/resume <id>`; a bare `/resume` typed in the composer opens it too; the SessionStart `resume` hook evicts / pins / marks `cleared_to` like `clear`, so the page follows; without a transcript the reply's `agent` comes from the pane's command; while the entry waits on a `permission_prompt` the reply carries `permission` — the newest tool call with no result (`permission.go`: tool, target, body = command / diff, or the plan for `ExitPlanMode`) — which the page shows as a card (`session-permission.tsx`) answering only with keys that hold whatever the dialog offers: 1 (the first Yes) and Esc (No / keep planning); the middle options vary by tool and mode and stay at the terminal; agents without it keep the generic key strip; 我的 › 交互调试 (`/console/me/interactions`, a 我的 page: list beside / before the selected one, `#<id>` links to one) renders every such interaction from sample data with its source and keys, taps going to a log only; `visited` is when you last visited that worktree at the terminal (ms, from `access-ledger.json` — the `Alt+g` / `Alt+x` visit clock, `WEZDECK_ACCESS_LEDGER` overrides; `session_visits.go`): the web console orders its list by it, not by the card order; `title` is the agent display name when known (Claude: the newest `custom-title` — a `/rename`, which Claude re-appends every turn and carries across `/clear`, after which it stops generating titles — else the last `ai-title`; Grok `summary.json` `generated_title`, including after TUI `/rename`); untitled cards fall back to the worktree / cwd basename, never the tmux window name (the main checkout's window is always `primary`). A message sent while Claude is mid-turn is stored as an `attachment` (`queued_command`, `origin.kind=human`) and shown as a user line; task notifications and auto-continuations are not. A subagent's hand-back (since Claude Code's hand-back protocol the Agent `tool_result` is only a pointer) shows as that Agent call's result: `toolUseResult.handbackReport.text` for a foreground agent, the `peer` queued_command body (matched by `origin.from` = the call's `agentId`) for a background one (`agent_claude.go`). Tool calls carry `pending` until their result arrives, and `background` when the call asked for `run_in_background`; while a Claude session's newest call is a pending foreground `Bash` / `Agent` / `Task`, that call's own row offers 转到后台 at its right end (`ToolRow`, `canBackground` in `chat-tools.tsx`), which sends `C-b` (Claude Code's move-to-background key; `send-keys` bypasses tmux's `C-b` prefix, so one press — at the terminal it takes two) — `foregroundCall` in `chat-thread.tsx`; the key panel keeps only Enter / Esc / Ctrl+C. The `session` reply also carries `reference` (`remote_reference.go`): a block for another agent — `[wezdeck 会话] <title>（<agent>）`, `session_id`, `transcript` path, `cwd` (+ branch), `tmux: -S <socket> -t <pane>（会话 …）` — which the web console's 复制引用 copies so an agent can read the conversation or drive the pane |
| `session {id, limit \| since \| before}` | read | which messages (`session_window.go`, reply `span` + `start`): `{limit}` the last N (default 60; first open, older pages), `{since: n}` from message n on — the poll; it starts earlier at a tool call still pending within the 40 before n so its result lands — and `{before: s, limit}` the page before index s (加载更早). The page keeps one cache entry per session and merges by index (`web/src/lib/session-cache.ts`), so an idle poll is ~2 KB instead of the whole page (100–500 KB), and only the newest 300 messages per session go to IndexedDB. Below: the transcript (Claude, Grok or Codex format, same locations) parsed **incrementally** (only bytes appended since the last read; cached per file) into user / assistant text and tool calls with details — edits (any tool whose input has old/new strings) as a `-`/`+` diff — for Claude replaced, once the call returned, by the applied patch as unified hunks with line numbers (`toolUseResult.structuredPatch`, `tool_patch.go`, ≤160 lines; the web console numbers and syntax-colours them, `chat-diff.tsx` + `lib/highlight.ts`: shiki, JS regex engine, grammar per file extension loaded on first open), whole-file writes as a preview, commands in full (judged by input shape, so the three agents' tools count alike), plus each call's result matched by `tool_use_id` (clipped); returns the last `limit` (default 60) with `total` and `start` for paging; Claude context compaction (`type:system`, `subtype:compact_boundary`) becomes a `role:system`, `kind:compact` marker (`text` = `auto`/`manual`, `body` = the summary the agent continues from — the `isCompactSummary` user line is never shown as something the human typed), and for Claude the reply also carries `subagents` (`agent_subagents.go`: each Agent-tool / forked-skill subagent from `<session>/subagents/agent-<id>.meta.json` + `.jsonl` — name or description, type, background, `running`, or `stale` after 30 min of silence without finishing (kept 2 h), tool-call count, latest tool, start and last-activity time; running first, at most 8; finished ones are not listed — like Claude Code's own panel a subagent leaves when done, its report being the Agent call's result), which the session page shows above the composer (`session-subagents.tsx`); the reply adds `compacted_at` (index of the latest marker) and `compactions`: the web console draws a divider, pages 加载更早 back to the marker and goes further only on 查看压缩前的记录 (pre-compaction history stays in the file but is no longer the agent's context); 会话信息 shows 本页已加载 N / M and the compaction count; and `usage` (model, context = last reply's full input vs the model's `max_input_tokens` from `~/.claude/cache/model-catalog`, turns, output, cache-read share; one reply spanning several lines counts once); also the last 60 screen lines (`capture-pane`). While the entry is running or waiting the reply adds `turn_started` (ms, when the turn began — attention, "Turn progress" below) and `turn_output` (the turn's output tokens: each reply's usage, once per message id, written at or after `turn_started` — `turn_output.go`; lags the TUI by one reply), and `compact_started` while a context compaction runs (`running_kind=compacting`, from Claude's PreCompact hook — the transcript has no trace of it until it is done). The web console ticks the elapsed time itself on its working line (running light, one shape whether or not a tool call is out): 运行中… 4m 39s · ↓ 19.1k tokens, or 正在压缩上下文… 36s in amber. Nothing is read off the screen for this: the TUI's status line format is not a contract. For Grok, when `updates.jsonl` has an unanswered `ask_user_question`, also `elicitation.questions[]` (label/description) so the web console can render tappable options instead of guessing 1/2/3; optional `plan.excerpt` from sibling `plan.md`, and `plan.awaiting_approval` when `exit_plan_mode` is open so the web console can send TUI keys `a`/`s`/`q` |
| `send {id,text,attachments}` | write | paste into the session's own TUI (`load-buffer` + `paste-buffer -p`, then Enter); `attachments` are uploaded file names, appended as a `[网页附件]` block of host paths (images numbered 图片1, 图片2 …) |
| `upload {upload,seq,total,mime,data}` | write | one base64 chunk (≤ 64 KB decoded) of a web console attachment; the last chunk stores the file and answers its `name` |
| `key {id,key}` | write | one key from `1 2 3 4 Enter Escape Up Down Tab C-c a s q y` (permission / Ask digits, Ctrl+C interrupt, and Grok plan-review `a`/`s`/`q`/`y`) |
| `reply {id,text,continue}` | write | `ticket reply` with `TICKET_TRIGGER_SOURCE=mobile` |
| `attach {id}` | write | `ticket attach --id` (skills/agent-collab/lib/attach.py): the ticket's agent conversation opens in a new window of the target repo's tmux session through `agent-launcher.sh` with `WEZDECK_RESUME_SESSION_ID`, and an open ticket is session-claimed so headless runs stop writing to it — the web console's 接管到 tmux |
| `todos {session? \| all}` | read | the repo to-dos of the session's repo, or every open one (`scripts/runtime/todo.py list --json`) |
| `todo {op, session, text?, id?}` | write | `add` (to the session's repo, source `web`; rows from before 2026-11-24 were migrated from `phone` by `todo.py`) / `done` / `reopen` / `delete` a repo to-do |
| `repos` | read | repositories a remote web console may create a session in: main checkouts of visited worktrees (access ledger) and of running sessions, newest visit first (`session_new.go`) |
| `session.new {repo, type, subject, prompt}` | write | 新会话 — Ctrl+k g d/t/h: `open-task-window --no-attach --type dev\|task\|hotfix -- <subject>` in `repo` (must be one of `repos`; subject one line ≤ 60, message 1–8000), then the message is pasted into the new agent once its pane runs a non-shell and the screen holds still 1.5 s. Answers `{job}` at once — git fetch + agent start outlast an RPC. The message is required: a session is listed only from its first prompt's attention entry. `WEZDECK_SESSION_NEW_CMD` replaces open-task-window (test stack stand-in) |
| `session.new.job {job}` | read | that job: `stage` creating → starting → sending → done, or failed with `error`; `worktree`, `branch` (kept an hour) |
| `ticket.targets` | read | the ticket config's targets `[{key, path}]` (`$TICKETS_ROOT/config.yml`, the subset the CLI parses) |
| `ticket.new {from, to, title, observed, assumed, run}` | write | 新工单: `ticket create` between two configured targets (title one line ≤ 120; the assumption gate's observed / assumed 1–8000). `run` starts `ticket run --phase auto` in its own transient unit (`systemd-run --user --unit wezdeck-ticket-<id>`), so a relay restart does not kill it; `WEZDECK_TICKET_RUN_CMD` replaces that launch (`ticket_new.go`) |
| `clear {id}` | write | mark a session read — Ctrl+X in `Alt+/`: `attention-jump.sh --forget <id> --only-if-ts <ts>` archives the live entry into `recent[]` and nudges the counters; only a listed session, and only while its entry still has the ts just read (a fresh question is never swallowed). A relay with `WEZDECK_ATTENTION_FILE` clears there (`WEZDECK_ATTENTION_STATE_PATH`), never in the live state (`remote_clear.go`). The web console: swipe a running / waiting / done row left → 标为已读, or the button in 会话信息 |
| `device.register` | read-ish | records a remote web console's public key as pending |

Guards on every write (`remote_session.go`): one writer — a tmux-hosted
session only ever receives a paste into its own TUI, never a second process
resuming the same session id; free text anytime, also mid-turn, for every
hosted agent: Claude Code queues it and schedules it itself, Grok queues a
follow-up that runs after the turn (`[ui].follow_up_behavior`, default
`queue`; it holds while background tasks / subagents block the turn), Codex
(0.166) steers the active turn with it; background tasks
(`running_kind=background`) are listed from `bg.tasks` on the web console; never
while a confirmation is pending; nothing while there was input at the
desk in the last 10 s (`client_activity` of the attached tmux clients: keys,
mouse, focus; it was 30 s, which blocked the web console for half a minute after
merely answering a prompt at the terminal) — the error says `retry in Ns` and the
web console counts down and resends by itself (up to 3 rounds); the
pane gets a 4 s `网页端发来一条消息` notice.

## Turn progress

The web console's working line (运行中… 4m 39s · ↓ 19.1k tokens / 正在压缩上下文… 36s) comes from these fields, not from reading the TUI's screen — its status-line format is not a contract.

- Attention fields (`scripts/runtime/agent-attention/turn-lib.sh`, hooks in `docs/agent-attention.md`): `turn_started` (ms) is set while an entry is `running` or `waiting`: the first `running` after `done`, after a background-only stretch (`running_kind=background`) or with no entry starts the turn now; later `running` / `waiting` upserts of the same turn (queued prompts, permission prompts) keep it; `done` drops it. `transition_to_running` keeps it from `waiting` and starts it from `done` / no entry; the background → turn-running promote starts it.
- `PreCompact → compacting` upserts `status=running`, `running_kind=compacting`, `compact_started` (ms) and `compact_from` (the status before: `running` for an auto compaction mid-turn, `done` / empty for a manual `/compact`). `turn_started` follows the rule above (kept mid-turn).
- `SessionStart compact → compacted` goes back by `compact_from`: `running` / `waiting` → `running` (the turn goes on), `done` → `done`, empty → removed. Without a matching `compacting` it is a no-op. A tool call (`resolved`) while `running_kind=compacting` also ends it, keeping `turn_started`, in case the tool call comes before SessionStart.
- The relay passes `turn_started` / `compact_started` through and adds `turn_output` from the transcript ("session" above). Terminal badges treat `compacting` as plain running.

Sandbox test: `tests/hook-units/test_compaction_turn.sh` (in `scripts/dev/test-lua-units.sh`).

## Local reads and writes

A browser on the host itself reads and writes sessions without pairing, the
way it already reads tickets: the loopback Runtime answers
`GET /api/v1/remote/<action>?args=<json object>` (health capability
`remote.read`; `RuntimeWebServer.Remote.cs`, fixed allowlist, args ≤ 4 KB)
through the WSL bridge `remote.<action>`, which runs the relay's own read set
(`readRPC` in `relay.go`): `sessions`, `session`, `upload.get`, `todos`,
`repos`, `ticket.targets`, `session.new.job`, `session.image`. Writes go the
same way as `POST /api/v1/remote/<action>` with a JSON object body
(capability `remote.write`; `send`, `key`, `reply`, `attach`, `upload`,
`todo`, `clear`, `session.new`, `ticket.new`) into `runWrite`
(`remote_write.go`) — the very function the relay calls after
`verifyWrite`, so every guard inside the actions applies — with no device
key: the Runtime listens on loopback and answers only a loopback `Host`
(`127.0.0.1` / `localhost` / `[::1]` on its port; anything else 421 — a DNS
rebinding page sends no Origin on its same-origin GETs), 403 to an origin
outside its allowlist, and takes writes only with an `Origin` that is
allowlisted **and not loopback**: the production console writes, a local dev
server (`localhost:3000`, any project's) only reads (`IsWriteOriginAllowed`).
415 to a non-JSON body (a form post cannot write), 400 past 256 KB before
the body is read. Writes use their own bridge connection with a 75 s timeout
(the page waits 80 s), so a slow `ticket.new` neither blocks reads nor is
reported failed and retried into a duplicate.
Each write leaves `event=write via=local device=local` in `relay.log` (the
bridge process appends there; `relayLogf`). The web's `hostRead` /
`hostWrite` try the Runtime first and fall back to the remote link
(`?remote=1` forces it); on the host 写入权限 reads 本机，已启用. Device
registration stays relay-only. Below it (`me-devices.tsx`) the host shows
two lists. 本机来源: every browser or script that used the Runtime since it
started, one row per Origin + User-Agent with last seen, requests, writes
that passed the checks (a refused one is not counted) and open `/events`
sockets — `GET /api/v1/clients` (capability `clients.read`,
`RuntimeWebServer.Clients.cs`, in memory, at most 50, the longest unseen
dropped); this browser is marked. 远程设备: the device store, read action
`devices`, with 批准 / 撤销 as writes `device.approve` / `device.revoke`
(撤销 takes a second tap). All three are local only: the bridge answers
`remote.devices` / `remote.device.*` (`remote_devices.go`: id, state, name,
info, added, last seen, never the public key; approve / revoke take the
store lock like `install-remote-relay.sh` and log `event=device_approve` /
`device_revoke via=local`), `readRPC` and the relay do not, so a paired
web console can neither list nor change the others. The relay re-reads the store
on every read and write, so a revoke cuts the device at once.

## Turn line

The foot of the thread is one row whose text changes (`chat-turn.tsx`):
运行中… with the elapsed time (and tokens) while the host says running; the
same at once after a send, timed from the send, before the host's next
poll (optimistic) and while the prompt is in the transcript but the hook
has not flipped to running yet (≤ 2 min); 用时 36s · 13:42 完成 once the turn
is over, from its prompt to its last line (the entry's last change when the
transcript has no times, Grok); nothing while a question waits on you. It
used to appear only after the host said running and vanish at the end, so
the thread jumped twice per turn.

## Seen on the web

A `done` session open on the session page (remote or local web console) in the
foreground for 1.5 s — the terminal's focus-ack floor — is cleared at the terminal
too: the page sends `clear` with the `ts` and `status` it saw (`useSeenAck`
in `session-clear.tsx`, run by `session-while-shown.ts`), the host runs
`attention-jump.sh --forget --only-if-ts` (`remote_clear.go`) and the ✓
badge and counter drop. An entry that moved on meanwhile (the next turn, a
question) answers `skipped: "changed"` and stays; `waiting` is never
seen-acked, as at the terminal. One send per `id:ts`; a failed one is retried
the next time the session is on screen. Signals: `event=write
action="clear"` in `relay.log`, `session-seen-ack` in the client trace.

## Attachments

Composer keys (`session-composer.tsx`): with a mouse and keyboard Enter
sends and Shift+Enter breaks the line; on a touch screen (`(hover: none) and
(pointer: coarse)`) Enter is a new line and the send button sends — a touch
keyboard has no Shift+Enter. Ctrl/⌘+Enter sends on both; an IME's Enter
(`isComposing`) only picks the candidate. Space anywhere else on the page
focuses the composer (`composer-keys.ts`). A new session with no messages yet
(the pane's screen only) still lands at the bottom (`chat-scroll.ts` counts
the loaded detail).

Reporting a problem from the web console (the toolbar above the composer,
`session-composer.tsx`): add up to 5 images with 图片 or by pasting a
screenshot into the focused input (text copied alongside an image still
pastes as text)
(thumbnails sit in the same row; the toolbar shows only on an approved device). Images are shrunk in the
browser (long edge ≤ 1600 px, JPEG 0.82, `lib/upload.ts`); every file goes up
as signed `upload` chunks of 36 KB (small enough for one DataChannel
message), then `send` names the stored files and the host appends

```
[网页附件]
- 图片1: ~/.local/state/wezdeck/remote-uploads/img-<ts>-<id>.jpg
- 图片2: …
```

so the agent can open them. Images are numbered in the order sent, and
each pick (or paste) leaves `[图片N]` at the caret, so the text says which
picture is which ("把 [图片1] 的按钮改成 [图片2] 那样"); removing an image
drops its token and renumbers the rest (`composer-images.ts`,
`composer-tokens.ts`). The picked files are kept with the draft, per
session, in IndexedDB (`wezdeck-draft-images`; the text is in
localStorage), so a reload brings back the pictures its `[图片N]` refer to. Thumbnails carry their 图片N, in the composer (a
tap on the number puts the token at the caret again, `composer-picked.tsx`)
and on the sent message, where each `[图片N]` in the text is a chip that
opens that picture (`chat-attachments.tsx`). In the composer a token is
one unit: Backspace / Delete next to it removes all of it, ← / → step over
it (`tokenKey`); the image stays (its × removes both). Not Claude Code's own `[Image #N]`: that numbering
runs per conversation at the terminal, and the same spelling could be read as
one of its pasted images; `图片N` is per message, mapped by the list
above. Host side (`remote_upload.go`): types limited to
JPEG / PNG / WebP / GIF / JSON and checked by magic bytes (JSON must parse),
8 MB per file, 6 attachments per message, `send` only resolves bare names
inside the uploads dir (`WEZDECK_REMOTE_UPLOADS` overrides it), half-done
uploads expire after 10 min, files older than 30 days are pruned on every
finished upload; one `event=upload` relay log row per stored file.

Viewing them (`features/image-viewer.tsx`): a composer thumbnail opens the
local pick full screen; in the conversation a `[网页附件]` (or older `[手机附件]`) image renders as a
thumbnail and opens the original. The host only sends bytes: the read
action `upload.get {name, offset}` (`remote_upload_get.go`, bare `img-*`
names inside the uploads dir only) answers `{mime, size, offset, data}`
chunks of 48 KB that the web console reassembles into a blob (`lib/upload-image.ts`,
cached per page), and the web console makes the thumbnail itself (createImageBitmap
+ canvas → a ≤720 px JPEG data URL, kept in the persisted query cache). The
host decodes nothing — a small PNG declaring a huge size cost it gigabytes,
and it had no webp decoder; a `thumb` field from an older page is ignored. The viewer fits the screen, a tap toggles actual size
(scroll to pan), Esc / × / backdrop close, ← / → step through a message's
images; the blurred thumbnail stands in until the original arrives. A
thumbnail that fails while the link is still coming up retries with backoff;
Only the host's "no longer on the host" shows 已过期, other failures show 重试
(tap reloads). Images embedded base64 in a Claude transcript — pasted at the
desk (`[Image #1]` + image block) or returned by a tool (Read of a .png,
browser screenshots) — become refs on the message (`images`:
`<line byte offset>.<nth image in that line>`, `agent_claude.go`) and are
read with `session.image {id, ref, offset}` (`remote_image.go`),
which re-reads that one line and answers like `upload.get`; tool images load
only once the call is opened.

## Repo to-dos

A big change gets a follow-up note that belongs to the **repository**, not to
the conversation: a later session there (or another agent) picks it up after
the original one is gone. Stored in SQLite (`~/.local/state/wezdeck/wezdeck.db`,
table `todos`, `WEZDECK_TODO_DB` overrides) by `scripts/runtime/todo.py`,
keyed by the git common dir so every worktree of a repo shares one list.
Agents call it from the repo: `todo.py add [--session ID] -- TEXT`,
`todo.py list [--open|--all] [--json]`, `todo.py done|reopen|delete ID`. On the
web console, the session toolbar's 待办 panel lists the session repo's to-dos — add,
mark done, or put one into the composer to hand it to this agent — and the
会话 list shows every open one under 待跟进 at the bottom. The relay only maps a session to its
directory (`remote_todo.go`).

## Diagnostics on demand

No 诊断 button: the host pulls what it needs. `wezdeck-wsl diag [--wait 15]
[--reason TEXT] [--steps JSON | --steps-file F]` asks the running relay over
its control socket (`~/.local/state/wezdeck/relay.sock`, 0600;
`WEZDECK_RELAY_CONTROL` overrides) to push `{t:"diag.request"}` to every
web console seen in the last 3 min (DataChannel when open, else the DO by cid;
`relay_diag.go`). With `--steps` the web console first drives its own UI
(`lib/host-diag.ts`: `navigate` in-app paths, `back`, `click` by `text` or
`selector`, `scroll`, `wait`, `reload` — run after the snapshot is sent, the
page reloads onto the newest deploy; `--reload` appends it, so after a
release `wezdeck-wsl diag --reload` puts every connected web console on the new
build (a build older than this step ignores it: get it there once through
我的 › 应用 › 检查更新 and the toast's 刷新); never a control inside a form or under
`[data-write]` — send, reply, take over, keys, options, rename), recording
each step's frames (count, fps, longest gap, gaps > 50 ms). It answers with
the snapshot as `diag.submit` chunks — accepted only for a live request id —
stored as `diagnostics-<ts>-<id>-<client>.json` in the uploads dir; the CLI
prints the paths. The web console shows a toast that the host read diagnostics;
relay log rows `diag_request` / `diag_received` / `diag_done`.

The snapshot (`lib/client-trace.ts`) holds build id, page path (no hash: it
can carry the pairing token), user agent, standalone mode, screen / viewport
/ `visualViewport` / safe-area sizes, the scroller, link mode / path / RTT,
history index / length, View Transitions support, the session page's state
(`chat`: loaded window `start` / `shown` / `total` and `loadedUsers`, the
newest 15 user messages it holds), `renderedChat` — what is actually drawn,
read from the DOM (`chat-thread.tsx` marks each item `data-msg` = transcript
index + `data-role`, and the reveal cursor): `reveal` / `end`, every drawn
user index, the last 40 items with a 40-char snippet, pending bubbles — so a
"message missing on the web console" splits into never loaded (not in
`loadedUsers`) vs loaded but not drawn (not in `renderedChat.users`), checked
against the host transcript without asking the human to look;
the host's step results, and the last 300 page events (viewport, focus,
`chat-pin`, visibility, link changes, errors, `nav` / `nav-collapse`,
`nav-frames` for every page change, `longtask` ≥ 80 ms where supported). No
tokens, no message text.

## Account limits

The session header shows the Claude account's 5-hour and 7-day limits the
way Claude Code's own status line does — from the same source, no
credentials or API calls: Claude Code pipes a JSON snapshot (with
`rate_limits.five_hour` / `seven_day`: `used_percentage`, `resets_at`, and
`context_window`) to its statusLine command on every refresh. The statusLine
script hands it on, in the background:

```bash
printf '%s' "$input" | bash "${WEZDECK_REPO:-$HOME/github/wezterm-config}/scripts/runtime/claude-statusline-tap.sh" >/dev/null 2>&1 &
```

`claude-statusline-tap.sh` writes `{session_id, ts, model, context_window,
rate_limits}` to `~/.local/state/wezdeck/claude-status/<session_id>.json`
(atomic, ids validated, 30-day prune; `WEZDECK_CLAUDE_STATUS_DIR`
overrides). `remote_limits.go`: limits are account-wide, so the newest
snapshot from any session answers (`account` in the `session` reply, Claude
sessions only, hidden when older than 7 days); a session's own
`context_window_size` replaces the model-catalog context limit (it knows
the 1M variants). Codex reports `rate_limits` in its `token_count` events
too, but through the gateway used here they are all null, so Codex shows
context only; Grok's transcript has no token counts.

## Agent adapters and the session contract

Everything that differs between agent CLIs stays on the host, behind one
interface (`native/wezdeck-wsl/agent_adapter.go`); the relay, the transport
and the web page only see the shared contract. Each agent is one file —
`agent_claude.go`, `agent_grok.go`, `agent_codex.go` — implementing:

| Method | Does |
|---|---|
| `Name()` | agent id the web console sees (`claude` / `grok` / `codex`) |
| `Locate(home, id)` | the session's transcript path, or `""` |
| `Feed(t, line)` | one transcript line → shared messages / usage |
| `Title(path)` | agent-generated or `/rename`'d title |
| `ToolKind(name, input)` | the shared kind of a tool call (below) |
| `Capabilities()` | declared features with no code here (usage source, account limits, mid-turn input, titles) |

Optional parts, called through their interface (never `if agent == …`):
`askReader.PendingAsk(path, screen)` (the unanswered Ask) and
`planReader` (`PendingPlan(path)`: plan state beside the thread;
`PlanTool()`: the tool whose permission prompt approves a plan, Claude's
`ExitPlanMode`). `ask_options` / `plan_review` are derived from them
(`capabilitiesOf`), so 会话信息 cannot say 否 for a feature that works.

A new agent is one more file plus an entry in `agentAdapters`.

**Contract** (the `session` reply; `v: 1`). Messages: `role` (`user` /
`assistant` / `tool`), `text`, `ts`; tool calls add `tool` (the agent's own
name, for display), **`kind`**, `body`, `result`, `file` / `added` /
`removed` (counted from the input's shape) and `pending`. Session: `usage`
(context, limit, output, cache), `account` (Claude limits), `elicitation`
(Ask questions) and the plan-review flag, `reference`, and
**`capabilities`**, and `meta` (`remote_meta.go`: everything the host
knows, grouped `session` / `location` / `transcript` / `state` as
`{name, rows: [{key, value}]}`, empty values left out — the web console's
会话信息 sheet):

| Field | Meaning | claude / grok / codex |
|---|---|---|
| `ask_options` | structured questions with tappable options (derived: `askReader`) | ✓ / ✓ / – |
| `plan_review` | a plan waiting for approve / revise / exit (derived: `planReader`) | ✓ / ✓ / – |
| `usage` | where context / spend comes from | `transcript` / `none` / `token_count` |
| `account_limits` | 5 h / 7 d limits from the status line | ✓ / – / – |
| `mid_turn_input` | what a message sent mid-turn does | `queue` / `queue` / `steer` |
| `title` | the agent names sessions, honours `/rename` | ✓ / ✓ / – |

Tool `kind`: `command`, `read`, `edit`, `write`, `search`, `task`, `todo`,
`web`, `ask`, `other` — from each adapter's name table, falling back to the
input's shape (edit pairs → edit, whole content → write, a command →
command, a file path → read), so an unknown tool still lands sensibly. The
web console's run digest (files changed, commands run, files read) counts kinds,
not names — Grok's `run_terminal_command` / `search_replace` / `read_file`
used to fall through a Claude-name filter and showed only a call count.

Versioning: changes are additive (new fields, new kind or capability
values); pages ignore what they do not know and fall back when a field is
missing (the digest maps Claude names when `kind` is absent). A change of
meaning bumps `v`. Writes are still per-agent keys today; the next step is
intents (`answer`, `approve`, `interrupt`) that each adapter turns into its
agent's keys, so the page never encodes an agent's key sequence.
