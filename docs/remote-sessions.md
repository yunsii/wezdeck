# Remote sessions (remote web console → agent sessions)

The session half of remote access: what `wezdeck-wsl relay` answers about
the agents running on the host, and what a remote web console may write into them.
Transport, pairing, write signatures, cost and operations are in
[`remote-access.md`](./remote-access.md); the web console UI is in
[`web-pwa.md`](./web-pwa.md).

## Codex chat messages and titles

The relay drops Codex-injected instructions and environment context from the
chat transcript per content item, using the item source in the rollout. For
older rollouts it recognizes the legacy context wrappers. The browser sends the
transcript revision with its pagination cursor. A stale Codex cursor receives
a full page and replaces the cached messages because filtering shifts indexes.
The relay logs a `session_cursor` revision reset without the message text.

The session list, header and metadata use Codex's latest saved
`thread_name` from `~/.codex/session_index.jsonl`, including automatic names
and manual renames. The relay caches the index until its file changes and
logs refreshes without recording the titles.

### Background auto-titling (all agents)

`wezdeck-wsl relay` runs a single-concurrency background auto-titler
(`session_autotitle.go`) covering Claude, Codex, Grok and Agy sessions. Every
20 s (`WEZDECK_AUTOTITLE_INTERVAL_S`, set `WEZDECK_AUTOTITLE=0` to disable),
it scans active sessions (`liveSessions()`), extracts up to the last 5
non-harness user turns plus the latest assistant reply snippet, and calls
`scripts/runtime/session-autotitle.sh` (which routes single-shot host CLI
invocation through `skills/adversarial-review/lib/provider.sh`, automatically
skipping any agent profile marked `disabled` in `~/.config/wezdeck/agent-profiles/`
and resolving fnm/nvm/user bin dirs so `grok` / `codex` / `claude` work under
systemd's minimal `PATH`, overridable via `WEZDECK_AUTOTITLE_PROVIDER`).
The prompt asks for `UNCHANGED` when the topic has not shifted, `REFINE: <title>`
when polishing the current task's wording, or a new title (`SHIFT: <title>` or
plain line) when the conversation moved on; otherwise it writes the title and a
capped chronological `history[]` (up to 50 entries, recording `title`, `at`,
`ended_at`, `user_turns`, `source`, `provider`, with bigram-similarity and
short-window refinement dedup so minor rewordings update the latest task in
place instead of adding noise) to `~/.local/state/wezdeck/session-titles.json`
(0600, atomic rename, 30-day prune). Runtime settings (enabled, provider, scan
interval) persist in `~/.local/state/wezdeck/autotitle-config.json` and are
managed from `我的 › 自动标题` (`/console/me/autotitle`, backed by
`session.autotitle.status` and signed `session.autotitle.update`). Precedence:
explicit manual `/rename` (Claude `custom-title` or locked web `/rename`, which
also appends a `manual` history item) > auto-title > agent native title;
`会话信息` reports `title_source` and surfaces the session's task timeline
(`title_history`, also expandable per session under `我的 › 自动标题`).
Triggering is debounced (first substantive turn runs immediately; subsequent
updates require a settled turn, ≥90 s cooldown, and either ≥2 new substantive
turns or ≥4 min since the last update, ignoring trivial acks like "可以" /
"ok"). Each attempt logs `category=relay event=session_title_auto` with
`session_id`, `agent`, `provider`, `trigger`, `outcome` and `latency_ms`.

When a provider starts a new rollout in the same pane without leaving the
attention hook's `cleared_to` marker, the relay follows the handoff by
matching the archived session to the live session on that pane. A web page
holding the old URL is redirected to the new session instead of continuing to
show its persisted transcript. The reverse also follows: Grok `/resume`
(SessionStart source `load`) and Claude `/resume` (source `resume`) run the
same `pane-evict` path, overwrite an earlier `cleared_to` on that pane, and
leave a stub for any phantom id that only existed as someone's `cleared_to`,
so a web page still on the fresh session switches back to the resumed one.
The `sessions` poll also carries `redirects: [{from,to}]` (cleared_to and
`ReplacedFrom` edges whose `to` is still listed) so a detail URL that missed
`replaced_by` still follows on the next list tick (`useFollowSessionRedirect`).
For Agy’s `/new` and a cold restart, the initiating page follows the
`session_id` returned by the write as soon as the host acknowledges it.
Older hosts and changes initiated from another client still use read-side redirects.
If the host reports that a session has ended without a replacement, its
detail route returns to the sessions list using a history replacement.
The page breaks redirect cycles: once it has left a session id by following,
it will not auto-navigate back to it (`canFollowSession`; client trace
`session-follow` with `skipped=cycle`). A session id still pinned on another
live agent pane is listed there and is not redirected away (two windows on
one worktree). An idle empty splash that only appeared as that pane's
`cleared_to` target is omitted from the list when the prior id is still
listed with visible chat (resume landed on the home screen while the
previous conversation still runs elsewhere).

After a cross-agent fresh respawn, an archived entry or late active hook from
a different known agent family no longer resurrects that transcript on the
pane. A valid `cleared_to` still produces the blank replacement card; unknown
families fail open so an unrecognized agent is not hidden. The same-family
check uses the managed profile when wrappers hide the real process name
(`python3` for Grok, `bash` for Agy).

