import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

interface QuarantineEntry {
  file: string;
  failed_tests: number;
  owner: string;
  reason: string;
}

const wave145Quarantine = JSON.parse(
  readFileSync(new URL('./tests/quarantine/wave145-full-suite.json', import.meta.url), 'utf8'),
) as { entries: QuarantineEntry[] };

for (const entry of wave145Quarantine.entries) {
  if (!entry.owner.trim() || entry.failed_tests < 1 || !entry.reason.trim()) {
    throw new Error(`Invalid Wave145 quarantine entry: ${entry.file}`);
  }
}

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
      // Wave145: exact baseline-failing files are temporarily quarantined with
      // an owner, failing-test count, and reason in the adjacent manifest.
      ...wave145Quarantine.entries.map((entry) => entry.file),
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
