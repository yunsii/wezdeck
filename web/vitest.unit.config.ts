import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Pure-logic tests (no browser, no relay): tests/**/*.unit.test.ts
export default defineConfig({
  resolve: {
    alias: { '#': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: { include: ['tests/**/*.unit.test.ts'] },
})