When a completed Codex turn is acknowledged and its pane no longer runs
Codex, its archived entry remains in the local-mode session list for three
minutes unless a new session has taken over the same pane. In local mode,
the detail page can read its transcript while the entry is in the attention
archive. The page reports that Web sending is unavailable. A Codex TUI can
still be open in another pane because hooks from a shared app-server can
inherit its original pane environment. Agy remains visible after a turn ends
while its managed pane's bash launcher still has an `agy` child process;
`pane_current_command` alone reports `bash`. The Web session list is one unified full-bleed Telegram-style IM rail across mobile and desktop:
one flat row per single-session worktree (session title only, no inline worktree description) — a worktree running several agent sessions gets a
foldable header plus left-rail-guided stable sub-rows
(`web/src/features/session-chat-group.tsx`): own avatar, tone, preview,
unread and direct link, so two busy agents no longer take turns repainting
one shared focus row and every session stays reachable; the header folds
back into a full group chat row keeping focus avatar, preview, time and unread count, remembered per worktree
(`session-collapse.ts`, localStorage best-effort). Waiting and done sessions auto-sync incrementally into the persisted query cache in the background (`web/src/features/session-autosync.ts`, traced as `session-autosync`) so opening them needs no click-time wait. `Alt+j` / `Alt+k` / `Alt+l` jumps likewise target every session, not just
each worktree's focus. Browser-local unsent composer text appears as a 草稿
marker on the second line of each session row and collapsed group, while the
status preview remains visible. Chat groups order by the latest stable turn
start or completion in the group, with unread first within each repo;
opening a chat and transcript output do not reorder rows. Rows carry known brand avatars (including
[Antigravity's official icon](https://antigravity.google/press)) or a generic
Bot glyph for unknown agents. Avatar corners are fixed: **top-left** = turn
status LED (waiting / done / running; idle empty), **bottom-right** = backend /
profile badge (Kimi, gateway, …). Completed and idle sessions preview the
latest agent reply from the current detail cache; until it is available they
show the human prompt. Markdown replies become single-line plain text (format
markers and link URLs are omitted) for both chat rows and sub-rows. Running
and waiting sessions retain the request and
status prefix. The cache is already warmed on completion and list previews
subscribe to its updates without fetching transcripts on every list poll;
focusing a session opens its preview. A newly created idle
session with no human prompt is never called `Replying…` merely because its
timestamp falls inside the recent-turn grace period, and it cannot become the
chat's running focus ahead of a real recent turn; list time is clock-today /
yesterday / weekday / date; a top search filters by title, purpose, preview,
and agent across **all** of a worktree's sessions, not only the focus;
purpose on the row is read-only (edit in 会话信息 via
`worktree.describe`); pane index still orders sessions inside a worktree.

Each `sessions` card reports `ts` with `time_source` and `order_at` with
`order_source`. Display time comes from a transcript turn, transcript mtime,
attention state, or tmux `window_activity`; active turns order by their start,
completed turns by attention completion, and archived cards by their live
timestamp. A card with no transcript uses its attention timestamp; only one
without either timestamp falls back to tmux window activity. A tmux window
can contain several sessions, so its activity cannot establish that a given
session received a message. The relay writes
`event=session_order` to `relay.log` when ordering or source changes, when a
fallback display time changes, and on the first observed mtime/window fallback.
Ordinary transcript output with stable ordering is omitted. Rows include
previous and current values, both sources, attention timestamp, status, id,
and pane; they contain no message text. The first observation after a relay
restart has no previous value, so it cannot establish what changed before
that restart.

Chat focus keeps waiting, unread-done and running sessions ahead of idle ones.
Between ordinary idle sessions in one worktree, the card whose tmux session has
an attached client wins over a newer detached conversation, so the session on
the terminal is the one the row opens; activity time breaks ties within each
group. `sessions` computes each card's `detached` flag with one batched
`list-sessions` read per tmux socket. A detached waiting / running session is
still real work and is never hidden by an attached blank pane.

## Session RPCs

Source: the agent-attention state (`attention.json`, keyed by session id with
tmux socket / session / pane, status `running|waiting|done` and
`waiting_kind`), the only place that already knows every hooked agent
(Claude, codex, grok) and its pane. `wezdeck-wsl relay` answers:

| Action | Kind | What it does |
| --- | --- | --- |
| `sessions` | read | live entries whose pane still exists, plus archived ones (`recent[]`, status `idle`) whose pane still runs an agent (`claude`/`codex`/`grok`/`grok.real`, or `python3` when the session is Grok under `grok-focus-filter.py` — otherwise archived Grok vanishes from 会话 until the next message); newest session id per pane; newest conversation first: the newest turn's own timestamp in the transcript (Claude `~/.claude/projects/*/<id>.jsonl` user / assistant lines, Codex `~/.codex/sessions/*/*/*/rollout-*-<id>.jsonl` any line; read from the file tail, cached by size — `remote_activity.go`), the file mtime only for Grok (`~/.grok/sessions/*/<id>/chat_history.jsonl` lines carry no timestamp); not the mtime for Claude, which touches idle transcripts (mtime only, same size) long after the last turn and kept floating idle sessions such as fe1 to the top; status ts / tmux `window_activity` only when no transcript is found. Each card also carries tree fields for the session list: `repo` / `repo_label` (the terminal's display name through `WEZDECK_REPO_ALIASES`, read from the repo's `wezterm-x/local/shared.env` since the relay runs without that env — `repo_alias.go`; wezterm-config → wezdeck, also for the main checkout's worktree row) / `repo_root` / `worktree` (git family + this checkout; soft-fail without git) and optional tmux mount `tmux_session` / `tmux_pane` / `pane_index` / `pane_role` (`primary` when index≤1, else `secondary`) so the UI groups by path and ticket agents can join the same tree later; after `/new` / `/clear` an archived entry marked `cleared_to` by the SessionStart clear hook (`agent-attention/turn-lib.sh` `attention_mark_cleared`; not the pane pin, which is also set at launch and goes stale after `/resume`) is listed as that new session — idle, empty, sendable before its first prompt creates an entry — and `session` on the old id answers `replaced_by`, which the page follows (`useFollowReplacement`); a composer message that starts with a slash command (`/new`, `/compact …`, not a path) is not queued as a message; for Claude, `/new` / `/clear` followed by text asks first (`namedClear`, `session-commands.tsx`): Claude names the new session with that text, carries the name across every later `/clear` and stops generating titles — the stray 「都支持了，那 /resume…」 name came from such a send; Claude records commands as `<command-name>` + `<local-command-stdout>` lines, which become one `role:system`, `kind:slash` message (text = the command line, body = its output, ANSI stripped — `claude_command.go`; the page draws a quiet row, `chat-command.tsx`); for Claude sessions the composer's 命令 panel sends `/compact`, `/new`, `/context`, `/usage`, `/model <alias>` and opens 恢复会话, which `session.history {id}` (read, `session_history.go`) fills with the project's earlier conversations (the transcript dir, or the pane cwd in Claude's encoding for a session with none yet; title, first human message, last turn, `open` when a pane runs it — not offered) and which sends `/resume <id>`; a bare `/resume` typed in the composer opens it too; the SessionStart `resume` hook evicts / pins / marks `cleared_to` like `clear`, so the page follows; without a transcript the reply's `agent` comes from the pane's command; while the entry waits on a `permission_prompt` the reply carries `permission` — the newest tool call with no result (`permission.go`: tool, full unclipped `summary`, risk `flags` such as `bypass-sandbox` / `daemon`, full `body` up to 64 KiB for commands / diffs / file writes / plans or indented JSON args for other tools, and `truncated` if capped; timeline rows stay clipped while the pending call keeps `rawInput` only until settled) — which the page shows as a card (`session-permission.tsx`: full wrapping summary, risk badges, scrollable `ToolBody`, copy + full-view Sheet, and full captured terminal disclosure) answering only with keys that hold whatever the dialog offers: 1 (or Enter for Agy) and Esc (No / keep planning); the middle options vary by tool and mode and stay at the terminal; agents without it keep the generic key strip; 我的 › 交互调试 (`/console/me/interactions`, a 我的 page: list beside / before the selected one, `#<id>` links to one) renders every such interaction from sample data with its source and keys, taps going to a log only; `visited` is when you last visited that worktree at the terminal (ms, from `access-ledger.json` — the `Alt+g` / `Alt+x` visit clock, `WEZDECK_ACCESS_LEDGER` overrides; `session_visits.go`): the web console keeps it as navigation history but orders chats by `order_at`; `title` is the agent display name when known (Claude: the newest `custom-title` — a `/rename`, which Claude re-appends every turn — else the last `ai-title`; Claude also carries the custom title across `/clear` / `/new` as the new transcript's first line and then stops generating titles: the terminal never shows it, but the web does, so the relay drops that inherited value (`inheritedClaudeTitle`) and the card stays untitled until the session is renamed to something else — a deliberate difference from Claude's `/resume` list and pane title; Grok `summary.json` `generated_title`, including after TUI `/rename`); untitled cards (a new session before Claude names it, or one whose inherited title was dropped) show a muted 未命名会话 / Untitled session in the list, header, switcher and 恢复会话 — never the directory (the tree already groups by it) or the tmux window name (the main checkout's window is always `primary`). A message sent while Claude is mid-turn is stored as an `attachment` (`queued_command`, `origin.kind=human`) and shown as a user line; auto-continuations are not. Task notifications (`commandMode: task-notification` attachments while busy; a user line with `origin.kind: task-notification` when idle — the same notification queued and delivered shows once) show in the thread where they arrived as the terminal prints them — a quiet `role:system`, `kind:task` row, text = the `<summary>` (`Monitor event: "…"`, `Monitor "…" stream ended`, `Background command "…" completed (exit code 0)`), body = the `<event>` lines (`chat-command.tsx` `TaskEventRow`; 交互调试 › 后台任务通知) — and also land on the call that started the task (`trackTask` / `taskNotification`, `agent_claude.go`): a Monitor's events become its result (newest 40) and it stays pending until its stream ends; a background Bash gets its end summary — the call's own result must start with `Monitor started (task …` / `Command running in background with ID: …` (a command merely quoting such a line is no task). A subagent's hand-back (since Claude Code's hand-back protocol the Agent `tool_result` is only a pointer) shows as that Agent call's result: `toolUseResult.handbackReport.text` for a foreground agent, the `peer` queued_command body (matched by `origin.from` = the call's `agentId`) for a background one (`agent_claude.go`). Tool calls carry `pending` until their result arrives, and `background` when the call asked for `run_in_background`; while a Claude session's newest call is a pending foreground `Bash` / `Agent` / `Task`, that call's own row offers 转到后台 pinned to its top-right, the command text flowing around it (an invisible same-size float reserves the corner, so later lines run the full width — `ToolRow`, `BackgroundSpace`, `canBackground` in `chat-tools.tsx`; `Disclosure` `aside`; 交互调试 › 转到后台 shows a short and a long command), which sends `C-b` (Claude Code's move-to-background key; `send-keys` bypasses tmux's `C-b` prefix, so one press — at the terminal it takes two) — `foregroundCall` in `chat-thread.tsx`; the key panel keeps only Enter / Esc / Ctrl+C. Each `background` task carries what started it (`bg_detail.go`): the call's `tool`, `label` (description, else command), `command`, `started` and `at` (its message index — 跳到发起的调用) from the transcript (`trackTask`), and `tail`, the last 4 lines of `/tmp/claude-*/*/<session>/tasks/<id>.output` (ANSI stripped, a `\r` progress bar keeps its last state); the header lists them as label · elapsed · newest output line, a row opening to the command and output (`session-background.tsx`; 交互调试 › 后台任务) — the hook's summary alone was `task:<id>`. The page's status under the composer (`session-statusbar.tsx`; 交互调试 › 底部状态栏 / git 改动频繁变化), two pill lines of essentials, one row each: the **agent line** — the model (`claude-opus-5-5` → Opus 5.5, in the agent's colour; the session list keeps the agent name) and the background tasks by kind, `shell N` / `monitor N`, each opening its list upward over the thread (opening it moves nothing); the **checkout line** — branch, git changes (a fixed-width tag: every segment always, zeros dimmed, two digits each, so churning counts move nothing) and `linked N` (`worktrees` but the main checkout, `git worktree list`, 30 s cache; a popover upward). The branch truncates first, the rest folds behind +N opening upward. context and account limits follow the background tasks in the agent row. The header shows alerts at 75% and above while their tags are folded; the agent row also shows the session's execution mode (`mode`, e.g. `Auto`, `Auto off`, `Accept edits`, `Plan`, `Full access` — Claude from its transcript `permissionMode`, Agy from in-session `<USER_SETTINGS_CHANGE>` → live CLI args `--dangerously-skip-permissions`/`--mode` → `~/.gemini/antigravity-cli/settings.json` `agentMode` → `default`) and 会话信息 lists it under State; `node` and `repo_label` the relay also sends are not shown on the web; WakaTime is in the top banner. The `session` reply also carries `git` (`git_status.go`): the pane cwd's working-tree status — staged / unstaged / untracked file counts (untracked per file), `upstream`, `ahead` / `behind` — from one `git status --porcelain=v2 --branch --untracked-files=all` cached 5 s per directory with an 800 ms cap (`git_status` log row when ≥300 ms or timed out); the header shows it beside the branch — the header and the list row share one tag line (`TagLine`, `session-tags.tsx`: one line first — a long branch (`.session-tag-fill`) truncates beside the others, which keep their size, and drops to a line of its own only when less than ~7rem is left; a truncated tag shows its whole text in a tip (tap / hover, a portalled popover — nothing in the line moves; none in list rows: the row is a link); the header keeps at most two lines (`maxLines`), the rest behind +N whose panel floats over the page with every tag whole, so the header's height never changes; 会话信息 renders the same tags without a limit; neutral tags on a translucent fill that reads the same on the deck and on a surface; 交互调试 › 会话标签) — as `+S ~U ?T ↑A ↓B` (nothing to commit: 「✓ 已同步」 in green with an upstream, 「✓ 无改动」 without one — a lone ✓ was too small to read), the same counts as the tmux status line; tapping the tag (a button: Enter / Space, Esc closes) opens 「Git 状态」, which reads `session.git {id}` (read, `session_git.go`, on open only, each git call capped at 1.5 s, a `session_git` log row per read): branch → upstream and the counts in one sentence over two tabs (`Segmented`, ← → switch; one fixed body height, `min(50dvh, 24rem)`, a long list scrolling inside, so the sheet holds still): 变更 N — the changed files by state (conflict / staged / modified / untracked, at most 200) — and 提交 ↑A ↓B — not pushed (`@{u}..HEAD`, accent) and not pulled (`HEAD..@{u}`, waiting colour; 20 each) first, then the 10 recent ones — each commit on two lines (the subject wrapping whole, up to three lines, then sha · author · time), one with a body (`%b`, read in the same `git log`, clipped to 500) opening in place to it; it opens on 变更 when there are changes, else 提交 (`git-tab.ts`), never on the last choice (`session-git.tsx`; 交互调试 › git 状态面板). It also carries `reference` (`remote_reference.go`): a block for another agent — `[wezdeck 会话] <title>（<agent>）`, `session_id`, `transcript` path, `cwd` (+ branch), `tmux: -S <socket> -t <pane>（会话 …）` — which the web console's 复制引用 copies so an agent can read the conversation or drive the pane |
| `session {id, limit \| since \| before}` | read | which messages (`session_window.go`, reply `span` + `start`): `{limit}` the last N (default 60; first open, older pages), `{since: n}` from message n on — the poll; it starts earlier at a tool call still pending within the 40 before n so its result lands — and `{before: s, limit}` the page before index s (加载更早). The page keeps one cache entry per session and merges by index (`web/src/lib/session-cache.ts`), so an idle poll is ~2 KB instead of the whole page (100–500 KB), and only the newest 300 messages per session go to IndexedDB. Below: the transcript (Claude, Grok, Codex or Agy format, same locations; Agy unwraps `<USER_REQUEST>`, surfaces `PLANNER_RESPONSE.thinking` as collapsible `role:system, kind:thought` rows, maps PascalCase tool args like `Path`/`StartLine`/`EndLine`, `CommandLine`/`toolSummary`, `Target`/`Replacement`, `Content`, `steps` into summaries/diffs/previews, pairs trailing `GENERIC` outputs back to their `tool_calls` in FIFO order, and surfaces a `permission` card (with parsed `options[]` including `Always allow` prefix rules and exact cursor-relative key sequences) when a pending tool call coincides with an Agy TUI confirmation prompt on screen — escalating status to `waiting` / `permission_prompt` across `sessions` (list, unread badge, `Alt+j`), `session`, and `meta`; every parsed interaction card (permission approval, Ask, plan review, generic keys) shares `prompt-action-state.tsx` for immediate `sending` → `waiting` loading feedback until the host poll settles or a write fails) parsed **incrementally** (only bytes appended since the last read; cached per file) into user / assistant text and tool calls with details — edits (any tool whose input has old/new strings) as a `-`/`+` diff — for Claude replaced, once the call returned, by the applied patch as unified hunks with line numbers (`toolUseResult.structuredPatch`, `tool_patch.go`, ≤160 lines; the web console numbers and syntax-colours them, `chat-diff.tsx` + `lib/highlight.ts`: shiki, JS regex engine, grammar per file extension loaded on first open), whole-file writes as a preview, commands in full (judged by input shape, so the three agents' tools count alike), plus each call's result matched by `tool_use_id` (clipped); returns the last `limit` (default 60) with `total` and `start` for paging; Claude context compaction (`type:system`, `subtype:compact_boundary`) becomes a `role:system`, `kind:compact` marker (`text` = `auto`/`manual`, `body` = the summary the agent continues from — the `isCompactSummary` user line is never shown as something the human typed), and for Claude the reply also carries `subagents` (`agent_subagents.go`: each Agent-tool / forked-skill subagent from `<session>/subagents/agent-<id>.meta.json` + `.jsonl` — name or description, type, background, `running`, or `stale` after 30 min of silence without finishing (kept 2 h), tool-call count, latest tool, start and last-activity time; running first, at most 8; finished ones are not listed — like Claude Code's own panel a subagent leaves when done, its report being the Agent call's result), which the session page shows above the composer (`session-subagents.tsx`); the reply adds `compacted_at` (index of the latest marker) and `compactions`: the web console draws a divider, pages 加载更早 back to the marker and goes further only on 查看压缩前的记录 (pre-compaction history stays in the file but is no longer the agent's context); 会话信息 shows 本页已加载 N / M and the compaction count; and `usage` (model, context = last reply's full input vs the model's `max_input_tokens` from `~/.claude/cache/model-catalog`, turns, output, cache-read share; one reply spanning several lines counts once); also the last 60 screen lines (`capture-pane`). While the entry is running or waiting the reply adds `turn_started` (ms, when the turn began — attention, "Turn progress" below) and `turn_output` (the turn's output tokens: each reply's usage, once per message id, written at or after `turn_started` — `turn_output.go`; lags the TUI by one reply), and `compact_started` while a context compaction runs (`running_kind=compacting`, from Claude's PreCompact hook — the transcript has no trace of it until it is done). The web console ticks the elapsed time itself on its working line (running light, one shape whether or not a tool call is out): 运行中… 4m 39s · ↓ 19.1k tokens, or 正在压缩上下文… 36s in amber. Nothing is read off the screen for this: the TUI's status line format is not a contract. For Grok, when `updates.jsonl` has an unanswered `ask_user_question`, also `elicitation.questions[]` (label/description) so the web console can render tappable options instead of guessing 1/2/3; `plan.awaiting_approval` + `plan.excerpt` (sibling `plan.md`, Markdown on the phone) only when `exit_plan_mode` review is open — not while plan mode is merely Active writing the file — so the web matches the TUI approval bar (`a`/`s`/`q`); Grok Ask / `plan.awaiting_approval` clear on `tool_call_update` settled statuses **or** a later `turn_completed` (Ctrl+C writes `stop_reason=cancelled` without `status=completed`), and `plan_mode.json` `awaiting_plan_approval=false` wins over a stale open `exit_plan_mode`; both `elicitation` and `plan.awaiting_approval` are emitted only while attention `status=waiting` (same gate as Claude `permission`) — after abort the page must not keep the card or Working… |
| `session.image` | read | transcript image original chunks (`remote_image.go`) |
| `session.file {id, path, line_start?, line_end?}` | read | inspect a text, Markdown, or code file referenced by the session (`session_file.go`): allows regular UTF-8 files under the session's live cwd / git repo root, its own Agy brain dir (`~/.gemini/antigravity-cli/brain/<id>`), its own Grok session dir, or `~/.claude/plans/*.md` (checked after `EvalSymlinks`, refusing secret-like filenames and binaries, redacting API tokens / PEM keys, capped at 256 KiB; logs `session_file`). In `chat-markdown.tsx`, `rehypeHostFileLinks` rewrites valid `file://` links to `#wd-file:...` before sanitize/harden so clicks open the fullscreen `FileViewerSheet` (`host-file-sheet.tsx`, `Sheet fullscreen` with sticky top bar and full-height loading skeleton: `variant="document"` Markdown with heading hierarchy, Shiki fenced blocks via `doc-code-block.tsx`, responsive tables, sticky desktop TOC rail, fit-to-width Mermaid diagrams via `normalizeMermaidSvg` + optional `1:1` scroll, and nested file navigation; or Shiki-highlighted code scrolled to `#L10-L20`, plus quote-to-composer reply). Agy `write_file`/`edit_file` calls with `ArtifactMetadata.UserFacing=true` also emit a `role:system, kind:artifact` card (`agent_agy.go`, `ArtifactCard`, and `SessionDocumentsSection` in 会话信息) |
| `collab.run.chat {run, ticket?, limit?, since?, before?}` | read | parse any headless ticket run (child, Mode 3, research, verify) into `chatMessage[]` (`collab_chat.go`, logs `collab_run_chat`): prefers native CLI transcript via `findTranscript(session_id)`, falls back to `_data/<id>/runs/<run>.stream.jsonl` (Claude stream-json and Codex `--json`) and `.final.txt`, windowed via `sessionWindow`. Rendered inline in `TicketReading` with `ChatThread` (`ticket-run-chat.tsx`) |
| `collab.diff {id, child?}` | read | bounded, secret-redacted net git diff (`collab_diff.go`, logs `collab_diff`) across parent integration worktrees or child/single ticket worktrees vs `base_sha` (max 80 files, 240 lines/file, 512 KiB total). Opened from `TicketHeader` (`d` shortcut) in fullscreen `TicketDiffSheet` (`ticket-diff.tsx`, reusing `chat-diff.tsx` `ToolBody`, with per-file review notes bundled back to the ticket manager or worker). Ticket list (`tickets-view.tsx` / `ticket-list-groups.ts` / `ticket-keys.tsx`) defaults to 4 segments (`待处理 open` / `调研 research` / `已完结 ended` / `全部 all`; legacy stored `active`/`mine` fall back to `open`), groups `open` into 3 urgency tiers (`需你处理` / `执行中` / `待接手`) plus a collapsed >14-day stale strip, keeps `failed` actionable under `open`, ignores stale `running` on `closed`/`rejected` rows, folds `child` rows under `parent`, and hides internal draft research from top level. `ticket.close {id}` (write, `remote_writes.go`, in `TicketInfo`) runs `ticket close --id` with inline confirmation to archive non-terminal tickets |
| `collab.manager.chat {id, limit?, since?, before?}` / `ticket.manager.{start,park,send}` | read / write | top-level repo-neutral Ticket Manager Session (`skills/agent-collab/lib/manager.py`, workspace `~/.agent/tickets/workspaces/<id>/` with charter `AGENTS.md`, tmux `wezterm_collab_tickets`, `dead_ends.py` failure ledger injected into retries). `collab.manager.chat` reads live or parked history without archive expiry; `ticket.manager.send` auto-wakes parked managers; `sessions` cards carry `ticket_id` so Web «会话» deduplicates manager sessions while «工单» renders `TicketManagerPanel` (`ticket-manager-panel.tsx`), conversational/structured `NewTicketSheet` (`ticket-new.tsx`), per-child backend overrides on `ProposalCard` (`ticket-proposals.tsx` → `reply.backends` → `split.py --backends`), and `TicketDeliveryCard` (`ticket-delivery-card.tsx`) for integration verification & delivery confirmation |
| `session.skills {id}` | read | the skills the session's agent was actually given, for the composer's 能力 chip and `/` completion (`session_skills.go`; on demand — the `session` poll only carries `skills_rev`, count + names hash, and the page reads again when it changes). Never a directory scan (plugin and built-in skills are not on disk; each agent scans different roots): Claude — the transcript's `attachment.type=skill_listing` lines (initial replaces, a delta appends; names from the structured `names`, descriptions cut from `content` by `- name:` at a line start, empty if that text format changes; custom commands count, Claude merged them into skills); Codex — the rollout's developer message holding `### Available skills` (`- name: description (file: rN/…)`, `rN` roots expanded); Grok — `grok --cwd <dir> inspect --json` (cached 2 min per directory); Agy — scans `.agents/skills` (cwd + repo root), `~/.agents/skills`, `~/.gemini/config/skills`, and `~/.gemini/antigravity-cli/builtin/skills` `SKILL.md` frontmatter in precedence order (trigger `/`, plus Agy's built-in slash commands). Each entry gets `origin`: `wezdeck` (a platform row of `skills/manifest.tsv`) / `project` / `user` / `plugin` (`a:b`) / `builtin`; the reply adds `trigger` (`/`, Codex `$`). A `session_skills` log row per read (agent, n, ms). The web console (`session-skills.tsx`, `composer-complete.tsx`, matching in `skill-complete.ts`): 能力 N above the composer opens a sheet grouped by origin with search, a tap drafts `/name `; typing the trigger at the start or after a space opens the completion — Claude's own CLI commands (`/compact`, `/model` … not skills, listed in no transcript) first, then skills; ↑ ↓, Tab / Enter pick, Esc dismisses that token; 交互调试 › 能力与 / 补全 |
| `send {id,text,attachments}` | write | paste into the session's own TUI (`load-buffer` + `paste-buffer -p`, then Enter); `attachments` are uploaded file names, appended as a `[网页附件]` block of host paths (images numbered 图片1, 图片2 …). For Agy `/new` (same process; Agy only allocates a real `conversationId` and fires `SessionStart` after the first prompt), unpins typed resume, archives any live row on that pane, marks `cleared_to` a temporary `pending-<uuid>` id (also returned as `session_id` and logged as `session_new_conv`), so the web console switches to the blank session immediately and later follows `pending-<uuid>` → real id on the first prompt while transferring queued bubbles (`transferPending`). Terminal `Ctrl+n` (`agent-ctrl-n.sh`) marks the same `pending-<uuid>` placeholder for Agy, and `agent-session-resolve.sh` ignores `pending-*` / cleared rows so F5 never resurrects the discarded conversation |
| `upload {upload,seq,total,mime,data}` | write | one base64 chunk (≤ 64 KB decoded) of a web console attachment; the last chunk stores the file and answers its `name` |
| `key {id,key,interrupt?}` | write | Send an allowlisted terminal key. The Web Interrupt action sends `C-c` with `interrupt:true`. For Agy, Codex and Grok, the host checks for a new cancellation notice and returns whether the turn stopped. A confirmed interrupt clears a stale running state for that turn and appears as Turn interrupted above the composer. The next turn supersedes the marker. The relay logs confirmation and latency under `session_interrupt`. |
| `session.restart {id, fresh}` | write | the header's 会话操作 Sheet › 重启会话 (`fresh:false`, the desk's `F5`: respawn the pane, the agent resumes its conversation) / 新进程 (`fresh:true`, `Ctrl+Shift+n`: a blank agent process — the way out of a name Claude carries across `/clear`), each after a confirm (`session-restart.tsx`); `session_restart.go` runs `scripts/runtime/session-restart.sh --pane <pane> --agent <agent> [--fresh]` with `TMUX` set to the session's socket (`WEZDECK_SESSION_RESTART_CMD` overrides, the test stack records calls), under the same guards as `key` (listed session, live pane, desk-input hold). The script selects that pane, then `tmux-reset refresh-current-window` (resume) or `agent-ctrl-n.sh --fresh` (`AGENT_CTRL_N_PRINT_OUTCOME=1` makes it print its outcome; the hotkey path stays silent) — only that pane is respawned. A successful restart marks the old attention entry `restart_pending` before respawn, so the Web list/detail says 重启中 during the gap before SessionStart/pane-evict; then the old entry is archived and marked `cleared_to` the new id, so the page immediately follows. A fresh Claude start is named up front: a UUID in the pane option `@wezdeck_fresh_session_id`, read once by `agent-resume.sh` into `claude --session-id`; Codex and Grok use a temporary `pending-<uuid>` id until their first prompt creates the real one. Logs: `session_restart` in relay.log, `web session restart invoked/completed` (outcome, duration) in runtime.log |
| `session.handoff {id,to,note?}` | write | 按键 › 接力: replace this pane with `to` (`claude`/`codex`/`grok`), stick `@wezterm_window_agent_profile` so later F5 keeps it, cold-respawn via `scripts/runtime/session-handoff.sh`, paste a deterministic continuation brief from the source transcript (no recycle, no transcript migrate). Answers `{job}` (job carries `brief` + `session_id` when known); poll `session.handoff.job`. The page seeds a queued bubble from `brief` before the transcript poll. Same agent is refused (use 新开会话). |
| `session.handoff.job {job}` | read | handoff job stage: starting → sending → done / failed; carries `from_id`, `to_agent`, `pane`, `worktree`, optional `session_id` (Claude targets) |
| `reply {id,text,continue}` | write | `ticket reply` with `TICKET_TRIGGER_SOURCE=mobile`. With `proposal` + `verdict` (`approve` / `reject`, `text` = the reason) it answers a fan-out split proposal instead: `ticket fanout approve --run` (children created, scheduler started) / `fanout reject` (`replyArgv`, `remote_writes.go`) — riding on `reply` keeps the Runtime's C# write allowlist unchanged. The ticket page shows pending `proposals` from `api show` as cards (`ticket-proposals.tsx`: four parts — 要解决什么 / 现状核对 (missing · partial · done with evidence) / 打算怎么做 (each child's `effect`, repo / scope / order) / 确认后会发生什么 (the computed `outcome`: workers, parallel, minutes, memory (no money), branch, no push, risks) — with contract and `assumed` under 技术细节, 确认并开始 / 驳回… with a required reason, Ctrl+Enter sends, Esc backs out) in place of the free-text reply box |
| `attach {id}` | write | `ticket attach --id` (skills/agent-collab/lib/attach.py): the ticket's agent conversation opens in a new window of the target repo's tmux session through `agent-launcher.sh` with `WEZDECK_RESUME_SESSION_ID`, and an open ticket is session-claimed so headless runs stop writing to it — the web console's 接管到 tmux |
| `sent.list {scope?, session?, repo_key?, status?, limit?, before?}` | read | host-persisted outbox of web-sent messages (`remote_outbox.go`, `~/.local/state/wezdeck/sent-messages.json`, 0600, flock + atomic rename, capped at 500 records / 30 days, `WEZDECK_SENT_MESSAGES` overrides): every non-command `send` and `session.new` initial prompt is recorded before `pasteToPane` with `client_op` dedup, raw text + bare attachment names, and reconciled against the session's transcript on `session` polls (`outbox` carries unsettled `pasting` / `pending` / `unconfirmed` / `failed` rows so queued/lost bubbles survive reloads and device switches; `pruneUploads` preserves pinned attachments). Logs `outbox_record` / `outbox_reconcile` / `outbox_action` (never message text). Web UI: `SentHistorySheet` (fixed-height scroll body + `keepPreviousData` across session/repo/all tabs, `←`/`→` tab switch, `h` or Composer `＋` › 已发送记录, `↑` in empty composer recalls latest, `转工单` turns any record or failed bubble into a ticket with 0-reupload screenshots) + `OutboxNotice` + `MessageComposer` / `MessagePayloadView` |
| `sent.action {op, id}` | write | `dismiss` / `confirm` / `delete` one host outbox record |
| `repos` | read | repositories a remote web console may create a session in: main checkouts of visited worktrees (access ledger) and of running sessions, newest visit first (`session_new.go`) |
| `repo.links {repo?, cwd?, refresh?}` | read | external links of a known repository / live checkout resolved by the host's `vscode-links` CLI (`repo_links.go`, same `VSCODE_LINKS_BIN` → `native/vscode-links/bin/vscode-links` → `PATH` order as `Ctrl+k l`, cached 60 s per checkout unless `refresh:true`, 4 s cap, http(s) URLs only, `repo_links` log row per read); opened from the session list's repo header, 会话信息 or key `l` (`repo-links.tsx`; 交互调试 › 仓库外链) |
| `agent.profiles` | read | registered profile ids, configured/model state, provider defaults (Claude JSON, Codex/Grok TOML, gateway env) and masked gateway key suffixes; never returns raw credentials or command strings (`agent_profiles.go`). For `claude_kimi`, also returns Claude Code `/status` parity fields from `kimi.env` (`base_url`, `effort_level`, `auto_compact_window`, per-tier / sub-agent model ids). `session.new` accepts an optional `agent_profile`; omission keeps the repository default. |
| `agent.profile.configure {token, model}` | write | replace the Kimi profile's private `kimi.env` (mode 600, atomic rename) with the Kimi Code defaults (`https://api.kimi.ai/coding/`, `ANTHROPIC_API_KEY`, effort `high`, compact/max-context `262144` or `1048576` when the model id contains `[1m]`); one model across all Claude tiers; response and logs omit the key (`agent_profiles.go`) |
| `agent.profile.model {profile, model}` | write | set or clear a managed model override for Claude, Claude gateway, Codex, Grok or Agy; each profile has a private scalar file under `~/.config/wezdeck/agent-models/`, read by `agent-launcher.sh` on the next launch (`agent_profiles.go`) |
| `session.new.trust {job, confirm:true}` | write | after Agy's trust screen is observed in a newly created pane, a separately signed user action confirms only that pane's still-visible prompt; the first message is sent after the screen clears (`session_new.go`) |
| `session.new {repo, name, description, prompt}` | write | 新会话 by direction (`session_new.go`; web UI is message-first with a place layer for repo/direction and a third layer for a new name + purpose): `name` an existing direction (as `workstations` lists it) with an idle slot → that slot is reused, `reuse-workstation --no-attach <slot>` (job `mode` `reuse`; a slot a running job is reusing is skipped); all its slots busy → one more parallel slot (`parallel`); else a new workstation (`new`) — both through `open-task-window --no-attach --description <description> -- <name>` in `repo` (must be one of `repos`; name one line ≤ 60 with at least one ASCII letter or digit — it becomes the directory and `dev/<name>` branch; description one line ≤ 120, stored as the branch description; message 1–8000), then the message is pasted into the new agent once its process has a drawable screen. Animated startup and trust screens no longer block Agy, Codex, or Grok. Answers `{job}` at once — git fetch + agent start outlast an RPC. The message is required: a session is listed only from its first prompt's attention entry. `WEZDECK_SESSION_NEW_CMD` replaces open-task-window (test stack stand-in) |
| `workstations {repo}` | read | the repo's workstations grouped by direction (`workstations.go`): `{name, description, idle, visited, slots: [{path, name, branch, head, description, state, reason, visited}]}`, newest visit first; per-slot `description` is the value edited by `worktree.describe`, and `head` protects a later management write against stale selection. `state` is idle / running / waiting (attention) or dirty / undelivered / detached (`worktree-task idle`, no fetch — a just-merged tip may still read undelivered, the safe side; the reuse fetches and checks again) |
| `session.new {repo, new_group:true, prompt, agent_profile?}` | write | 新会话 shows the repository field first, followed by the problem to solve. The browser remembers the last repository and agent used to create a session. A new single session needs no name. The host allocates a fresh `session-<id>` worktree. The existing explicit-direction request remains available to older clients. |
| `session.new {anchor_session_id, prompt, agent_profile?, group_name?}` | write | 在此组新建会话 resolves the anchor's live checkout on the host, opens a fresh agent in a detached sibling tmux window, then sends the first prompt through the existing creation job. The source agent keeps running. When adding the first sibling, the Web form suggests a name from the source session and accepts an override. The host saves it in the checkout branch description after handing off the first message. |
| `session.delete {id, confirm:true, force?}` | write | Deleting an archived record whose pane is pinned to a different session hides only that record and preserves both the pane and its current session. The host checks the last agent's linked checkout before closing its pane. Local changes return `review_required` and leave the session available. The list links to the session. Both confirmations close the Web Sheet and hide the session immediately. The session returns if the host requires review or the request fails. Empty repositories disappear from the session list and remain available in 新会话 through the repository roots recorded in the access ledger. 会话信息 offers Git inspection and a separate confirmation to force removal. Forced removal reuses the managed worktree reclaim command and keeps the branch and transcript. The host serializes deletion with session creation and checks other panes and processes before removing a checkout. |
| `session.new.job {job}` | read | that job: `stage` creating → starting → waiting_trust → sending → done, or failed with `error`; `worktree`, `branch`, `repo_label`, `agent_profile`, `prompt`, `group_name`, `anchor_session_id`, `created_at` (kept an hour); active/recent-failed jobs also appear under `creating_jobs` on `sessions` |
| `worktree.describe {worktree, text}` | write | Edit a workstation purpose from the worktree detail or a session group. Save or Enter applies it; empty text clears it. Known primary checkouts use the current branch description. Linked workstations use `worktree-task describe`. Ticket and OpenClaw worktrees keep their own naming rules. The relay clears its description cache after a save. |
| `worktree.recycle {worktree, expected_head, confirm}` | write | After an explicit Web confirmation, recheck the selected managed workstation, HEAD, agent activity, fresh default branch, clean status and delivery. Then run `worktree-task recycle --require-delivered --no-clean-files --keep-temp-branches --fresh-agent -y`; this resets to the default tip and restarts its idle agent. Dirty, undelivered, stale or busy workstations are refused. |
| `worktree.remove {worktree, expected_head, confirm}` | write | Apply the same guards, then use the existing empty-worktree removal path, which refuses any process using the checkout. The worktree disappears; its branch and conversation history remain. Primary, ticket and OpenClaw worktrees are excluded. |
| `ticket.targets {session?}` | read | the ticket config's targets `[{key, path}]` (`$TICKETS_ROOT/config.yml`, the subset the CLI parses) plus optional `session_target` resolving the session's checkout/worktree to its configured target key |
| `ticket.draft {to, text, attachments?, session?, include_context?}` | write | single-shot host AI structuring (`ticket_draft.go` → `scripts/runtime/ticket-draft.sh` → `adversarial-review/lib/provider.sh`) returning `{title, summary, observed, assumed, suggested_to, provider}` for editable preview before creating / running a ticket |
| `ticket.new {mode?, from?, to, text?, attachments?, title?, summary?, observed?, assumed?, origin_session?, include_context?, run?}` | write | 新工单: supports single-repo (`from` defaults to `web`) and cross-repo tickets plus rich image attachments copied into `_data/<id>/attachments/` (served by `upload.get {name, ticket}` past 30-day upload pruning). `mode:"quick"` creates immediately (0-wait, preserves `## Original request` verbatim) and enriches `title`/`summary`/`observed`/`assumed` asynchronously via `ticket enrich`; `run:true` starts `ticket run --phase auto` in its own transient unit (`systemd-run --user --unit wezdeck-ticket-<id>`, `WEZDECK_TICKET_RUN_CMD` overrides) (`ticket_new.go`, `ticket_draft.go`) |
| `clear {id}` | write | mark a session read — Ctrl+X in `Alt+/`: `attention-jump.sh --forget <id> --only-if-ts <ts>` archives the live entry into `recent[]` and nudges the counters; only a listed session, and only while its entry still has the ts just read (a fresh question is never swallowed). A relay with `WEZDECK_ATTENTION_FILE` clears there (`WEZDECK_ATTENTION_STATE_PATH`), never in the live state (`remote_clear.go`). The web console: swipe a running / waiting / done row left → 标为已读 (right → 新一轮 or 复制引用; right-click / long-press menu has all three), or the button in 会话信息 |
| `device.register` | read-ish | records a remote web console's public key as pending |

