import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.cdp.test.ts'],
    // refuse a stack built from other sources than the ones under test
    globalSetup: ['tests/version.setup.ts'],
    // the files share one test stack (attention file, device approvals):
    // run them one after another so none rewrites another's fixtures
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
