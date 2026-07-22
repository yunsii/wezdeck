# Memory search（本机运维）

How Dex / Bob / Scout **semantic memory search** works on this host, and how
to repair it when vector search is paused.

**Related:** content policy (what to write where) →
[`digital-employee-memory.md`](./digital-employee-memory.md).  
Upstream knobs → OpenClaw docs `reference/memory-config.md` /
`concepts/memory-search.md` (installed package).

## Mental model

| Layer | What | This host |
| --- | --- | --- |
| **Notes** | `MEMORY.md` + `memory/*.md` under each agent workspace | tracked only as empty/runtime dirs; content is owner-local |
| **FTS** | SQLite full-text (keyword) | always available when index is built |
| **Vector** | embeddings + similarity | needs a **working embedding provider** |
| **Chat models** | Grok / Claude / Codex | **not** embeddings |

**Chat models ≠ memory embeddings.**  
Host “three models available” (Claude-TUI / Codex-TUI / Grok-native or Main-Grok)
does **not** satisfy `memory_search`. The default OpenClaw path uses **OpenAI
embeddings** (`provider: openai`). Without `OPENAI_API_KEY`, vector search fails
closed with:

```text
index metadata is missing
Vector search: paused until memory is rebuilt
No API key found for provider "openai"
```

Many OpenAI-compatible **chat** proxies also reject `/v1/embeddings`
(`Embeddings API is not supported for this platform`). Do not point
`memorySearch` at a chat-only proxy and expect it to work.

## Intended baseline (this machine)

Live config lives in **`~/.openclaw/openclaw.json`** (never git).

| Item | Baseline |
| --- | --- |
| Plugin | `@openclaw/llama-cpp-provider` (id `llama-cpp`) **enabled** |
| `plugins.allow` | includes `llama-cpp` (with `feishu`, `memory-core`, `acpx`, …) |
| `agents.defaults.memorySearch.provider` | `"local"` |
| `agents.defaults.memorySearch.fallback` | `"none"` (or omit) |
| Model | default GGUF: `embeddinggemma-300m-qat-Q8_0` via `hf:` URI |
| Model cache | `~/.node-llama-cpp/models/` (~0.3 GB) |
| Index store | `~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite` |

Example shape (desensitized; also sketched in
`config/openclaw.json5.example`):

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "local",
        fallback: "none",
      },
    },
  },
  plugins: {
    allow: ["feishu", "memory-core", "acpx", "llama-cpp"],
    entries: {
      "llama-cpp": { enabled: true },
      "memory-core": { config: {} },
    },
  },
}
```

### Why local here

| Option | Why not / why |
| --- | --- |
| Default `openai` | No OpenAI key on this host; fails closed |
| Chat proxy as embeddings | Proxy has no embeddings API |
| Ollama / LM Studio | Not installed as a standing service on this host |
| **`local` + llama-cpp** | Offline, no extra API key, fits personal control plane |

## Install / enable (once)

```bash
# 1) Install provider plugin (pulls node-llama-cpp; may take minutes + ~1GB npm tree)
openclaw plugins install @openclaw/llama-cpp-provider

# 2) Allowlist + enable (plugins.allow is a hard gate on this host)
openclaw config set plugins.allow --strict-json \
  '["feishu","memory-core","acpx","llama-cpp"]'
openclaw plugins enable llama-cpp

# 3) Point memory search at local embeddings
openclaw config set agents.defaults.memorySearch.provider local

# 4) Gateway must reload plugins
openclaw gateway restart

# 5) First index downloads the GGUF then embeds all memory files
openclaw memory index --force --agent main --verbose
```

Repeat `--agent pm` / `--agent radar` if those workspaces have memory files.

## Ops cheatsheet

```bash
# Fast status (all agents if no --agent)
openclaw memory status

# One agent + deep probe
openclaw memory status --deep --agent main

# Rebuild when dirty / after provider change / "index metadata is missing"
openclaw memory index --force --agent main

# Smoke search
openclaw memory search --agent main --query "session-bridge" --max-results 5
```

Healthy `main` looks like:

```text
Provider: local (requested: local)
Indexed: N/N files · M chunks
Dirty: no
Vector dims: 768   # embeddinggemma
FTS: ready
```

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No API key found for provider "openai"` | Default / explicit openai, no key | Switch to `local` (or set a real embedding key) |
| `index metadata is missing` + vector paused | Never indexed, or provider identity changed | `openclaw memory index --force --agent <id>` |
| `memory_search` unavailable in agent | Explicit remote provider broken (fail-closed) | Fix provider **or** set `provider: "none"` for intentional FTS-only |
| Plugin “blocked by allowlist” | `llama-cpp` not in `plugins.allow` | Add id to allowlist, enable, restart gateway |
| Index hangs first run | Downloading GGUF to `~/.node-llama-cpp/models/` | Wait; check `*.ipull` → final `.gguf` |
| `llama-cpp` enabled but search still openai | Config not applied / gateway not restarted | `config get agents.defaults.memorySearch` + restart |
| Chat proxy works, memory still dead | Expected: chat ≠ embeddings | Keep `local` or a real embedding endpoint |

### Intentional FTS-only (no vectors)

If you deliberately do not want embeddings:

```bash
openclaw config set agents.defaults.memorySearch.provider none
openclaw memory index --force --agent main
```

Do **not** leave an explicit broken remote provider; that disables search instead of
silently falling back.

## Multi-agent notes

| Agent | Workspace | Index store |
| --- | --- | --- |
| `main` (Dex) | `~/.openclaw/workspace` | `~/.openclaw/agents/main/agent/…` |
| `pm` (Bob) | `~/.openclaw/workspace-pm` | `~/.openclaw/agents/pm/agent/…` |
| `radar` (Scout) | `~/.openclaw/workspace-radar` | `~/.openclaw/agents/radar/agent/…` |

Each agent has its **own** SQLite memory index. Fixing `main` does not rebuild
`pm` / `radar`. Reindex each agent that has memory files.

## What not to put in git

- Live `~/.openclaw/openclaw.json`
- `openclaw-agent.sqlite` / embedding caches
- Downloaded GGUF under `~/.node-llama-cpp/`
- Private `memory/*.md` content (see digital-employee-memory policy)

Track only: this doc, example config sketches, and public templates.

## Incident (2026-07-22)

1. `memory_search` reported unavailable: openai default, no key, empty index.
2. Chat proxy listed many Grok models but **no** embeddings API.
3. Installed `llama-cpp`, allowlisted + enabled, set `memorySearch.provider=local`.
4. Gateway restart + `memory index --force --agent main` → **15/15 files, 102 chunks**.

## See also

- Content policy: [`digital-employee-memory.md`](./digital-employee-memory.md)
- Docs map: [`README.md`](./README.md)
- Config sketch: [`../config/openclaw.json5.example`](../config/openclaw.json5.example)
- Upstream: `openclaw memory --help`, package docs `cli/memory.md`
