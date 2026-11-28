# Agent collaboration (`agent-collab`, CLI `ticket`)

Status (2026-11-21): **P0–P4 live** — run observability + session reuse +
`ticket api` (P0), wezdeck Console → Collab via Runtime
`wezdeck-runtime-v2026.11.21.1` (P1), `ticket collab` parent/child scheduler
with merge + fresh verify (P2), fe1 local service v7 `collab.read` + fe1
⚙ › 跨仓协作 (P3). **P4 (re-scoped with the fe1 owner, live)**: wezdeck
sees everything; fe1 filters to fe1-related (`--repo fe1`, live); fe1 research
and future code changes run *as tickets*: fe1 flows' check defaults to
`ticket research` (parity matched on five real flags), "交给 Agent 改" opens a
collab parent, and fe1 web replies / closes / reruns through local-service jobs
(`via=fe1-web`). Remaining items: [Open questions](diagnostics.md#open-questions).

Related: [`agent-scheduling.md`](agent-scheduling.md) (channels, ticket vs
multi-dir mount), [`workspaces.md`](workspaces.md) (worktrees),
[`logging-conventions.md`](logging-conventions.md), [`guest-oom.md`](guest-oom.md).

## Naming (decided 2026-11-21, single source)

| Layer | Name |
| --- | --- |
| Capability (umbrella: initiator ↔ handler, human or agent) | **collab** — skill `agent-collab` (`skills/agent-collab/`); web / HTTP / log category stay `collab` (`/api/v1/collab/*`, `collab.read`, fe1 `/collab`, `collab.reply`, `category=collab`) |
| Unit of work | **ticket** (`req-…` ids, store `~/.agent/tickets/`) — CLI `ticket` (`create / claim / reply / close / api / research …`) |
| Parent / child fan-out | `ticket fanout plan|add|run|status` (`lib/fanout.py`) |
| Read-only research | `ticket research` (`meta.kind=research`) |
| Env | `TICKET_*`; store root `TICKETS_ROOT`; fe1 `TICKET_BIN`, `repos.yaml` field `ticket:` |
| Git | branch `ticket/<id>`, worktree `ticket-<id>`, scratch `.ticket/`; integration `ticket/<parent>-integration` |
| Log source | `source=ticket` (category `collab`) |

Renamed from `cross-repo-delegate` / `delegate` / `DELEGATE_*` in one change
([`compatibility-policy.md`](compatibility-policy.md)) with **no compat layer**:
pre-rename data was migrated once (`python3 skills/agent-collab/lib/observe.py
legacy-migrate [--dry-run]`: `delegate-<id>` worktrees → `ticket-<id>`, local-only
`delegate/*` branches → `ticket/*`, `.delegate/` → `.ticket/`, task-meta and
meta.json rewritten; pushed branches keep their names). The boundary detector
(`legacy-check`, at most daily from `ticket`) prints that command if a
pre-rename worktree ever shows up again (e.g. on another machine).

## 1. Goal and non-goals

**Goal.** Make cross-repo work a core `ticket` capability:

- One task fans out to several repos, and to several worktrees of one repo.
- Agents run concurrently under a scheduler.
- Every step can be watched live from the wezdeck web console, the fe1 web
  console, the terminal and the logs.

**What must be observable:**

- Why each agent session was started and with exactly which initial message.
- How the scheduler decided: queueing, gates, session reuse.
- What each session cost: turns, tokens, cache hit rate, memory.

**Non-goals for v1:**

- Write actions from the web (reply / close stay in the CLI and TUI).
- Remote or multi-user use.
- OS-level sandboxing beyond what `host-agent-invoke` modes already give.

## 2. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | Extend the `ticket` CLI; no rename yet | Lowest compat cost ([`compatibility-policy.md`](compatibility-policy.md)) |
| D2 | One store (`~/.agent/tickets/`). One read contract: `ticket api … --json` | Both web consoles adapt the CLI; neither parses store files ([single store rule](agent-scheduling.md#ticket-vs-multi-dir-mount)) |
| D3 | fe1 web reads through the fe1 local service (`127.0.0.1:5175`), which runs `ticket api` | Works on Linux and macOS. fe1 already owns the origin allowlist and Private Network Access |
| D4 | fe1 flag-flows move onto the core in P4. Their write-side `act` becomes a collab ticket | No second checkout / evidence / event stack |
| D5 | Same-repo parallel branches merge through an **integration child**. A conflict sets the parent to `waiting_human` | Agents never hand-resolve conflicts |
| D6 | Concurrency is dynamic: the memory gate (measured per-child estimate + reservations) limits; `TICKET_MAX_PARALLEL` 8 / per-repo 4 are ceilings only (was a fixed 3 until 2026-11-25) | Guest OOM history; implement children peak 2–4 GB, research ~0.3 GB |
| D7 | Sessions are reused inside one role chain and forced fresh for independent verification (§5) | Saves cost without biasing reviewers |
| D8 | The initial message of every session is stored immutably and content-addressed (§4) | You cannot debug or tune what you cannot replay |

## 3. Concepts

```
parent ticket (协同单, meta.kind=parent)   ticket fanout plan --contract FILE
 ├─ contract.md       interfaces, order, per-child path scope (authored by the
 │                    initiating TUI agent; embedded into every child prompt)
 ├─ child A  (repo X, worktree ticket-A, scope src/a/**)  ─┐
 ├─ child B  (repo X, worktree ticket-B, scope src/b/**)  ─┼─ parallel when gates allow
 ├─ child C  (repo Y, depends_on A)                         ─┘
 └─ integration step  merge child branches per repo → fresh-session verify
```

- **Ticket.** The existing model. A **child** is a ticket whose `meta.json`
  carries `parent`, `depends_on` and `scope`, so claim / challenge / reply work
  on it unchanged. `ticket fanout add` creates one.
- **Parent phases** (ticket `phase`): `planning → running → integrating →
  done`; side exits `waiting_initiator` with phase `running` (a child waits on
  a human or failed), `integration_conflict`, `verify_failed`.
- **Run.** One agent process invocation (`run-<ts>-<hex6>`). A ticket has many
  runs: phases, retries, resumes, integration verify.
- **Session.** The backend's conversation id. One session can span several
  runs (resume) or branch off another (fork).
- **Research ticket** (`meta.kind=research`, `ticket research`): one
  read-only run over one or more repos checked out detached at `origin/HEAD`
  (several repos → one subdir each), straight to shipped/failed, worktrees
  removed. Callers keep product semantics (prompt, `--system-file`, per-repo
  `--allow-tool 'Bash(git -C {repo} log:*)'`, result JSON, evidence checks) —
  the substrate for fe1 flows' check step. Any write splits into children.

## 4. Session launch observability (initial message and why)

Each run writes a **launch record** before the CLI starts:
`_data/<id>/runs/<run>.launch.json`. A web view of this record answers
"what did this agent see first, and who asked for it?".

| Field | Content |
| --- | --- |
| `trigger` | `{source: human-tui\|cli\|cron\|fe1-flow\|parent\|retry, actor, origin_session, origin_repo, cmdline}`. `origin_session` is read from the initiating TUI's `CLAUDE_SESSION_ID` / `CODEX_THREAD_ID` when present |
| `prompt` | `{sha256, bytes, est_tokens, path}`. The body goes to `prompts/<sha256>.md` (content-addressed, written once, deduped across runs) |
| `composition` | An ordered list of the prompt's sections, each `{kind: template\|phase_view\|contract\|feedback\|continuation, source, git_blob, bytes, sha256}`. It answers "which template version, which ticket sections, which contract revision" |
| `continuation` | For resume and fork: the follow-up message only, also content-addressed, plus `from_session` |
| `invocation` | `{backend, mode, model, effort, cwd, worktree, base_sha, add_dirs, argv}`. `argv` excludes the prompt body. Env is listed as **key names only**, from an allowlist |
| `cli_init` | Not in the launch record (it arrives after launch): the run record's `cli_init` plus a `session_init` event, copied from the CLI's own init event — `session_id, model, cli_version, tools[], mcp_servers[], permission_mode, cwd`. Claude: `system/init`. Codex: `thread.started`. Grok: `available_commands` + `end` (its session id only arrives at the end) |
| `gates` | The scheduler decision that let this run start (§6) |

Redaction:

- Prompt bodies pass the repo-hygiene secret heuristics before they are
  written. A hit is replaced by `«redacted:<rule>»`, and the event logs the
  rule name.
- Prompt bodies are served only by `api prompt`. Both web consoles fetch that
  from loopback, so prompt text never reaches a server.

## 5. Session reuse

Today every phase is a fresh process, and the Claude write path uses
`--output-format text`, so no session id, turns or usage are recorded. All
three CLIs support resume and fork by id (checked in `--help`):

- `claude --resume <id> [--fork-session]`
- `codex exec resume|fork <id>`
- `grok --resume <id> [--fork-session]`

| Situation | Mode |
| --- | --- |
| Same ticket, role, backend and worktree: research → implement, challenge → reply → continue, retry | `resume` |
| Parent plan → children | `fork` from the plan session if cross-cwd fork works (P0 check); otherwise `fresh` + the contract placed first in the prompt |
| Integration / acceptance child, adversarial review | `fresh`, forced ([why](adversarial-review.md)) |
| Different backend, different repo | `fresh` |

**Resume cost rule.** After the prompt-cache TTL lapses (Claude: 5 min by
default, 1 h when enabled), a resume re-writes the whole history into the
cache. So the scheduler:

- picks `resume` when `idle < cache_ttl` or `history_tokens < TICKET_RESUME_MAX_TOKENS` (default 80k);
- otherwise picks `fresh`.

Session state lives in `meta.json`:
`sessions.<role> = {backend, id, last_used, history_tokens}`. Every launch
records `{reuse, reason}`, where `reason` is one of `warm_cache`,
`small_history`, `stale_cache`, `forced_independent`, `backend_changed` or
`no_prior`. That makes the threshold tunable from data.

## 6. Scheduler (`lib/fanout.py`)

- **Entry point.** `ticket fanout run --parent <id> [--detach]`. It holds
  `.locks/scheduler.<parent>.lock` (one scheduler per parent) and writes
  `_data/<parent>/scheduler.pid`; `--detach` re-execs in a new session with
  its log at `_data/<parent>/scheduler.log`. Rerunning is safe: it picks up
  from the store (after a human `reply`, or after fixing a conflict).
- **Standalone runs share the budget** (`lib/gate.py`, 2026-11-25). A
  `ticket run` outside a scheduler (`create --run`, `reply --continue`,
  `watch`, the web console's 新工单) waits for a free slot in the same
  `.locks/slots/` pool and the same memory check, then execs the run with
  the slot's lock fd inherited, so the slot lives exactly as long as the
  run. Every slot file records its holder's pid (`Slot.claim`; the scheduler
  writes its child's), and the reservation is global: Σ over held slots of
  estimate − that pid tree's RSS (`reserved_mb`), so fan-out and standalone
  runs see each other. Waiting writes `queued` (gate `slot` / `mem`, with
  `mem_available_mb` / `reserved_mb` / `est_mb`) and a `queued` progress
  step; going through after a wait writes `dispatched` with
  `queue_wait_ms`. Scheduler children (`TICKET_PARENT_SCHEDULER`) skip it.
- **Shared queue.** Children are re-read every tick (`child_joined` event), so
  `fanout add` mid-run is picked up. A child under a live session lease
  (`ticket_fs.session_holder`) gets gate `session` and is waited on, never
  dispatched; a worker that loses the claim race to a session is not counted
  as a retry. `claim` refuses a child whose `depends_on` has not shipped
  (`deps pending`); `inbox` lists `parent` / `blocked_by`.
- **Children** run as `run.sh run --id <child> --phase auto` subprocesses with
  `TICKET_TRIGGER_SOURCE=parent`, so each child keeps its own worktree,
  lease, session reuse and run records.
- **Gates**, in order; the first failing one emits a `queued` event on the
  parent (only when the reason changes):
  1. `deps` — every `depends_on` child is `shipped`/`closed` (`blocked` when a
     dependency failed or waits on a human).
     A session-held child stops here with gate `session`.
  2. `slot` — this scheduler's `--max-parallel` and a free lock in the global
     pool `.locks/slots/` (`TICKET_MAX_PARALLEL`, default 8 — a ceiling) shared
     by all parents.
  3. `repo_cap` — running children in the same repo < `TICKET_MAX_PER_REPO` (4, ceiling).
  4. `path_overlap` — scope prefixes (glob text before the first wildcard) do
     not overlap a running sibling in the same repo; no scope = whole repo.
  5. `mem` — `MemAvailable − reserved − estimate ≥ TICKET_MEM_FLOOR_MB (2048)`.
     *estimate* = p95 `rss_peak_mb` of the last 30 real implement runs of the
     backend (`mem_estimate_mb`; < 3 samples → 1500; `TICKET_RUN_MEM_MB`
     pins it). *reserved* = Σ over running children of estimate minus the
     child's current process-group RSS — a fresh dispatch has not grown into
     MemAvailable yet, so without it one tick could over-dispatch. This is
     the real concurrency limit (44 GB guest, 3.9 GB estimate → ~7). Tests
     point `TICKET_MEMINFO_PATH` at a fake file.
- **Events on the parent:** `scheduler_start`, `queued`, `dispatched` (slot,
  queue wait, attempt, pid, MemAvailable, `est_mb`, `reserved_mb`; `scheduler_start` has
  `est_source` / `est_samples`), `child_exit`, `retry`, `merge`,
  `verify`, `scheduler_end` (done / waiting / failed / blocked, peak
  parallelism, wall time). `api metrics --parent` adds `realized_parallelism`
  = Σ run wall ÷ (last end − first start).
- **Failure handling.** A child that exits without a terminal status is
  dispatched once more (its session resumes when warm); a second miss marks it
  `failed`. A child in `waiting_initiator` blocks its dependents; when nothing
  else can start the parent goes to `waiting_initiator` and the scheduler exits.
- **Integration step** (after every child shipped; `--no-integrate` skips):
  1. Per repo, a worktree `.worktrees/<repo>/ticket-<parent>-integration` on
     branch `ticket/<parent>-integration` from `origin/HEAD`.
  2. Implement workers edit without committing, so each child's worktree
     changes are first committed onto its own `ticket/<id>` branch
     (`snapshot` event; `.ticket/` excluded; the repo's `.gitignore`
     applies). Branches then merge `--no-ff` in dependency order; merged ones
     are skipped, so reruns are idempotent.
  3. Conflict → `merge --abort`, a `merge` event with the conflicted files,
     parent `waiting_initiator` / `integration_conflict`.
  4. Otherwise a **fresh** read-only verify run per repo
     (`prompts/integrate.md`: contract + merged diffstat; reuse reason
     `forced_independent`) prints a `{"verdict","findings"}` JSON, read from
     `runs/<run>.final.txt`. Pass → parent `shipped` / `done`.
- **Splits are proposals; the user confirms every one** (`lib/split.py`,
  2026-11-25). Proposals live in `_data/<parent>/proposals.json` with events
  `proposal_created` / `proposal_approved` / `proposal_rejected`.
  - `fanout draft --from K --repos A,B --title T --goal-file F` runs a
    read-only plan agent (`prompts/plan.md`, through `research`, so it is a
    research ticket with full run records). Its JSON (contract + children with
    keys, scope, `depends_on` by key) is validated first — allowlisted targets,
    known deps, no cycle, ≤ `TICKET_MAX_CHILDREN` (12) — then stored as a
    pending draft; overlapping scopes in one repo come back as `warnings`.
    The parent waits in `plan_review`; `fanout run` refuses until
    `fanout approve --parent P --proposal p1 [--only k1,k2]` creates the
    children (deps mapped to real ids). `reject --reason` marks the parent
    terminal `rejected` (`plan_rejected`) so abandoned drafts leave the inbox.
    Parent tickets record their target `repos` (from `--repos` or child `to`s,
    rather than `from → from`), and `ticket set-from --id ID --from SOURCE`
    updates an initiator origin (including non-repo origins like `human` / `web`)
    with a `from_changed` event. Separately, `meta.json` records `handler`
    (`{repo, cwd, session, via, updated_at}`, auto-captured on `plan`/`approve`
    or updated via `ticket set-handler --id ID --repo R`, emitting
    `handler_changed`) so orchestrating a ticket from a third repo leaves `from`
    and `to` untouched while staying visible and filterable via `--repo`.
  - A running child (phase view tells it how) may `fanout propose --by-child C`
    one sibling whose scope sits **inside C's scope**. One level: an approved
    split carries `split_from` and cannot split again; pending proposals count
    toward the 12-child cap. The scheduler keeps running everything else and,
    once the rest is done, parks the parent in `split_review` (result
    `awaiting_approval`) instead of integrating; approve/reject, then rerun.
  - **What the approver reads** (2026-11-25, after a draft came back as a
    bare child list and the user asked "what are you going to do?"): the plan
    agent must first check every goal item against the default branch
    (`status_check`: missing / partial / done + evidence; done → no child,
    partial → the child names what it reuses) and write `summary.problem` /
    `summary.approach` and a plain `effect` per child — a draft missing any of
    them is refused before review. When the goal touches DB schema or data
    migrations, `prompts/plan.md` also requires reading the target repo's
    release and migration docs first so multi-release rules (e.g. add-column
    migration in Release N, ORM schema/code in Release N+1) and manual prod
    apply gates appear in `summary.approach`, child boundaries, `contract`, and
    `risks`. `outcome` is computed by `split.py`, not
    the model: workers, max parallel (dependency width ∩ ceilings ∩ memory),
    stages, memory peak, minutes from this machine's run records (no money:
    the user does not want quota estimates on tasks),
    delivery branch, `pushes: false`. CLI relay (SKILL.md "Say it before doing
    it") and the web card show the same four parts: 要解决什么 / 现状核对 /
    打算怎么做 / 确认后会发生什么; contract and `assumed` sit under 技术细节.
  - Agents run `approve` only after the user said yes in chat — never on a
    worker's or plan agent's say-so. The web console's ticket page shows the
    same proposals (`api show` `proposals`, the draft's contract included)
    with 确认并开始 (= `approve --run`) / 驳回 (reason required); see
    [`remote-sessions.md`](remote-sessions.md) `reply`.
- **Deferred:** forking children from the plan session (today children start
  fresh with the contract placed first).

## 7. Data layout

```
~/.agent/tickets/
  events.jsonl                 # global stream, seq-numbered (cursor)
  events.head                  # last seq + byte offset (fast tail)
  prompts/<sha256>.md          # content-addressed initial / continuation messages
  _data/<id>/
    ticket.md meta.json progress.json events.jsonl   # existing (events gain the envelope)
    contract.md                # parent only, versioned in events by sha
    dead_ends.md               # failed runs & rejected splits (bounded ≤2 KB injected into worker prompts)
    runs/<run>.launch.json     # §4
    runs/<run>.json            # run record (§8)
    runs/<run>.stream.jsonl    # raw CLI stream (replaces worker.log / implement.log)
  workspaces/<id>/
    AGENTS.md                  # repo-neutral top-level Manager Session charter (`ticket manager start|resume|park|gc`)
  .locks/{tickets.lock, scheduler.<id>.lock, slots/N.lock}
```

The Web ticket manager uses the machine's active agent profile on start or
wake, and refuses a disabled profile before opening a pane. It reports a live
session only after the agent TUI is ready. A stale pane that fell back to a
shell is shown as parked; wake replaces it, and send never pastes into that
shell. Switching agent families starts a fresh conversation rather than
passing the previous family's session id to the new CLI.

- **Retention.** `ticket gc` removes the stream, launch and events files
  after 30 days (`TICKET_KEEP_DAYS`). Prompts that no remaining launch
  references are removed with them. Ticket `meta` and run records are kept
  until the ticket is archived.
- **Old tickets.** The existing 83 tickets keep working without migration.
  Their old `type` events are read as envelope `kind`.

## 8. Event envelope, run record, metrics

Every event uses this envelope. The payload stays **flat** next to it (and
`type` mirrors `kind`) so pre-v1 readers such as `ticket watch` keep working:

```json
{"v":1,"seq":1042,"ticket":"req-…","parent":"req-…","run":"run-…","kind":"tool","type":"tool","name":"Read","target":"…","ts":"…","id":"req-…"}
```

Pre-v1 rows in old tickets have no `seq`; `api events --ticket` returns them as
`v: 0` on a full read.

- **Writing.** Events are appended to the ticket file and the global file in
  batches every ≤1 s, while holding `tickets.lock`. `seq` is allocated under
  that lock.
- **Caps.** Text is capped at 400 chars and `data` at 20 KB.

| kind | data | Producer |
| --- | --- | --- |
| `created` `claimed` `renewed` `released` `challenge` `reply` `status` `closed` `progress` | existing fields | lifecycle |
| `queued` / `dispatched` / `child_joined` | `gate` (incl. `session`; detail = holder), `detail, slot, queue_wait_ms, mem_available_mb` | scheduler |
| `run_start` | launch-record summary (`trigger.source, prompt.sha256, est_tokens, session.reuse, reason`) | invoke |
| `session_init` | `cli_init` | stream parser |
| `tool` | `name, target` (truncated path or command) | stream parser |
| `milestone` | `text` (agent lines that start with `进展：`) | stream parser |
| `run_end` | run-record summary | invoke |
| `merge` | `branch, into, result` | integration |
| `error` | `where, message` | any |

**Run record** (`runs/<run>.json`):

```
run, ticket, parent, phase, role, backend, model, cli_version, mode,
session{id, reuse, from, reason}, queue_wait_ms, wall_ms, turns, attempts,
tokens{input, cache_read, cache_write, output}, cache_hit_rate, cost_usd,
tool_calls, denials, rss_peak_mb, exit
```

How token fields are normalized:

| Backend | Source | Mapping |
| --- | --- | --- |
| claude | `stream-json` `result` | `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `num_turns`, `total_cost_usd` |
| codex | `exec --json` `turn.completed.usage`, summed over turns | `input = input_tokens − cached_input_tokens`, `cache_read = cached_input_tokens`, `cache_write = null` |
| grok | `streaming-json` `end` | `num_turns`, `total_cost_usd`, `usage.input_tokens`. Cache fields are verified in P0 |

- Unknown values are `null`, never `0`.
- `cache_hit_rate = cache_read / (input + cache_read + cache_write)` over the
  non-null terms.
- `rss_peak_mb` is sampled from the run's process group by the existing
  heartbeat loop.

**Metrics** are computed by `api metrics` from run records and events, so
nothing is stored twice:

- **Run:** every run-record field.
- **Ticket / parent:**
  - session count by reuse mode, total turns, token-weighted cache hit rate, cost;
  - realized parallelism = Σ run wall time ÷ critical-path wall time;
  - queue time by gate.
- **Global (1 h / 24 h / 7 d):**
  - running, queued and `waiting_human` counts, and peak concurrency;
  - gate denials by reason and reuse decisions by reason;
  - cache hit rate by backend × reuse mode;
  - cost by repo and by backend;
  - p50 / p95 run wall time;
  - prompt size by phase.

## 9. Read contract: `ticket api`

- Read-only and JSON-only. Typical latency is under 300 ms.
- Errors come back as `{"ok":false,"error":{code,message}}` with exit code 0.
- Each response has a JSON Schema in `skills/agent-collab/schema/` and
  carries `"v":1`.

| Command | Returns |
| --- | --- |
| `api health` | `{v, store, tickets, running, queued, waiting_human, seq_head, capabilities[]}` |
| `api list [--status] [--repo] [--parent] [--since] [--limit]` | ticket summaries + last progress + child counts |
| `api show --id` | meta, sections (sans prompts), children (`children_detail` with live scheduler `gate` and `last_milestone`), `collab` (`scheduler` alive/pid + `integration`), `contract.md` sha, runs (summaries), `questions` (structured challenge options while `waiting_initiator`, else null — see `SKILL.md` D), `reference` (below) |
| `api events --after <seq> [--ticket] [--limit 500]` | `{events[], next}`. This is the poll cursor |
| `api run --run <run>` | launch record + run record |
| `api prompt --sha <sha256>` | redacted prompt / continuation body |
| `api transcript --run <run> [--tail n]` | compressed stream: tool lines, milestones, final text |
| `api metrics [--window] [--parent]` | §8 metrics |

**Ticket reference** (`reference` in `api show`, `lib/reference.py`): a text
block for another agent, sibling of the session reference
([`remote-sessions.md`](remote-sessions.md)). It opens with `[wezdeck 工单]
<title>` and lists, leaving out empty lines: id / kind / parent; route,
status + phase, owner, claimer and claim generation; origin (`meta.json`
`origin`, e.g. fe1-flows flow / step); created / updated; progress; summary /
solution doc / source PR; repos with the checkout base `@head` (from
`checkout` events); worktree + branch; the store dir; contract sha and
integration branches (parents); run totals (count, failures, turns, token
split, cache hit, cost, wall) and the last run (phase/role, backend/model,
exit, session reuse/reason, trigger, start) with its record files and the
`ticket api prompt --sha` of its initial message; each role session (backend,
id, history tokens, cache TTL); children with status; and the `ticket api`
commands that read the rest. The web console's ticket page copies it with
复制引用 (`ticket-copy-reference.tsx`); in a terminal: `ticket api show --id
<id> | jq -r .reference`.

## 10. Observation surfaces

**wezdeck web.** Requires a Windows runtime release
([`wezdeck-runtime-release.md`](wezdeck-runtime-release.md)).

1. `native/wezdeck-wsl/serve.go`: `case "collab.<action>"` for an allowlist of
   `health, list, show, events, run, prompt, transcript, metrics`. Each runs
   `$WEZDECK_REPO/skills/agent-collab/ticket api <action> …` with a
   5 s timeout.
2. `RuntimeWebServer.cs`:
   - Add `GET /api/v1/collab/{action}` → `ReadBridge("collab", action, query)`.
   - Allowlist the same actions in C#. Do not add a generic bridge passthrough.
   - Add the capability `collab.read`.
3. `web/src/lib/runtime-contract.ts`: zod schemas mirroring `schema/*.json`.
   `runtime-client.ts`: `getCollab*()`, gated on capability.
4. 工单 › 运行、缓存与花费 (`web/src/features/collab-metrics.tsx`): the
   `api metrics` band with a window (1h…all) and a repo filter (from / to,
   repos taken from the ticket list; `health` and `metrics` take `--repo`
   through the bridge). Headline cells: running, waiting on human, runs,
   failed runs, sessions, turns, tokens, cache hit, resume / fresh hit, cost,
   parallelism, wall p50 / p95 and total, RSS p95 / peak, token split.
   分组明细 (folded): by target repo, backend and session reuse (runs, cache
   hit, cost), by trigger, and initial-prompt est. tokens per phase. fe1's
   /collab shows a subset of the same `api metrics` fields.
4. A new `web/src/features/console-collab.tsx` plus a nav entry:
   - **Board:** columns by status; parents show child progress.
   - **Workflow progress & timeline (`ticket-pipeline.tsx`, `ticket-timeline.tsx`):**
     top step strip across the full lifecycle (parent: Plan → Approval →
     Workers → Merge → Verify → Done; child/ticket: Queued → Worktree →
     Research → Implement → Done; research: Checkout → Research → Done) with
     live `progress` / `last_milestone` banner and scheduler badge; `Children`
     table surfaces each child's active phase, queue gate (`deps`,
     `path_overlap`, `mem`, `slot`, `repo_cap`, `session`, `blocked`), and
     latest milestone; foldable chronological timeline reads `api events
     --ticket` (filtering out per-tool stream noise).
   - **Run inspector:** launch record (trigger chain, composition table,
     prompt viewer), live tool and milestone stream, run record.
   - **Metrics:** reuse mix, cache hit by backend, gate denials, cost.
5. Refresh. `console-data.tsx` polls `events --after` every 2 s while
   `running > 0`, otherwise every 30 s. A typed `collab.changed` on `/events`
   is a later optimisation.

**fe1 web:**

1. `cloud/packages/local/src/contract.ts`:
   - `collab.*` routes mirroring §9 (`GET /collab/health|tickets|tickets/{id}|events|runs/{run}|prompts/{sha}|metrics`), with zod generated from the same JSON Schemas.
   - The capability `collab.read` appears only when `ticket` resolves.
   - Bump `LOCAL_VERSION`.
2. `server.ts`: run `execFile` against `ticket api` with a 5 s timeout,
   behind the existing origin allowlist.
3. Team app pages `routes/collab.index.tsx` and `collab.$id.tsx`. These reuse
   the `flow-progress` timeline, since the event kinds are a superset of
   fe1's.

**Terminal and logs:**

- A `collab` plugin under `wezterm-x/plugins/` renders the right-status badge
  `Collab·2▶ 1⏳` (running / waiting on a human) from `api health`. Its
  sampler runs every 10 s.
- `waiting_human` parents write an attention entry. The keyboard path is the
  existing `Alt+/` jump, plus `ticket board` / `ticket watch`. v1 adds no
  new hotkey.
- A `collab` log category: one `runtime.log` row per status transition, per
  `run_end` (with tokens, cache and cost) and per gate denial. This feeds
  `/api/v1/diagnostics`, `workflow-timeline` and habit-report.

## 11. Implementation plan

**P0 (landed 2026-11-21): contract + launch/run observability.** Code:
`scripts/dev/host-agent-invoke/lib/run_observe.py` (launch record, stream
parser, RSS sampler, run record; `--run-dir/--resume/--fork` flags),
`skills/agent-collab/lib/observe.py` (envelope + global seq, sink,
prompt store + redaction, reuse decision, `collab` rows in `runtime.log`),
`lib/api.py` + `schema/*.json`, worker wiring (resume → one fresh retry on
failure), `进展：` lines requested by both prompt templates. Tests: recorded
streams in `scripts/dev/host-agent-invoke/tests/fixtures/` drive
`host-agent-invoke/test.sh` and the observability block of
`tickets/test.sh` (schema validation of every `api` command,
reuse reasons, redaction, cursor paging, resume fallback).

**P1 (code landed 2026-11-21): wezdeck web, read-only.** `native/wezdeck-wsl/collab.go`
(allowlisted `ticket api` exec, 5 s timeout, Go tests), `RuntimeWebServer`
`/api/v1/collab/<command>` + `collab.read`, `web/src/features/console-collab.tsx`
(metrics band, keyboard listbox of tickets, run table, launch record with
trigger chain / composition / initial prompt, live transcript; 2 s poll while
anything runs, 30 s idle). Verified with the mock runtime proxying the real
`ticket api` over the e2e store and `web/tests/collab.cdp.test.ts` (headless
CDP). Parent swimlanes wait for P2's parent/child model.

**P2 (landed 2026-11-21): parent/child + scheduler.** `lib/fanout.py`,
`prompts/integrate.md`, contract embedding in child phase views, `api show`
children/integration, `api metrics --parent` parallelism, Collab page children
table. Offline: `test-fanout.sh` (caps, overlap serialization, deps order, mem
gate hold/resume, human gate blocking, retry, merge ok/conflict, verdict
parser). Live e2e result is in §13.

**P3 (live 2026-11-21): fe1 web.** fe1 `5eb846b`: contract `GET /collab/{command}`
(capability `collab.read`, allowlisted params, fe1 origin only), `collab-route.ts`
running `ticket api`, ⚙ › 跨仓协作 page. Original plan: the local-service routes and the pages. Verify with fe1's
oRPC contract tests against recorded `ticket api` fixtures, plus a page CDP
smoke.

**P4: fe1 flows on the core.**

- Flows call `ticket create --mode research --repos …` for checks.
- `act` with code changes creates a parent ticket.
- fe1's `withCheckouts`, `stream.ts` and event writer are retired.

Verify parity: the same flag through the old and the new path gives the same
verdict and the same verified refs.

Each phase lands on its own: commit, push, `sync-runtime`, and docs updated in
the same change, following the standing policy.

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| Parallel agents trigger guest OOM | Memory gate sized from measured `rss_peak_mb` p95 plus reservations for children still ramping; ceilings 8 / 4 per repo; pin with `TICKET_RUN_MEM_MB` |
| Global event file contention under many tool events | ≤1 s batching, short lock hold. Measure lock wait in P2 |
| A prompt leaks a secret into the web | Redaction at write time, loopback-only serving, prompts never sent to servers |
| CLI stream formats change on upgrade | Recorded fixtures plus a parser that ignores unknown events and counts them as `unparsed` in the run record |
| C# route change needs a Windows release | Bundle P1 into one release. The bridge allowlist keeps later actions C#-free where possible |
| Same-repo branches drift semantically despite clean merges | The integration child's fresh-session verify, plus the existing delivery gate before ship |

## 13. Measurements (2026-11-21)

| Question | Result | Consequence |
| --- | --- | --- |
| Claude `--resume <id> --fork-session` from another cwd? | Works (new session id, history kept) | plan → child may `fork` |
| Grok cache + session id? | `usage` / `end` carry `cache_read_input_tokens` and `cache_creation_input_tokens`; input excludes cache reads; `sessionId` only on `end`; `--resume … --fork-session` works across cwd | normalized like Claude; `session_init` emitted at end |
| Codex `exec resume` / `fork` with write flags? | Both accept `--json`, but **not** `--full-auto` / `--sandbox` | resume/fork pass `-c sandbox_mode=… -c approval_policy="never"`. Live run still unverified: the codex gateway returned 503 during the probe; the codex fixture is synthetic |
| Prompt-cache sharing between fresh sessions? | Claude fresh sessions share ~12.3k tokens (tool block) regardless of cwd; the rest is written per session. Resume/fork read ~19k | fork / resume is the only way to share real context |
| Real e2e (scratch repos, Claude) | research fresh: hit 75.3%, 19 s, 304 MB · implement resumed (`warm_cache`, idle 14 s): hit **94.9%**, 15 s, 300 MB | resume is the default inside a role chain |

| P2 real e2e (3 scratch repos, Claude) | A ∥ B in one repo (disjoint scopes), C queued on `deps` until A shipped; peak 3, 113 s; children resume hit 95.2% vs fresh 77.9%; integration snapshot + merge 2 + 1 branches, two fresh verify runs pass; merged code matches the contract | found + fixed: `meta.json` `branch` was never recorded (set in a `$(…)` subshell), and verify reported `pass` when nothing merged (now `skipped` → `done_unmerged`) |

Still open: a live codex run once its gateway is back (`ticket create … --run
--backend codex` against a scratch target), then replace the synthetic fixture.
