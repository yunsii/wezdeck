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

## Checks

```bash
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run build
```

The production deployment is configured for Vercel through Nitro. The browser
connects directly to the user's loopback Runtime; Vercel server code never
tries to reach the user's local machine.

## Console preview captures

With the local dev server and Chrome CDP session running, refresh both static
theme previews with:

```sh
pnpm capture:console-preview
```

The script removes development overlays before writing
`public/console-preview-light.png` and `public/console-preview-dark.png`.
