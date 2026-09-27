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
- `POST /api/v1/actions/vscode/focus_or_open` — open or reuse a WSL folder (`requested_dir`, `distro`, `code_command`).
- `POST /api/v1/actions/vscode/focus` — focus a listed window by `hwnd`.
- `POST /api/v1/actions/vscode/close` — request a graceful window close by `hwnd`; requires `confirm: true`.

The close action posts `WM_CLOSE` to the selected VS Code window. It does not
terminate the VS Code process, and the browser asks for confirmation first.

## Checks

```bash
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run build
```

The production deployment is configured for Vercel through Nitro. The browser
connects directly to the user's loopback Runtime; Vercel server code never
tries to reach the user's local machine.
