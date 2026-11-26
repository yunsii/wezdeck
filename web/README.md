# WezDeck Runtime Console

TanStack Start dashboard for the local WezDeck Runtime.

## Development

```bash
corepack pnpm install
corepack pnpm run dev
```

The dashboard probes `http://127.0.0.1:35791` by default. Run the local
contract mock in a second terminal while the Windows Runtime API is not
available:

```bash
corepack pnpm run mock-runtime
```

Override the endpoint with `VITE_WEZDECK_RUNTIME_URL`.

A snapshot the running Runtime does not implement (missing capability, HTTP
error, or a body the page schema rejects) renders as unavailable data. It does
not replace the console page with an error screen.

The Runtime Console reads these loopback endpoints:

- `GET /api/v1/workspaces` — merged workspace catalog. The Runtime evaluates the synced `workspaces.lua` with `lua5.4` in WSL (`scripts/runtime/dump-workspace-catalog.lua`) and returns every defined workspace, including ones whose `items` list is empty.
- `GET /api/v1/sessions` — live Agent attention entries and recent session records.
- `POST /api/v1/actions/sessions/focus` — focus an active or recent Agent session in its WezTerm pane (`session_id`, optional `recent` and `archived_ts`).
- `GET /api/v1/diagnostics` — aggregate Windows Runtime, WezTerm, and WSL runtime logs. Supports `limit`, `source`, `category`, `level`, `trace`, and `q` filters.
- `GET /api/v1/vscode` — visible VS Code windows with process and window handles.
- `GET /api/v1/collab/{health,list,show,events,run,prompt,transcript,metrics}` — read-only cross-repo collab data (`ticket api`; tickets, runs with session reuse / tokens / cache hit, launch records with trigger chain and initial prompt, transcripts, metrics). Shown on **Console → Collab**. The mock runtime proxies these to the real `ticket api`; set `WEZDECK_MOCK_TICKETS_ROOT` to a fixture store.
- `POST /api/v1/actions/vscode/focus_or_open` — open or reuse a WSL folder (`requested_dir`, `distro`; `code_command` is rejected over HTTP).

HTTP `/api/v1/actions/*` only exposes `sessions/focus` and `vscode/focus_or_open`, requires an allowlisted non-loopback `Origin` and `Content-Type: application/json`, and caps request bodies at 64 KB. Clipboard, Chrome, and window-close actions are named-pipe-only for WezTerm.

## UI components

Controls come from `src/components/ui` (Base UI underneath), never a bare
native `<button>` / `<input>` / `<select>` / `<textarea>` / `<details>`:
`eslint.config.js` forbids them outside `src/components/`. The set and its
variants: [`docs/web-pwa.md` → Visual language](../docs/web-pwa.md#visual-language-2026-11-22-revised).

## Checks

```bash
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run build
# Collab page acceptance (headless CDP; mock runtime on another port):
#   WEZDECK_RUNTIME_PORT=35899 WEZDECK_MOCK_TICKETS_ROOT=<store> pnpm run mock-runtime
#   VITE_WEZDECK_RUNTIME_URL=http://127.0.0.1:35899 pnpm exec vite dev --port 3017
#   WEZDECK_WEB_URL=http://127.0.0.1:3017/console/collab pnpm exec vitest run --config vitest.cdp.config.ts tests/collab.cdp.test.ts
```

Production runs on Cloudflare Workers at `https://wezdeck.yuns.love`
(`wrangler.jsonc`, `src/server.ts`; deploy with `corepack pnpm run deploy`).
On the host the browser connects directly to the user's loopback Runtime; the
Worker never reaches the machine itself. Away from the host, the collab view
goes through the HostRelay Durable Object and a WebRTC DataChannel to
`wezdeck-wsl relay` — see [`docs/remote-access.md`](../docs/remote-access.md). Chrome Private Network Access requires
the Runtime to answer preflight with
`Access-Control-Allow-Private-Network: true` (see `RuntimeWebServer`); without
that grant the overview shows **Runtime API** as offline even when
`http://127.0.0.1:35791/api/v1/health` works from curl. The **WSL bridge**
status needs `native/wezdeck-wsl/bin/wezdeck-wsl` (built by sync via
`native/wezdeck-wsl/build.sh`).
