# OpenClaw docs map (wezdeck)

Read order for humans and agents. These files are **knowledge base** (not full always-on prompts).

## 5-minute path

| Order | Doc | Why |
| --- | --- | --- |
| 1 | [`terminology.md`](./terminology.md) | Words + **L0 core vs L1 scenario vs skill vs knowledge** |
| 2 | [`agent-architecture.md`](./agent-architecture.md) | Dual rails, ACP, Grok split, VCS mainline |
| 3 | [`agent-interaction.md`](./agent-interaction.md) | TUI / headless / Feishu / ACP how-to |
| 4 | [`../workspace/AGENTS.md`](../workspace/AGENTS.md) **L0 only** | Always-on constitution for Main |
| 5 | Skills on demand | `workspace/skills/*`, repo `skills/*` |
| 6 | Digital employees | [`digital-employees.md`](./digital-employees.md) — Dex / Bob / Scout |

## By topic

| Topic | Authority |
| --- | --- |
| Terms / doc layering | `terminology.md` |
| **Digital employees (Dex/Bob/Scout)** | `digital-employees.md` |
| **Digital employee memory (public vs private)** | `digital-employee-memory.md` |
| **Feishu multi-bot wiring** | `feishu-digital-employees.md`（含 lark-cli 双配置 / cron profile 坑） |
| Architecture / rails | `agent-architecture.md` |
| Interaction modes | `agent-interaction.md` |
| **Session Adapter Kit** (host↔claw) | `session-bridge.md` + `scripts/session-bridge.sh` + skill `session-bridge` |
| Error closed-loop **scope** | `error-closed-loop-scope.md` + skill `error-closed-loop` |
| Adversarial review | **Single source** `scripts/dev/adversarial-review/` (SKILL+runner) · **links** `~/.agents/skills/…`, `workspace/skills/…`, `skills/…` via `scripts/dev/link-platform-skills.sh` · **KB** `docs/adversarial-review.md` |
| Host TUI constitution | `agent-profiles/v1/en/*` |
| Ops / matrix / Feishu control plane | `../README.md` (entry; prefer docs above for policy) |

## L0 number cheat-sheet (AGENTS.md)

| Id | Theme |
| --- | --- |
| L0-12 | Single writer; tree on demand |
| L0-13 | **Personal projects prefer mainline** |
| L0-14 | Strategy in entry; L0/L1 layering note |
| L0-17 | Sync L0 core across claw ↔ profiles |
| L0-19 | Safety + personal push master |
| L0-20 | 落实 + git Author/trailer |
| L0-21 | Adversarial = multi-role + disclosure |

Do not invent new bare numbers in other files without updating this table and AGENTS.

## Constitution vs knowledge

| Write to | When |
| --- | --- |
| **L0 (AGENTS + profiles spirit)** | Cross-surface must-hold |
| **L1 Claw** | Feishu-only (brevity, ledger UX) |
| **L1 Host** | TUI-only (permissions detail) |
| **Skill** | Executable procedure |
| **This docs/ tree** | Explanation, maps, boundaries |
