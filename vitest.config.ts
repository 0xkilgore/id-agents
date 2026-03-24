import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 300000, // 5 min timeout for integration tests (Claude API can be slow)
    hookTimeout: 120000, // 2 min for setup/teardown
    // Run tests sequentially since they share cluster state
    sequence: {
      concurrent: false,
    },
    // Use single thread for integration tests
    fileParallelism: false,
  },
});
