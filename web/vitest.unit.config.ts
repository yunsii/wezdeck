import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Pure-logic tests (no browser, no relay): tests/**/*.unit.test.ts
export default defineConfig({
  // vite.config.ts defines it at build time; modules that import
  // client-trace (→ pwa.ts) read it at load
  define: { __BUILD_ID__: JSON.stringify('unit-test') },
  resolve: {
    alias: { '#': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: { include: ['tests/**/*.unit.test.ts'] },
})
