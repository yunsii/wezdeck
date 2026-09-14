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

Offline: `HOST_AGENT_INVOKE_MOCK=1` + optional `HOST_AGENT_INVOKE_TRACE=…` (JSONL).
