import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.cdp.test.ts'],
    // refuse a stack built from other sources than the ones under test
    globalSetup: ['tests/version.setup.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
