import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Legacy Node TAP tests under test/repos/** are kept for history but are not
    // picked up by Vitest — they use `node:test` + `node:assert` and should be
    // converted to Vitest or run separately via `node --test test/repos`.
    exclude: [
      '**/node_modules/**',
      // Legacy Node TAP tests under test/repos/** use `node:test` + `node:assert`
      // and should be either converted to Vitest or run via `node --test test/repos`.
      'test/repos/**',
      'public-agent/**',
    ],
    testTimeout: 300000, // 5 min timeout for integration tests (Claude API can be slow)
    hookTimeout: 120000, // 2 min for setup/teardown
    // Run tests sequentially since they share team state
    sequence: {
      concurrent: false,
    },
    // Use single thread for integration tests
    fileParallelism: false,
  },
});
