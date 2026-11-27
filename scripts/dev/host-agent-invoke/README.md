# host-agent-invoke

Thin shared **host headless** CLI invoke for `claude` / `codex` / `grok`.

| Owns | Does not own |
| --- | --- |
| PATH hints, attention-skip, pane-env strip, `env -u CODEX_HOME` | Ticket state / phase views / result apply |
| Prompt via file/stdin (ARG_MAX-safe) | ACP / `sessions_spawn` / acpx |
| `--mode read` vs `--mode write` flag profiles | Interactive `agent-launcher` |

**Consumers:** ticket workers (`write`); adversarial-review / fanout providers (`read` + `--capture`).  
**Scheduling map (platform):** `docs/agent-scheduling.md` — not under `openclaw/docs/`.

```bash
. scripts/dev/host-agent-invoke/lib/host-agent-invoke.sh
host_agent_invoke_run \
  --backend claude --mode write \
  --cwd "$PWD" --prompt-file /path/to/prompt.md --log /tmp/out.log
```

### How each backend enforces `--mode read`

| Backend | `--mode read` (no writes, no side-effect commands) | `--mode write` |
| --- | --- | --- |
| claude | `--permission-mode plan --allowed-tools Read Grep Glob` | `--permission-mode bypassPermissions` |
| codex | `exec --sandbox read-only` (OS sandbox) | `exec --sandbox workspace-write -c approval_policy="never"` |
| grok | `--permission-mode plan --disable-web-search` + `--allow` per read-only command (`HOST_AGENT_GROK_READ_ALLOW`: `git log/show/diff/status/blame/ls-files/grep/rev-parse`, `ls/cat/head/tail/wc/rg/grep`) | `--always-approve` |

Grok: dropping `--always-approve` alone is **not** read-only headless (it still
writes files). Its read mode is a permission allowlist, not an OS sandbox like
codex; `git diff/log --output=<file>` can still write through an allowed prefix.
Keep the allowlist side-effect free (`test.sh` checks it).

### Observable runs (`--run-dir`)

`--run-dir DIR [--run-id ID] [--launch-extra JSON] [--sink-py FILE --sink-arg ARG]`
switches the CLI to its event stream (claude `stream-json`, codex `--json`,
grok `streaming-json`) and, via `lib/run_observe.py`, writes:

| File | Content |
| --- | --- |
| `<run>.launch.json` | before start: argv (no prompt body), env key names, base sha, prompt sha/bytes/est tokens, origin session, caller extras |
| `<run>.stream.jsonl` | raw CLI stream |
| `<run>.json` | run record: session id + reuse, turns, tokens (input / cache_read / cache_write / output; unknown = `null`), cache hit rate + TTL, cost, wall ms, peak RSS of the CLI tree, tool calls, denials, exit |

Events (`run_start`, `session_init`, `tool`, `milestone` = agent lines starting
`进展：`, `error`, `run_end`) go to `--sink-py` (`sink_events(arg, run, batch)`)
or `<run>.events.jsonl`. `--resume ID [--fork]` continues / branches a backend
session (codex resume uses `-c sandbox_mode=…` because `exec resume` has no
`--full-auto`). Exclusive with `--capture`. Consumer: `agent-collab`
([`docs/collab.md`](../../../docs/collab.md)).

Offline: `HOST_AGENT_INVOKE_MOCK=1` + optional `HOST_AGENT_INVOKE_TRACE=…` (JSONL;
grok rows carry the full `argv`). With `--run-dir`,
`HOST_AGENT_INVOKE_MOCK_STREAM=<recorded stream>` (fixtures in
`tests/fixtures/`) and `HOST_AGENT_INVOKE_MOCK_RC` drive the parser offline.
