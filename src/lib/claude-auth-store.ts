// SPDX-License-Identifier: MIT
import { execFileSync } from 'child_process';
import os from 'os';

export type ClaudeCredentialKind = 'claude-code-oauth' | 'anthropic-api-key';

export interface StoredClaudeCredential {
  kind: ClaudeCredentialKind;
  secret: string;
  team_id: string;
  created_at: number;
  updated_at: number;
}

export interface ClaudeCredentialStatus {
  connected: boolean;
  team_id: string;
  kind?: ClaudeCredentialKind;
  updated_at?: number;
  storage: 'os-keychain' | 'memory';
}

export interface ClaudeCredentialStore {
  readonly storage: 'os-keychain' | 'memory';
  get(teamId: string): Promise<StoredClaudeCredential | null>;
  set(teamId: string, credential: Pick<StoredClaudeCredential, 'kind' | 'secret'>): Promise<StoredClaudeCredential>;
  delete(teamId: string): Promise<void>;
  status(teamId: string): Promise<ClaudeCredentialStatus>;
}

const SERVICE = 'id-agents-claude-auth';

export function normalizeClaudeCredentialKind(value: unknown): ClaudeCredentialKind {
  return value === 'anthropic-api-key' ? 'anthropic-api-key' : 'claude-code-oauth';
}

export function validateClaudeCredentialSecret(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 8) {
    throw new Error('credential must be a non-empty string');
  }
  return value.trim();
}

function accountForTeam(teamId: string): string {
  return `team:${teamId}:claude`;
}

function serializeCredential(input: StoredClaudeCredential): string {
  return JSON.stringify(input);
}

function parseCredential(raw: string, teamId: string): StoredClaudeCredential | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredClaudeCredential>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.team_id !== teamId) return null;
    if (parsed.kind !== 'claude-code-oauth' && parsed.kind !== 'anthropic-api-key') return null;
    if (typeof parsed.secret !== 'string' || parsed.secret.length === 0) return null;
    return {
      kind: parsed.kind,
      secret: parsed.secret,
      team_id: teamId,
      created_at: typeof parsed.created_at === 'number' ? parsed.created_at : Date.now(),
      updated_at: typeof parsed.updated_at === 'number' ? parsed.updated_at : Date.now(),
    };
  } catch {
    return null;
  }
}

export class MemoryClaudeCredentialStore implements ClaudeCredentialStore {
  readonly storage = 'memory' as const;
  private readonly values = new Map<string, StoredClaudeCredential>();

  async get(teamId: string): Promise<StoredClaudeCredential | null> {
    return this.values.get(teamId) ?? null;
  }

  async set(teamId: string, credential: Pick<StoredClaudeCredential, 'kind' | 'secret'>): Promise<StoredClaudeCredential> {
    const existing = this.values.get(teamId);
    const now = Date.now();
    const stored: StoredClaudeCredential = {
      kind: credential.kind,
      secret: credential.secret,
      team_id: teamId,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    this.values.set(teamId, stored);
    return stored;
  }

  async delete(teamId: string): Promise<void> {
    this.values.delete(teamId);
  }

  async status(teamId: string): Promise<ClaudeCredentialStatus> {
    const credential = await this.get(teamId);
    return credential
      ? { connected: true, team_id: teamId, kind: credential.kind, updated_at: credential.updated_at, storage: this.storage }
      : { connected: false, team_id: teamId, storage: this.storage };
  }
}

export class OsKeychainClaudeCredentialStore implements ClaudeCredentialStore {
  readonly storage = 'os-keychain' as const;

  async get(teamId: string): Promise<StoredClaudeCredential | null> {
    const account = accountForTeam(teamId);
    if (os.platform() === 'darwin') {
      try {
        const raw = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return parseCredential(raw, teamId);
      } catch {
        return null;
      }
    }
    if (os.platform() === 'linux') {
      try {
        const raw = execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'account', account], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return parseCredential(raw, teamId);
      } catch {
        return null;
      }
    }
    throw new Error(`OS keychain storage is not supported on ${os.platform()}`);
  }

  async set(teamId: string, credential: Pick<StoredClaudeCredential, 'kind' | 'secret'>): Promise<StoredClaudeCredential> {
    const existing = await this.get(teamId);
    const now = Date.now();
    const stored: StoredClaudeCredential = {
      kind: credential.kind,
      secret: credential.secret,
      team_id: teamId,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    const account = accountForTeam(teamId);
    const value = serializeCredential(stored);

    if (os.platform() === 'darwin') {
      execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', value], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      return stored;
    }
    if (os.platform() === 'linux') {
      execFileSync('secret-tool', ['store', '--label', 'ID Agents Claude Auth', 'service', SERVICE, 'account', account], {
        input: value,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      return stored;
    }
    throw new Error(`OS keychain storage is not supported on ${os.platform()}`);
  }

  async delete(teamId: string): Promise<void> {
    const account = accountForTeam(teamId);
    if (os.platform() === 'darwin') {
      try {
        execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', account], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } catch {
        // Already absent.
      }
      return;
    }
    if (os.platform() === 'linux') {
      try {
        execFileSync('secret-tool', ['clear', 'service', SERVICE, 'account', account], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } catch {
        // Already absent.
      }
      return;
    }
    throw new Error(`OS keychain storage is not supported on ${os.platform()}`);
  }

  async status(teamId: string): Promise<ClaudeCredentialStatus> {
    const credential = await this.get(teamId);
    return credential
      ? { connected: true, team_id: teamId, kind: credential.kind, updated_at: credential.updated_at, storage: this.storage }
      : { connected: false, team_id: teamId, storage: this.storage };
  }
}

export function credentialEnv(credential: StoredClaudeCredential | null): Record<string, string> {
  if (!credential) return {};
  if (credential.kind === 'anthropic-api-key') {
    return {
      ANTHROPIC_API_KEY: credential.secret,
      ID_CLAUDE_AUTH_SOURCE: 'keychain',
    };
  }
  return {
    CLAUDE_CODE_OAUTH_TOKEN: credential.secret,
    ID_CLAUDE_AUTH_SOURCE: 'keychain',
  };
}
