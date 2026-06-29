// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  MemoryClaudeCredentialStore,
  credentialEnv,
  normalizeClaudeCredentialKind,
  validateClaudeCredentialSecret,
} from '../../src/lib/claude-auth-store.js';

describe('Claude auth credential store', () => {
  it('stores credentials by team_id and never exposes the secret in status', async () => {
    const store = new MemoryClaudeCredentialStore();
    await store.set('team-a', { kind: 'claude-code-oauth', secret: 'oauth-secret-token' });
    await store.set('team-b', { kind: 'anthropic-api-key', secret: 'sk-ant-secret-token' });

    const status = await store.status('team-a');
    expect(status).toMatchObject({
      connected: true,
      team_id: 'team-a',
      kind: 'claude-code-oauth',
      storage: 'memory',
    });
    expect(JSON.stringify(status)).not.toContain('oauth-secret-token');

    const teamB = await store.get('team-b');
    expect(teamB?.secret).toBe('sk-ant-secret-token');
    expect(await store.get('missing')).toBeNull();
  });

  it('maps stored credentials to runtime env vars', () => {
    expect(credentialEnv({
      kind: 'claude-code-oauth',
      secret: 'oauth-token',
      team_id: 'team-a',
      created_at: 1,
      updated_at: 1,
    })).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      ID_CLAUDE_AUTH_SOURCE: 'keychain',
    });

    expect(credentialEnv({
      kind: 'anthropic-api-key',
      secret: 'sk-ant-token',
      team_id: 'team-a',
      created_at: 1,
      updated_at: 1,
    })).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-token',
      ID_CLAUDE_AUTH_SOURCE: 'keychain',
    });
  });

  it('normalizes and validates input', () => {
    expect(normalizeClaudeCredentialKind('anthropic-api-key')).toBe('anthropic-api-key');
    expect(normalizeClaudeCredentialKind('anything-else')).toBe('claude-code-oauth');
    expect(validateClaudeCredentialSecret('  abcdefgh  ')).toBe('abcdefgh');
    expect(() => validateClaudeCredentialSecret('short')).toThrow(/credential/);
  });
});
