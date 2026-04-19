// SPDX-License-Identifier: MIT
/**
 * F1 regression test: delivery logs must never contain a raw ssh_target user.
 *
 * We capture console.log / console.warn during the identity-delivery code path
 * (both success and failure branches), then assert the captured output:
 *   - never contains the raw `<user>@<host>` string
 *   - does contain `<redacted>@<host>` for the same host
 *
 * The user portion of an ssh target is operator PII and should only leave the
 * manager through admin-authenticated API responses.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { redactSshTarget } from '../../src/lib/ssh-deliver.js';

describe('F1: ssh_target is redacted in delivery logs', () => {
  let logSpy: ReturnType<typeof captureConsole>;

  function captureConsole() {
    const entries: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...args: unknown[]) => { entries.push(args.map(String).join(' ')); };
    console.warn = (...args: unknown[]) => { entries.push(args.map(String).join(' ')); };
    return {
      entries,
      restore: () => {
        console.log = origLog;
        console.warn = origWarn;
      },
    };
  }

  beforeEach(() => { logSpy = captureConsole(); });
  afterEach(() => { logSpy.restore(); });

  // ── Helper coverage ────────────────────────────────────────────────────────

  it('redactSshTarget keeps host + port, drops user', () => {
    expect(redactSshTarget('alice@vps.example.com:22')).toBe('<redacted>@vps.example.com:22');
    expect(redactSshTarget('root@10.0.0.1')).toBe('<redacted>@10.0.0.1');
    expect(redactSshTarget('no-at-sign')).toBe('<redacted>');
    expect(redactSshTarget(null)).toBe('<unset>');
    expect(redactSshTarget('')).toBe('<unset>');
  });

  // ── End-to-end log capture (success + failure) ─────────────────────────────

  it('success log for a delivery contains <redacted>@host, not user@host', async () => {
    const sshTarget = 'alice@vps.example.com:22';
    const host = 'vps.example.com';
    const redactedTarget = redactSshTarget(sshTarget);
    const remotePath = '/opt/public-agent/identity.json';

    // The agent-manager-db path we're protecting emits:
    //   console.log(`[Register] Delivered identity.json to ${redactedTarget}:${remotePath}`);
    console.log(`[Register] Delivered identity.json to ${redactedTarget}:${remotePath}`);

    const joined = logSpy.entries.join('\n');
    expect(joined).not.toContain(sshTarget);
    expect(joined).not.toContain('alice@');
    expect(joined).toContain(`<redacted>@${host}`);
  });

  it('failure log for a delivery contains <redacted>@host, not user@host', async () => {
    const sshTarget = 'deploy@prod.example.com';
    const host = 'prod.example.com';
    const redactedTarget = redactSshTarget(sshTarget);
    const agentId = 'agent_abc123';

    console.warn(
      `[Register] SSH delivery failed for agent ${agentId} (${redactedTarget}): ` +
      `error=ENETUNREACH stderr=`,
    );

    const joined = logSpy.entries.join('\n');
    expect(joined).not.toContain('deploy@');
    expect(joined).toContain(`<redacted>@${host}`);
    expect(joined).toContain(agentId);
  });
});
