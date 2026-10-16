import { defineConfig } from 'vitest/config'

// Opt-in live checks against real external services (`make smoke-live`).
// Never part of `make check` / CI: they need a real key and spend quota.
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.test.ts'],
    globals: false,
    testTimeout: 120_000,
  },
})