Guards on every write (`remote_writes.go`; signatures `remote_device_keys.go`): one writer — a tmux-hosted
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
- The relay passes `turn_started` / `compact_started` through and adds `turn_output` from the transcript ("session" above) plus `token_rate` (effective `tok/s`, optional pure decode `tok/s` and `ttft_ms`: OTel `status.json` primary via `wezdeck-wsl otel`, transcript step-window fallback via `turn_output.go` — see [`agent-token-rate.md`](./agent-token-rate.md)). The working line shows `… · 88.6 tok/s` when known, and 会话信息 lists the full breakdown under Usage. Terminal badges treat `compacting` as plain running.

Sandbox test: `tests/hook-units/test_compaction_turn.sh` (in `scripts/dev/test-lua-units.sh`).

## Local reads and writes

A browser on the host itself reads and writes sessions without pairing, the
way it already reads tickets: the loopback Runtime answers
`GET /api/v1/remote/<action>?args=<json object>` (health capability
`remote.read`; `RuntimeWebServer.Remote.cs`, fixed allowlist, args ≤ 4 KB)
through the WSL bridge `remote.<action>`, which runs the relay's own read set
(`readRPC` in `relay.go`): `sessions`, `session`, `upload.get`, `sent.list`,
`repos`, `repo.links`, `ticket.targets`, `session.new.job`, `session.image`, `session.file`. Writes go the
same way as `POST /api/v1/remote/<action>` with a JSON object body
(capability `remote.write`; `send`, `key`, `reply`, `attach`, `upload`,
`sent.action`, `clear`, `session.new`, `ticket.draft`, `ticket.new`) into `runWrite`
(`remote_write.go`) — the very function the relay calls after
`verifyWrite`, so every guard inside the actions applies — with no device
key: the Runtime listens on loopback and answers only a loopback `Host`
(`127.0.0.1` / `localhost` / `[::1]` on its port; anything else 421 — a DNS
rebinding page sends no Origin on its same-origin GETs), 403 to an origin
outside its allowlist, and takes writes only with an `Origin` that is
allowlisted **and not loopback**: the production console writes, a local dev
server (`localhost:35790`, dedicated port away from common `3000`/`3001`) only
reads (`IsWriteOriginAllowed`).
415 to a non-JSON body (a form post cannot write), 413/400 past the size cap
before the body is read (`256 KB` for `/api/v1/remote/*`, `64 KB` for
`/api/v1/actions/*`). HTTP `/api/v1/actions/*` enforces the same
`IsWriteOriginAllowed` + JSON guards, exposes only `sessions/focus` and
`vscode/focus_or_open`, and rejects `code_command` over HTTP (clipboard, Chrome
control, and window close remain named-pipe-only for WezTerm). Writes use their own bridge connection with a 75 s timeout
(the page waits 80 s), so a slow `ticket.new` neither blocks reads nor is
reported failed and retried into a duplicate.
On the host, 会话信息 also offers 在终端中打开 (key `o` on the session
page): `POST /api/v1/actions/sessions/focus` (capability `sessions.focus`,
`SessionRequestHandler.cs`) drops the same `attention.jump` event as Enter in
`Alt+/` — workspace, tab, pane, then tmux `select-window` / `select-pane`.
The detail's `focus` (`sessionFocus`, `remote_session.go`) names the
attention row to look up: the live entry, or an archived one by id +
`archived_ts` (also for a session that took over a cleared pane). It also
carries `detached` + `tmux_session` when no tmux client shows that tmux
session: the jump would only raise WezTerm on another pane, so the page
says so and sends nothing (client trace `session-focus` with `detached`).
`session.new` avoids making such sessions: `open-task-window` run outside
tmux joins the repo's attached `wezterm_<workspace>_<label>_<hash>` session
(`provider_attached_family_session`, `tmux-agent.sh`) before falling back
to a detached `worktree_task_*` one. The 快捷键 list shows `o` only on this
computer. Over the remote link it is not offered. Trail: client trace
`session-focus`, then
`web session focus dispatched` and `jump dispatched` (`activated`) share the
Runtime's `http-…` trace id.
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
shows an empty state from structured data (`session-empty.tsx`): which agent
is ready, then its model and effort, directory, branch and session id from
the reply's session meta — a Grok's model and effort from its `summary.json`
(`grokSummaryModel`), since the transcript names a model only once a reply
exists. The pane's screen (blank rows folded) is only the fallback when the
agent itself is unknown: the raw screen of a fullscreen TUI was a status
line, forty blank rows and an input box. It still lands at the bottom
(`chat-scroll.ts` counts the loaded detail).

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

