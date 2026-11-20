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
| codex | `exec --sandbox read-only` (OS sandbox) | `exec --full-auto` |
| grok | `--permission-mode plan --disable-web-search` + `--allow` per read-only command (`HOST_AGENT_GROK_READ_ALLOW`: `git log/show/diff/status/blame/ls-files/grep/rev-parse`, `ls/cat/head/tail/wc/rg/grep`) | `--always-approve` |

Grok: dropping `--always-approve` alone is **not** read-only headless (it still
writes files). Its read mode is a permission allowlist, not an OS sandbox like
codex; `git diff/log --output=<file>` can still write through an allowed prefix.
Keep the allowlist side-effect free (`test.sh` checks it).

Offline: `HOST_AGENT_INVOKE_MOCK=1` + optional `HOST_AGENT_INVOKE_TRACE=…` (JSONL;
grok rows carry the full `argv`).
