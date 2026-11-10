---
name: browser-agent
description: >
  Default browser skill for WezDeck. Use when the user asks to open a page,
  browse, click, fill forms, screenshot, UI verify / 验收页面 / 打开网页 /
  用浏览器看看, or says chrome / ego / CDP as a product hint. Read
  WEZDECK_BROWSER_BACKEND (ego|cdp), probe that backend, then drive
  ego-browser or chrome-devtools-mcp. Never guess the backend; never
  auto-switch mid-task; never scrape with curl when interaction matters.
---

# browser-agent

## Human wording (preferred)

Say the **capability**, not the product:

| 你说 | Agent 做 |
| --- | --- |
| 用浏览器打开 / 打开网页 / 看下这个 URL | 走当前 `WEZDECK_BROWSER_BACKEND` |
| 浏览器验收 / UI 验收 / 点一下确认 | 同上；验收完回报 URL + 所见 |
| 登录页帮我填到验证码停下 | 同上；需人接管时 handOff |

Product names are **optional overrides / triage only**:

| 你说 | 含义 |
| --- | --- |
| （默认不说） | 用配置里的 backend |
| `强制 CDP` / `走 chrome-devtools` | 仅当配置已是 `cdp`，或先 `apply-browser-backend --set cdp` |
| `强制 ego` / `ego-browser` | 仅当配置已是 `ego`，或先 `apply-browser-backend --set ego` |

Do **not** treat bare「chrome」as “must use CDP” anymore — map it to this
skill and the configured backend. Switching backends is an operator action
(`apply-browser-backend`), not a chat synonym.

## Config (explicit only)

| Source | Key |
| --- | --- |
| Session env (highest) | `WEZDECK_BROWSER_BACKEND=ego\|cdp` |
| `~/.config/shell-env.d/wezdeck-browser-agent.env` | same |
| Apply tool | `apply-browser-backend --set ego\|cdp` |

No `auto`. If unset, stop and ask the operator to run `apply-browser-backend --set …`.

Switching backends **must** go through `apply-browser-backend` so OpenClaw
`mcp.servers` and skill links stay aligned. Do not hand-edit
`~/.openclaw/openclaw.json` browser MCP entries.

## Backend map

| `backend` | Host path | OpenClaw capability (after apply) |
| --- | --- | --- |
| `ego` | `ego-browser` CLI (WSL wrapper → Windows exe) + vendor `ego-browser` skill | `ego-browser` skill; **no** resident `chrome-devtools` MCP |
| `cdp` | `chrome-devtools-mcp-cli` / uxc → `http://127.0.0.1:9222` | resident `mcp.servers.chrome-devtools` |

Detail: repo [`docs/browser-debug.md`](../../docs/browser-debug.md).

## Workflow

1. Resolve backend from env (after managed env load if available).
2. Probe:
   - `ego`: `ego-browser nodejs -e "console.log('ego-browser ready')"`
   - `cdp`: `curl -sS -m 3 http://127.0.0.1:9222/json/version`
3. If probe fails, report the fix (open Ego / Alt+b) — do not invent success.
4. Run the task **only** on that backend.
5. Finish: report backend used, URL/result, blockers (简体中文).

### When backend is `ego`

1. Read vendor skill: run `ego-browser skill` (or read linked
   `~/.agents/skills/ego-browser/SKILL.md`) and follow the printed guide for
   this install.
2. One TaskSpace per user goal; print `spaceId`; resume it later.
3. Prefer snapshot refs; use `page.cdp()` only as escape hatch.
4. Hand off for login / captcha / payment via Space UI.

### When backend is `cdp`

1. Use existing `chrome-devtools-mcp-skill` / OpenClaw `chrome-devtools`
   habits (snapshot before click, etc.).
2. Prefer live debug Chrome on `:9222` (WezDeck auto-start).

## Guardrails

- Prefer this skill over raw `curl` HTML when the user wants to see or operate a page.
- Do not point `chrome-devtools-mcp --browserUrl` at Ego (no public CDP).
- Do not drive both backends against the same user goal in one turn.
- Do not fork the vendor `ego-browser` SKILL.md body.
- Destructive browser actions still need explicit user confirmation.