## Repo tickets & quick AI capture

Repository follow-ups live directly in the `agent-collab` ticket store
(`~/.agent/tickets/`, replacing the legacy SQLite `todos` table). On the web
console, the session header's `Repo tickets` button (shortcut `t`,
`session-tickets.tsx`) lists open tickets targeting the current session's
repository (`ticket.targets {session}` resolves linked worktrees to their
target key), lets the user jump to a ticket or drop its reference + screenshots
into the composer (`MessageComposer`), and embeds `QuickTicketForm` at the
bottom — defaulting `to` to the current repo with 1-tap switching to any other
configured target repo. Free-text + pasted screenshots create immediately
(`mode:"quick"`, `## Original request` preserved verbatim, attachments copied to
`_data/<id>/attachments/`) while `ticket-draft.sh` structures title/assumptions
in the background; checking `Run now` or clicking `AI preview` runs `ticket.draft`
first for review. Sent records (`SentHistorySheet`) and failed/unconfirmed
bubbles (`PendingBubbles`) also offer 1-tap `To ticket` with zero re-upload.

## Diagnostics on demand

No 诊断 button: the host pulls what it needs. `wezdeck-wsl diag [--wait 15]
[--reason TEXT] [--steps JSON | --steps-file F]` asks the running relay over
its control socket (`~/.local/state/wezdeck/relay.sock`, 0600;
`WEZDECK_RELAY_CONTROL` overrides) to push `{t:"diag.request"}` to every
web console seen in the last 3 min (DataChannel when open, else the DO by cid;
`relay_diag.go`). With `--steps` the web console first drives its own UI
(`lib/host-diag.ts`: `navigate` in-app paths, `back`, `click` by `text` or
`selector`, `scroll`, `wait`, `query` — read only: `selector` + `attrs` → up to ten elements' attributes, box and text, to check a fix on the person's own device and session — `reload` — run after the snapshot is sent, the
page reloads onto the newest deploy; `--reload` appends it, so after a
release `wezdeck-wsl diag --reload` puts every connected web console on the new
build — toast 即将刷新到新版本 · `<--reason>` first, then while a text field
with text has focus the reload waits for it to blur (≤ 1 min, `host-reload`
trace), and the new page says 已更新到新版本 once with the same reason
(`wezdeck.updated-from` / `wezdeck.updated-reason`, `pwa-boot.tsx`) (a build
older than this step ignores it: get it there once through 我的 › 应用 ›
检查更新 and the toast's 刷新); never a control inside a form or under
`[data-write]` — send, reply, take over, keys, options, rename), recording
each step's frames (count, fps, longest gap, gaps > 50 ms). The host's own browser (local mode: reads and writes through the Runtime, no relay link) cannot be pushed to: while shown it polls `diag.pending` every 3 s (Runtime → bridge `remote.diag.pending` → the relay's control socket `GET /diag/pending`, which also makes it a target for requests from then on; a page that polled in the last 15 s is counted like a relay client) and hands its chunks back through `diag.submit` (`POST /diag/submit`), so `diag` reaches the page the person is looking at on the desktop too. Each CLI answer carries its gist (`diagGist`): `build` vs `deployed` (`/build.json`; `current` false = the page has not reloaded onto the fix yet — do not ask for a retest), `page` and the step results without frames. It answers with
the snapshot as `diag.submit` chunks — accepted only for a live request id —
stored as `diagnostics-<ts>-<id>-<client>.json` in the uploads dir; the CLI
prints the paths. The web console toast always carries `--reason` when set
(已读取这个页面的诊断信息 · … / 调试中：… · … / 即将刷新到新版本 · …; client
trace `host-diag` / `host-reload`); relay log rows `diag_request` /
`diag_received` / `diag_done`.

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

The composer status bar shows 5-hour and 7-day account limits from the CLI's
own statusLine snapshot — no credentials or extra API calls:

- **Claude Code**: pipes `rate_limits.five_hour` / `seven_day` (`used_percentage`,
  `resets_at`) and `context_window` to its statusLine command on every refresh,
  which hands it in the background to `scripts/runtime/claude-statusline-tap.sh`:

  ```bash
  printf '%s' "$input" | bash "${WEZDECK_REPO:-$HOME/github/wezterm-config}/scripts/runtime/claude-statusline-tap.sh" >/dev/null 2>&1 &
  ```

  Snapshots land atomically at `~/.local/state/wezdeck/claude-status/<session_id>.json`
  (30-day prune; `WEZDECK_CLAUDE_STATUS_DIR` overrides).
- **Antigravity CLI (`agy`)**: `~/.gemini/antigravity-cli/settings.json` points
  `statusLine.command` at `bash /home/yuns/github/wezterm-config/scripts/runtime/agy-statusline.sh`,
  which renders model, mode, context %, and active quota group (`gemini-*` or
  `3p-*`) while tapping `scripts/runtime/agy-statusline-tap.sh` to
  `~/.local/state/wezdeck/agy-status/` (`<session_id>.json` plus `_account.json`
  so quotas arrive even before the first turn assigns a `conversation_id`;
  `WEZDECK_AGY_STATUS_DIR` overrides). `remote_limits.go` maps `remaining_fraction`
  → `used_percentage` and ignores epoch-0 `reset_in_seconds <= 0` windows.

Both adapters implement `limitsReader` (`remote_limits.go`): limits are
account-wide, so the newest snapshot (< 7 days) answers `account`, and a
session's own `context_window_size` overrides the model catalog (1M variants).
Codex reports `rate_limits` in `token_count` events too, but through the gateway
used here they are null, so Codex shows context only; Grok has no token counts.

## Agent adapters and the session contract

Everything that differs between agent CLIs stays on the host, behind one
interface (`native/wezdeck-wsl/agent_adapter.go`); the relay, the transport
and the web page only see the shared contract. Each agent is one file —
`agent_claude.go`, `agent_grok.go`, `agent_codex.go`, `agent_agy.go` — implementing:

| Method | Does |
|---|---|
| `Name()` | agent id the web console sees (`claude` / `grok` / `codex` / `agy`) |
| `Locate(home, id)` | the session's transcript path, or `""` |
| `Feed(t, line)` | one transcript line → shared messages / usage |
| `Title(path)` | agent-generated or `/rename`'d title |
| `ToolKind(name, input)` | the shared kind of a tool call (below) |
| `Capabilities()` | declared features with no code here (usage source, account limits, mid-turn input, titles) |

Agy uses `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl` for user/assistant text, tool-call summaries and token usage. Its JSONL has no tool-result IDs, so the web console does not invent paired results; the Agy TUI remains the source for detailed tool output and permission prompts.

Optional parts, called through their interface (never `if agent == …`):
`askReader.PendingAsk(path, screen)` (the unanswered Ask),
`planReader` (`PendingPlan(path)`: plan state beside the thread;
`PlanTool()`: the tool whose permission prompt approves a plan, Claude's
`ExitPlanMode`), and `limitsReader` (`AccountLimits(model)` /
`ContextSize(sessionID)`). `ask_options` / `plan_review` / `account_limits`
are derived from them (`capabilitiesOf`), so 会话信息 cannot say 否 for a
feature that works.

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

| Field | Meaning | claude / grok / codex / agy |
|---|---|---|
| `ask_options` | structured questions with tappable options (derived: `askReader`) | ✓ / ✓ / – / ✓ |
| `plan_review` | a plan waiting for approve / revise / exit (derived: `planReader`) | ✓ / ✓ / – / – |
| `usage` | where context / spend comes from | `transcript` / `none` / `token_count` / `transcript` |
| `account_limits` | 5 h / 7 d limits from the status line (derived: `limitsReader`) | ✓ / – / – / ✓ |
| `mid_turn_input` | what a message sent mid-turn does | `queue` / `queue` / `steer` / `queue` |
| `title` | the agent names sessions, honours `/rename` | ✓ / ✓ / ✓ / ✓ |

For a Grok prompt with multiple questions, a single-choice digit confirms the
current question. For multiple choice, digits toggle options and Enter confirms
the current question. The Web card follows the terminal's question counter
when the host can read it.

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
