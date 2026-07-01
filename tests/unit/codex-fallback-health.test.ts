import { describe, expect, it } from 'vitest';
import { checkCodexFallbackHealth } from '../../src/harness/codex-fallback-health.js';

describe('checkCodexFallbackHealth', () => {
  it('reports live when codex --version prints a semver-shaped version', async () => {
    const result = await checkCodexFallbackHealth({
      binary: '/tmp/codex',
      execFile: async (_file, args) => {
        expect(args).toEqual(['--version']);
        return { stdout: 'codex-cli 0.142.2\n', stderr: '' };
      },
    });
    expect(result.status).toBe('live');
    expect(result.version).toBe('codex-cli 0.142.2');
    expect(result.reason).toBeNull();
  });

  it('reports unavailable/no_output on exit-0 with EMPTY stdout (the exit-code trap)', async () => {
    const result = await checkCodexFallbackHealth({
      binary: '/tmp/codex',
      execFile: async () => ({ stdout: '', stderr: '' }),
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('no_output');
    expect(result.version).toBeNull();
    expect(result.detail).toMatch(/silent exit-0/);
  });

  it('reports unavailable/no_output on exit-0 with non-version-shaped stdout', async () => {
    const result = await checkCodexFallbackHealth({
      binary: '/tmp/codex',
      execFile: async () => ({ stdout: 'welcome to codex\n', stderr: '' }),
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('no_output');
  });

  it('reports unavailable/not_installed on ENOENT (binary really absent)', async () => {
    const result = await checkCodexFallbackHealth({
      binary: '/missing/codex',
      execFile: async () => {
        throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('not_installed');
  });

  it('reports unavailable/timeout on SIGKILL/exit-137 (the revoked-cert kill / hang)', async () => {
    const result = await checkCodexFallbackHealth({
      binary: '/tmp/codex',
      execFile: async () => {
        throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL', status: 137 });
      },
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('timeout');
  });

  it('reports unavailable/timeout on ETIMEDOUT', async () => {
    const result = await checkCodexFallbackHealth({
      binary: '/tmp/codex',
      execFile: async () => {
        throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      },
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('timeout');
  });

  it('reports unavailable/cert_revoked on a non-zero exit that is neither ENOENT nor timeout', async () => {
    const result = await checkCodexFallbackHealth({
      binary: '/tmp/codex',
      execFile: async () => {
        throw Object.assign(new Error('exited 1'), { code: 1, status: 1 });
      },
    });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('cert_revoked');
  });
});
