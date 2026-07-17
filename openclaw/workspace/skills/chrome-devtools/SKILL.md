---
name: chrome-devtools
description: >
  Drive the machine Chrome debug browser via OpenClaw-managed MCP
  (chrome-devtools). Use for page navigation, snapshots, screenshots,
  clicks, forms, console/network inspection — not for host shell risk.
---

# Chrome DevTools (YunsClaw core)

## What this is

YunsClaw can control the **Windows host debug Chrome** through OpenClaw MCP:

| Piece | Where |
| --- | --- |
| CDP endpoint | `http://127.0.0.1:9222` (WezDeck helper auto-start) |
| MCP server name | `chrome-devtools` in local `~/.openclaw/openclaw.json` → `mcp.servers` |
| Package | `npx -y chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:9222` |

This is **not** the same MCP session as Grok/Claude CLI; all clients share the
**same Chrome process** on port 9222. Avoid concurrent multi-agent browser wars.

Workflow detail for launch / badge / inspect:
repo root [`docs/browser-debug.md`](../../../../docs/browser-debug.md).

## When to use (main YunsClaw)

| Trigger | Action |
| --- | --- |
| User: open/check URL, click, form, screenshot | MCP navigate + snapshot (not curl HTML) |
| **You** just changed UI in coco-forge | Before 验收通过: open relevant URL/path, snapshot |
| “页面坏了 / 控制台报错 / 按钮点不了” | list pages / console / network as needed |

Coding agents on the host have their **own** browser/MCP/profile — this skill is
for **main** when main is looking at the page. No bridge required.

## When not to use

- Pure git / shell / ledger / worktree assess — do not open Chrome “just in case”.
- Destructive browser actions outside what the user asked (clear profile, mass
  delete, payment submit) without explicit confirmation.
- Host shell risk still goes through `claw-run` / `exec-risk` — browser MCP is
  separate.

## Operator setup (once per machine)

```bash
# CDP must answer first
curl -sS -m 3 http://127.0.0.1:9222/json/version

openclaw mcp add chrome-devtools \
  --command npx \
  --arg -y \
  --arg chrome-devtools-mcp@latest \
  --arg --browser-url=http://127.0.0.1:9222 \
  --timeout 90 \
  --connect-timeout 60

openclaw mcp probe chrome-devtools   # expect ~29 tools
openclaw mcp reload
# or: systemctl --user restart openclaw-gateway.service
```

Health:

```bash
openclaw mcp list
openclaw mcp status
```

If probe fails: start debug Chrome (helper auto-start / `Alt+b`), confirm
port, then `openclaw mcp reload`.

## Agent habits

1. Prefer MCP browser tools over `curl` HTML scraping when interaction matters.
2. Prefer **snapshot** before click/type so selectors stay grounded.
3. Report back in 简体中文: URL, what you saw, what you did, blockers.
4. If CDP is down, say so and how to fix (`docs/browser-debug.md`); do not invent success.
5. Do not put CDP secrets in git (loopback URL is fine in local config only).

## Tool names

Exact projected names depend on OpenClaw (often `chrome-devtools__…` or code-mode
`MCP.chromeDevtools.*`). Discover via the tool list for this session; common
capabilities include: list/navigate pages, snapshot, screenshot, click, fill,
console, network, performance.
