import { describe, expect, it } from 'vitest';
import { checkCursorFallbackHealth } from '../../src/harness/cursor-fallback-health.js';

describe('checkCursorFallbackHealth', () => {
  it('reports degraded when the binary exists but no live smoke is requested', async () => {
    const result = await checkCursorFallbackHealth({
      binary: '/tmp/cursor-agent',
      execFile: async (_file, args) => {
        expect(args).toEqual(['--version']);
        return { stdout: '2025.10.01-f05f473\n', stderr: '' };
      },
    });

    expect(result.status).toBe('degraded');
    expect(result.version).toBe('2025.10.01-f05f473');
    expect(result.live_checked).toBe(false);
  });

  it('reports live when the host-context smoke returns the expected phrase', async () => {
    const calls: string[][] = [];
    const result = await checkCursorFallbackHealth({
      live: true,
      binary: '/tmp/cursor-agent',
      execFile: async (_file, args) => {
        calls.push(args);
        if (args[0] === '--version') return { stdout: '2025.10.01-f05f473\n', stderr: '' };
        return { stdout: 'cursor-agent smoke test ok\n', stderr: '' };
      },
    });

    expect(result.status).toBe('live');
    expect(result.live_checked).toBe(true);
    expect(calls[1]).toEqual([
      '--print',
      '--output-format',
      'text',
      '-f',
      'Say exactly: cursor-agent smoke test ok',
    ]);
  });

  it('reports unavailable when cursor-agent cannot be executed', async () => {
    const result = await checkCursorFallbackHealth({
      binary: '/missing/cursor-agent',
      execFile: async () => {
        throw new Error('ENOENT');
      },
    });

    expect(result.status).toBe('unavailable');
    expect(result.live_checked).toBe(false);
    expect(result.detail).toContain('version check failed');
  });
});
