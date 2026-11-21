# Cross-repo collaboration (core CLI)

Status (2026-11-21): **P0–P3 live** — run observability + session reuse +
`delegate api` (P0), wezdeck Console → Collab via Runtime
`wezdeck-runtime-v2026.11.21.1` (P1), `delegate collab` parent/child scheduler
with merge + fresh verify (P2), fe1 local service v7 `collab.read` + fe1
⚙ › 跨仓协作 (P3). **P4 deferred** — see
[Open questions](diagnostics.md#open-questions).

Related: [`agent-scheduling.md`](agent-scheduling.md) (channels, ticket vs
multi-dir mount), [`workspaces.md`](workspaces.md) (worktrees),
[`logging-conventions.md`](logging-conventions.md), [`guest-oom.md`](guest-oom.md).

## 1. Goal and non-goals

**Goal.** Make cross-repo work a core `delegate` capability:

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
| D1 | Extend the `delegate` CLI; no rename yet | Lowest compat cost ([`compatibility-policy.md`](compatibility-policy.md)) |
| D2 | One store (`~/.agent/tickets/`). One read contract: `delegate api … --json` | Both web consoles adapt the CLI; neither parses store files ([single store rule](agent-scheduling.md#ticket-vs-multi-dir-mount)) |
| D3 | fe1 web reads through the fe1 local service (`127.0.0.1:5175`), which runs `delegate api` | Works on Linux and macOS. fe1 already owns the origin allowlist and Private Network Access |
| D4 | fe1 flag-flows move onto the core in P4. Their write-side `act` becomes a collab ticket | No second checkout / evidence / event stack |
| D5 | Same-repo parallel branches merge through an **integration child**. A conflict sets the parent to `waiting_human` | Agents never hand-resolve conflicts |
| D6 | Global concurrency defaults to 3, gated by guest memory headroom | Guest OOM history |
| D7 | Sessions are reused inside one role chain and forced fresh for independent verification (§5) | Saves cost without biasing reviewers |
| D8 | The initial message of every session is stored immutably and content-addressed (§4) | You cannot debug or tune what you cannot replay |

## 3. Concepts

```
parent ticket (协同单, meta.kind=parent)   delegate collab plan --contract FILE
 ├─ contract.md       interfaces, order, per-child path scope (authored by the
 │                    initiating TUI agent; embedded into every child prompt)
 ├─ child A  (repo X, worktree delegate-A, scope src/a/**)  ─┐
 ├─ child B  (repo X, worktree delegate-B, scope src/b/**)  ─┼─ parallel when gates allow
 ├─ child C  (repo Y, depends_on A)                         ─┘
 └─ integration step  merge child branches per repo → fresh-session verify
```

- **Ticket.** The existing model. A **child** is a ticket whose `meta.json`
  carries `parent`, `depends_on` and `scope`, so claim / challenge / reply work
  on it unchanged. `delegate collab add` creates one.
- **Parent phases** (ticket `phase`): `planning → running → integrating →
  done`; side exits `waiting_initiator` with phase `running` (a child waits on
  a human or failed), `integration_conflict`, `verify_failed`.
- **Run.** One agent process invocation (`run-<ts>-<hex6>`). A ticket has many
  runs: phases, retries, resumes, integration verify.
- **Session.** The backend's conversation id. One session can span several
  runs (resume) or branch off another (fork).
- **Read-only multi-repo research** (fe1's current mode) stays a single run
  over a shared parent dir. Any write always splits into children.

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

- picks `resume` when `idle < cache_ttl` or `history_tokens < DELEGATE_RESUME_MAX_TOKENS` (default 80k);
- otherwise picks `fresh`.

Session state lives in `meta.json`:
`sessions.<role> = {backend, id, last_used, history_tokens}`. Every launch
records `{reuse, reason}`, where `reason` is one of `warm_cache`,
`small_history`, `stale_cache`, `forced_independent`, `backend_changed` or
`no_prior`. That makes the threshold tunable from data.

## 6. Scheduler (`lib/collab.py`)

- **Entry point.** `delegate collab run --parent <id> [--detach]`. It holds
  `.locks/scheduler.<parent>.lock` (one scheduler per parent) and writes
  `_data/<parent>/scheduler.pid`; `--detach` re-execs in a new session with
  its log at `_data/<parent>/scheduler.log`. Rerunning is safe: it picks up
  from the store (after a human `reply`, or after fixing a conflict).
- **Children** run as `run.sh run --id <child> --phase auto` subprocesses with
  `DELEGATE_TRIGGER_SOURCE=parent`, so each child keeps its own worktree,
  lease, session reuse and run records.
- **Gates**, in order; the first failing one emits a `queued` event on the
  parent (only when the reason changes):
  1. `deps` — every `depends_on` child is `shipped`/`closed` (`blocked` when a
     dependency failed or waits on a human).
  2. `slot` — this scheduler's `--max-parallel` and a free lock in the global
     pool `.locks/slots/` (`DELEGATE_MAX_PARALLEL`, default 3) shared by all
     parents.
  3. `repo_cap` — running children in the same repo < `DELEGATE_MAX_PER_REPO` (2).
  4. `path_overlap` — scope prefixes (glob text before the first wildcard) do
     not overlap a running sibling in the same repo; no scope = whole repo.
  5. `mem` — `MemAvailable − DELEGATE_RUN_MEM_MB (1500) ≥ DELEGATE_MEM_FLOOR_MB
     (2048)`. MemAvailable already reflects running children, so they are not
     subtracted twice. Tests point `DELEGATE_MEMINFO_PATH` at a fake file.
- **Events on the parent:** `scheduler_start`, `queued`, `dispatched` (slot,
  queue wait, attempt, pid, MemAvailable), `child_exit`, `retry`, `merge`,
  `verify`, `scheduler_end` (done / waiting / failed / blocked, peak
  parallelism, wall time). `api metrics --parent` adds `realized_parallelism`
  = Σ run wall ÷ (last end − first start).
- **Failure handling.** A child that exits without a terminal status is
  dispatched once more (its session resumes when warm); a second miss marks it
  `failed`. A child in `waiting_initiator` blocks its dependents; when nothing
  else can start the parent goes to `waiting_initiator` and the scheduler exits.
- **Integration step** (after every child shipped; `--no-integrate` skips):
  1. Per repo, a worktree `.worktrees/<repo>/delegate-<parent>-integration` on
     branch `delegate/<parent>-integration` from `origin/HEAD`.
  2. Implement workers edit without committing, so each child's worktree
     changes are first committed onto its own `delegate/<id>` branch
     (`snapshot` event; `.delegate/` excluded; the repo's `.gitignore`
     applies). Branches then merge `--no-ff` in dependency order; merged ones
     are skipped, so reruns are idempotent.
  3. Conflict → `merge --abort`, a `merge` event with the conflicted files,
     parent `waiting_initiator` / `integration_conflict`.
  4. Otherwise a **fresh** read-only verify run per repo
     (`prompts/integrate.md`: contract + merged diffstat; reuse reason
     `forced_independent`) prints a `{"verdict","findings"}` JSON, read from
     `runs/<run>.final.txt`. Pass → parent `shipped` / `done`.
- **Deferred:** a plan agent that drafts `contract.md` (and fork from its
  session into children); today the initiating TUI agent writes the contract.

## 7. Data layout

```
~/.agent/tickets/
  events.jsonl                 # global stream, seq-numbered (cursor)
  events.head                  # last seq + byte offset (fast tail)
  prompts/<sha256>.md          # content-addressed initial / continuation messages
  _data/<id>/
    ticket.md meta.json progress.json events.jsonl   # existing (events gain the envelope)
    contract.md                # parent only, versioned in events by sha
    runs/<run>.launch.json     # §4
    runs/<run>.json            # run record (§8)
    runs/<run>.stream.jsonl    # raw CLI stream (replaces worker.log / implement.log)
  .locks/{tickets.lock, scheduler.<id>.lock, slots/N.lock}
```

- **Retention.** `delegate gc` removes the stream, launch and events files
  after 30 days (`DELEGATE_KEEP_DAYS`). Prompts that no remaining launch
  references are removed with them. Ticket `meta` and run records are kept
  until the ticket is archived.
- **Old tickets.** The existing 83 tickets keep working without migration.
  Their old `type` events are read as envelope `kind`.

## 8. Event envelope, run record, metrics

Every event uses this envelope. The payload stays **flat** next to it (and
`type` mirrors `kind`) so pre-v1 readers such as `delegate watch` keep working:

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
| `created` `claimed` `released` `challenge` `reply` `status` `closed` `progress` | existing fields | lifecycle |
| `queued` / `dispatched` | `gate, detail, slot, queue_wait_ms, mem_available_mb` | scheduler |
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

## 9. Read contract: `delegate api`

- Read-only and JSON-only. Typical latency is under 300 ms.
- Errors come back as `{"ok":false,"error":{code,message}}` with exit code 0.
- Each response has a JSON Schema in `skills/cross-repo-delegate/schema/` and
  carries `"v":1`.

| Command | Returns |
| --- | --- |
| `api health` | `{v, store, tickets, running, queued, waiting_human, seq_head, capabilities[]}` |
| `api list [--status] [--repo] [--parent] [--since] [--limit]` | ticket summaries + last progress + child counts |
| `api show --id` | meta, sections (sans prompts), children, `contract.md` sha, runs (summaries) |
| `api events --after <seq> [--ticket] [--limit 500]` | `{events[], next}`. This is the poll cursor |
| `api run --run <run>` | launch record + run record |
| `api prompt --sha <sha256>` | redacted prompt / continuation body |
| `api transcript --run <run> [--tail n]` | compressed stream: tool lines, milestones, final text |
| `api metrics [--window] [--parent]` | §8 metrics |

## 10. Observation surfaces

**wezdeck web.** Requires a Windows runtime release
([`wezdeck-runtime-release.md`](wezdeck-runtime-release.md)).

1. `native/wezdeck-wsl/serve.go`: `case "collab.<action>"` for an allowlist of
   `health, list, show, events, run, prompt, transcript, metrics`. Each runs
   `$WEZDECK_REPO/skills/cross-repo-delegate/delegate api <action> …` with a
   5 s timeout.
2. `RuntimeWebServer.cs`:
   - Add `GET /api/v1/collab/{action}` → `ReadBridge("collab", action, query)`.
   - Allowlist the same actions in C#. Do not add a generic bridge passthrough.
   - Add the capability `collab.read`.
3. `web/src/lib/runtime-contract.ts`: zod schemas mirroring `schema/*.json`.
   `runtime-client.ts`: `getCollab*()`, gated on capability.
4. A new `web/src/features/console-collab.tsx` plus a nav entry:
   - **Board:** columns by status; parents show child progress.
   - **Parent swimlanes:** one lane per repo / worktree; run bars on a time
     axis; queued segments coloured by gate.
   - **Run inspector:** launch record (trigger chain, composition table,
     prompt viewer), live tool and milestone stream, run record.
   - **Metrics:** reuse mix, cache hit by backend, gate denials, cost.
5. Refresh. `console-data.tsx` polls `events --after` every 2 s while
   `running > 0`, otherwise every 30 s. A typed `collab.changed` on `/events`
   is a later optimisation.

**fe1 web:**

1. `cloud/packages/local/src/contract.ts`:
   - `collab.*` routes mirroring §9 (`GET /collab/health|tickets|tickets/{id}|events|runs/{run}|prompts/{sha}|metrics`), with zod generated from the same JSON Schemas.
   - The capability `collab.read` appears only when `delegate` resolves.
   - Bump `LOCAL_VERSION`.
2. `server.ts`: run `execFile` against `delegate api` with a 5 s timeout,
   behind the existing origin allowlist.
3. Team app pages `routes/collab.index.tsx` and `collab.$id.tsx`. These reuse
   the `flow-progress` timeline, since the event kinds are a superset of
   fe1's.

**Terminal and logs:**

- A `collab` plugin under `wezterm-x/plugins/` renders the right-status badge
  `Collab·2▶ 1⏳` (running / waiting on a human) from `api health`. Its
  sampler runs every 10 s.
- `waiting_human` parents write an attention entry. The keyboard path is the
  existing `Alt+/` jump, plus `delegate board` / `delegate watch`. v1 adds no
  new hotkey.
- A `collab` log category: one `runtime.log` row per status transition, per
  `run_end` (with tokens, cache and cost) and per gate denial. This feeds
  `/api/v1/diagnostics`, `workflow-timeline` and habit-report.

## 11. Implementation plan

**P0 (landed 2026-11-21): contract + launch/run observability.** Code:
`scripts/dev/host-agent-invoke/lib/run_observe.py` (launch record, stream
parser, RSS sampler, run record; `--run-dir/--resume/--fork` flags),
`skills/cross-repo-delegate/lib/observe.py` (envelope + global seq, sink,
prompt store + redaction, reuse decision, `collab` rows in `runtime.log`),
`lib/api.py` + `schema/*.json`, worker wiring (resume → one fresh retry on
failure), `进展：` lines requested by both prompt templates. Tests: recorded
streams in `scripts/dev/host-agent-invoke/tests/fixtures/` drive
`host-agent-invoke/test.sh` and the observability block of
`cross-repo-delegate/test.sh` (schema validation of every `api` command,
reuse reasons, redaction, cursor paging, resume fallback).

**P1 (code landed 2026-11-21): wezdeck web, read-only.** `native/wezdeck-wsl/collab.go`
(allowlisted `delegate api` exec, 5 s timeout, Go tests), `RuntimeWebServer`
`/api/v1/collab/<command>` + `collab.read`, `web/src/features/console-collab.tsx`
(metrics band, keyboard listbox of tickets, run table, launch record with
trigger chain / composition / initial prompt, live transcript; 2 s poll while
anything runs, 30 s idle). Verified with the mock runtime proxying the real
`delegate api` over the e2e store and `web/tests/collab.cdp.test.ts` (headless
CDP). Parent swimlanes wait for P2's parent/child model.

**P2 (landed 2026-11-21): parent/child + scheduler.** `lib/collab.py`,
`prompts/integrate.md`, contract embedding in child phase views, `api show`
children/integration, `api metrics --parent` parallelism, Collab page children
table. Offline: `test-collab.sh` (caps, overlap serialization, deps order, mem
gate hold/resume, human gate blocking, retry, merge ok/conflict, verdict
parser). Live e2e result is in §13.

**P3 (live 2026-11-21): fe1 web.** fe1 `5eb846b`: contract `GET /collab/{command}`
(capability `collab.read`, allowlisted params, fe1 origin only), `collab-route.ts`
running `delegate api`, ⚙ › 跨仓协作 page. Original plan: the local-service routes and the pages. Verify with fe1's
oRPC contract tests against recorded `delegate api` fixtures, plus a page CDP
smoke.

**P4: fe1 flows on the core.**

- Flows call `delegate create --mode research --repos …` for checks.
- `act` with code changes creates a parent ticket.
- fe1's `withCheckouts`, `stream.ts` and event writer are retired.

Verify parity: the same flag through the old and the new path gives the same
verdict and the same verified refs.

Each phase lands on its own: commit, push, `sync-runtime`, and docs updated in
the same change, following the standing policy.

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| Parallel agents trigger guest OOM | Memory gate plus `rss_peak_mb` data to tune `DELEGATE_RUN_MEM_MB`. Default cap 3 |
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

Still open: a live codex run once its gateway is back (`delegate create … --run
--backend codex` against a scratch target), then replace the synthetic fixture.
